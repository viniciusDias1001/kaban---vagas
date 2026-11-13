/**
 * Classificação: uma chamada ao modelo por mensagem de vaga, a mais antiga primeiro. O código escolhe as vagas
 * candidatas e confere a escolha do modelo; o modelo nunca liga uma mensagem a um card que o e-mail não cita.
 */
import { AiError, classifyEmail } from '@kv/ai';
import {
  countUnclassified, mailMatchPool, nextUnclassified, raiseAlert, resolveAlerts, saveClassification, threadJobs,
  type Db, type MailMessageRow,
} from '@kv/db';
import { acceptMatch, pickCandidates } from '@kv/mail';
import type { SettingsService } from '@kv/settings';
import { MailBudgetError, type MailAi } from './ai-calls';

export interface MailWorkDeps { db: Db; settings: SettingsService; ai: MailAi; now: () => number; log: (msg: string) => void }

/** Falhas seguidas do modelo numa mesma mensagem antes de ela ser gravada como `outro`. */
const MAX_FAILURES = 3;
export const UNCLASSIFIABLE_SUMMARY = 'Não foi possível classificar.';

/** Falhas seguidas por mensagem (pelo Message-ID), só neste processo: um worker reiniciado começa a contar de novo. */
const failures = new Map<string, number>();

/**
 * Classifica a mensagem mais antiga sem tipo. `budget`: o limite diário segurou (alerta `budget_waiting` aberto ou
 * atualizado). `off`: sem IA configurada. `none`: nada esperando (o alerta `budget_waiting` é resolvido). `done`: uma
 * mensagem foi tratada, classificada ou não (um erro do modelo a deixa sem tipo para a próxima rodada).
 */
export async function classifyNext(deps: MailWorkDeps): Promise<'done' | 'none' | 'budget' | 'off'> {
  const { db, ai, now } = deps;
  const oldest = await nextUnclassified(db);
  if (!oldest) {
    await resolveAlerts(db, { kind: 'budget_waiting' }, now());
    return 'none';
  }
  if (!(await ai.configured())) return 'off';

  let mail: MailMessageRow | null = oldest;
  let force = false;
  if (await ai.mayCall()) {
    // O limite não segura mais nada: o aviso de espera, se havia, deixa de valer.
    await resolveAlerts(db, { kind: 'budget_waiting' }, now());
  } else {
    // "Classificar mesmo assim": só as que o dono liberou passam do limite.
    mail = await nextUnclassified(db, { onlyForced: true });
    force = true;
  }
  if (!mail) return waitForBudget(db, now());

  try {
    await classifyOne(deps, mail, force);
  } catch (e) {
    if (e instanceof MailBudgetError) return waitForBudget(db, now());
    if (!(e instanceof AiError)) throw e;
    await countFailure(deps, mail, e);
  }
  return 'done';
}

/** Abre (ou atualiza) o alerta que conta as mensagens esperando o limite diário. */
async function waitForBudget(db: Db, now: number): Promise<'budget'> {
  await raiseAlert(db, { kind: 'budget_waiting', payload: { waiting: await countUnclassified(db) } }, now);
  return 'budget';
}

/** Candidatas do código, escolha do modelo, conferência do código; a ligação feita pelo dono vence (em `saveClassification`). */
async function classifyOne(deps: MailWorkDeps, mail: MailMessageRow, force: boolean): Promise<void> {
  const { db, ai, now } = deps;
  const raw = { from: { address: mail.fromAddress, name: mail.fromName }, subject: mail.subject, date: mail.sentAt, text: mail.body };
  const threadJob = (await threadJobs(db, [mail.threadKey])).get(mail.threadKey) ?? null;
  const candidates = pickCandidates(raw, await mailMatchPool(db), threadJob);
  const { data } = await ai.call(
    'fast',
    (provider) =>
      classifyEmail(provider, {
        mail: { fromName: mail.fromName, fromAddress: mail.fromAddress, subject: mail.subject, date: mail.sentAt, text: mail.body },
        candidates: candidates.map((c) => ({ id: c.jobId, company: c.company, title: c.title, appliedAt: c.appliedAt })),
      }),
    { force },
  );
  await saveClassification(db, mail.id, { ...data, jobId: acceptMatch(data.jobId, raw, candidates) }, now());
  failures.delete(mail.messageId);
}

/** Erro do modelo: registra; na terceira falha seguida, grava `outro` para a mensagem não travar a fila. */
async function countFailure(deps: MailWorkDeps, mail: MailMessageRow, e: AiError): Promise<void> {
  const { db, now, log } = deps;
  const n = (failures.get(mail.messageId) ?? 0) + 1;
  log(`[mail] a classificação do e-mail ${mail.id} falhou (${n}/${MAX_FAILURES}): ${e.message}`);
  if (n < MAX_FAILURES) {
    failures.set(mail.messageId, n);
    return;
  }
  failures.delete(mail.messageId);
  const threadJob = (await threadJobs(db, [mail.threadKey])).get(mail.threadKey) ?? null;
  await saveClassification(
    db, mail.id, { kind: 'outro', summary: UNCLASSIFIABLE_SUMMARY, lang: 'pt-BR', requests: [], jobId: threadJob }, now(),
  );
}

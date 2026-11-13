import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { eq, inArray, sql } from 'drizzle-orm';
import { isBlocked, resolveShot, siteFor } from '@kv/apply';
import {
  applicationById, applicationFilterCounts, applicationForJob, applications, confirmAlias, createApplication, jobAlreadyApplied, jobs,
  listApplicationEvents, listApplications, listApplyAnswers, lockApplicationWithJob, requeueQuestionWaits, requestCancel, retryApplication,
  saveApplyAnswer, sendAllRehearsals, sendRehearsal, settlePendingQuestions, toApplicationDto, type ApplicationRow, type Db, type JobRow,
} from '@kv/db';
import {
  APPLICATION_FILTERS, APPLICATION_STATUSES, APPLY_SITE_IDS, NUMBER_FORMAT_PROBLEM, PendingAnswersBodySchema, SHOT_KINDS, bankText,
  normalizeQuestionText, optionKey, parseNumberAnswer,
  type AnswerScope, type AnswerValue, type ApplicationFilter, type ApplicationListItemDto, type ApplySiteId, type CannotApplyReason,
  type JobApplicationDto, type PendingQuestion, type Question, type QuestionCategory, type ShotKind,
} from '@kv/shared';
import { z } from 'zod';
import type { AiContext } from '../ai-context';
import { applyAvailabilityNow, refuseOffLocalHost, refuseUnlessWorkerCanRun, unavailableBody } from '../apply-availability';
import { idParam } from './ids';

const jobNotFound = { error: 'not_found', message: 'vaga não encontrada' };
const appNotFound = { error: 'not_found', message: 'candidatura não encontrada' };
const ALREADY_APPLIED_MESSAGE = 'Você já se candidatou a esta vaga (o card está em Aplicada ou depois): ela não é enviada de novo.';
const ALREADY_EXISTS_MESSAGE = 'Esta vaga já tem uma candidatura.';
const alreadyApplied = { error: 'already_applied', message: ALREADY_APPLIED_MESSAGE };

/** Trava (advisory, da transação) das gravações do banco de respostas feitas por `PUT /applications/:id/answers`. */
const APPLY_ANSWERS_WRITE_LOCK = 7461003;

/** As vagas das candidaturas de `ids` incluem alguma que o dono já aplicou? */
async function anyJobAlreadyApplied(db: Db, ids: number[]): Promise<boolean> {
  const rows = await db
    .select({ column: jobs.column, appliedBy: jobs.appliedBy })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(inArray(applications.id, ids));
  return rows.some(jobAlreadyApplied);
}

const ListQuerySchema = z.object({
  filter: z.enum(APPLICATION_FILTERS).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  site: z.enum(APPLY_SITE_IDS).optional(),
});

/** As candidaturas que a tela de "Enviar todos os ensaios" listou. */
const SendAllBodySchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }).strict();

/** A resposta do dono não serve para a pergunta (400). Lançada de dentro da transação para desfazer tudo. */
class AnswerRejected extends Error {}

type PendingItem = { questionId: string; value: AnswerValue; scope: AnswerScope; confirmMatch: boolean };
/** O que gravar no banco de respostas para um item já conferido. */
type BankWrite =
  | { type: 'alias'; bankAnswerId: number; bankAnswer: string | null; label: string; alias: { normalized: string; options: string[]; value: string } }
  | { type: 'answer'; question: Question; category: QuestionCategory; text: string; scope: AnswerScope };

const isEmpty = (value: AnswerValue): boolean =>
  value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

const BOOLEAN_OPTIONS = { true: ['sim', 'yes'], false: ['nao', 'no'] } as const;

/**
 * Confere o valor contra a pergunta e o devolve no tipo dela: opção com a grafia do formulário, lista, booleano de
 * verdade, número normalizado (ponto decimal). `bankText` o transforma no texto do banco.
 * Lança `AnswerRejected` se não serve: opção fora da lista, número que não é número, texto acima do limite etc.
 */
function checkedValue(q: Question, value: AnswerValue, opts: { free?: boolean } = {}): AnswerValue {
  const bad = (why: string) => new AnswerRejected(`${q.label}: ${why}`);
  if (q.kind === 'file') throw bad('arquivos não são respondidos por aqui');
  if (isEmpty(value)) throw bad('informe a resposta');
  const optionOf = (v: string) => q.options.find((o) => optionKey(o) === optionKey(v));
  if (q.kind === 'multiselect') {
    if (!Array.isArray(value)) throw bad('escolha uma ou mais opções');
    const picked = value.map((v) => optionOf(v));
    if (picked.some((o) => o === undefined)) throw bad('uma das opções não existe na pergunta');
    return [...new Set(picked as string[])];
  }
  if (Array.isArray(value)) throw bad('esta pergunta aceita uma resposta só');
  if (typeof value === 'boolean') {
    if (q.kind !== 'boolean') throw bad('resposta de sim ou não numa pergunta que não é de sim ou não');
    if (q.options.length === 0) return value;
    const wanted = BOOLEAN_OPTIONS[String(value) as 'true' | 'false'];
    const option = q.options.find((o) => (wanted as readonly string[]).includes(optionKey(o)));
    if (!option) throw bad('nenhuma opção corresponde a sim ou não');
    return option;
  }
  if (q.kind === 'boolean' && q.options.length === 0) throw bad('responda sim ou não');
  const text = (value as string).trim();
  if (q.options.length > 0) {
    const option = optionOf(text);
    if (!option) throw bad('a resposta não é uma das opções da pergunta');
    return option;
  }
  if (opts.free) return text; // proposta aceita de uma pergunta sem opções: guardada como veio, sem conferir número nem tamanho
  if (q.kind === 'number') {
    const number = parseNumberAnswer(text);
    if (number === null) throw bad(NUMBER_FORMAT_PROBLEM);
    return number;
  }
  if (q.maxLength !== null && text.length > q.maxLength) throw bad(`a resposta passa de ${q.maxLength} caracteres`);
  return text;
}

/** Casa cada item do corpo com uma pendência e decide o que gravar (tabela do addendum). Não grava nada. */
function planAnswers(pending: PendingQuestion[], items: PendingItem[]): { writes: BankWrite[]; answered: Set<string> } {
  const answered = new Set<string>();
  const writes: BankWrite[] = [];
  for (const item of items) {
    const p = pending.find((x) => x.question.id === item.questionId);
    if (!p) throw new AnswerRejected(`a pergunta ${item.questionId} não está pendente`);
    if (answered.has(item.questionId)) throw new AnswerRejected(`a pergunta ${item.questionId} veio duas vezes`);
    const q = p.question;
    answered.add(q.id);
    if (item.confirmMatch) {
      if (p.kind === 'unanswered' || !p.proposal) throw new AnswerRejected(`${q.label}: não há proposta para aceitar`);
      const proposed = p.proposal.value;
      if (p.kind === 'confirm_match') {
        if (p.proposal.bankAnswerId === null) throw new AnswerRejected(`${q.label}: a proposta não aponta para uma resposta salva`);
        const value = bankText(checkedValue(q, proposed, { free: true }));
        writes.push({
          type: 'alias', bankAnswerId: p.proposal.bankAnswerId, bankAnswer: p.proposal.bankAnswer, label: q.label,
          alias: { normalized: normalizeQuestionText(q.label), options: [...q.options], value },
        });
      } else {
        // O texto escrito pelo modelo é só desta vaga; o fato do perfil vale sempre.
        writes.push({
          type: 'answer', question: q, category: p.category, text: bankText(checkedValue(q, proposed)),
          scope: p.proposal.source === 'written' ? 'job' : 'always',
        });
      }
    } else {
      writes.push({ type: 'answer', question: q, category: p.category, text: bankText(checkedValue(q, item.value)), scope: item.scope });
    }
  }
  return { writes, answered };
}

const bankKind = (q: Question) =>
  q.kind === 'number' ? 'number' : q.kind === 'boolean' && q.options.length === 0 ? 'boolean' : q.options.length > 0 ? 'choice' : 'text';

/** Candidaturas, ensaios, perguntas do dono, PDF e fotos. Nenhuma rota chama modelo de IA. */
export function applicationRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  const dto = async (row: ApplicationRow) => toApplicationDto(row, await listApplicationEvents(db, row.id));
  const withApplication = async (req: { params: unknown }) => {
    const id = idParam(req);
    return id === null ? null : applicationById(db, id);
  };
  const shotsOf = async (req: { params: unknown }) => {
    const id = idParam(req);
    const [row] = id === null ? [] : await db.select({ shots: applications.shots }).from(applications).where(eq(applications.id, id));
    return row?.shots ?? null;
  };

  /**
   * As checagens de "Aplicar com IA", na ordem em que a rota as faz: a primeira que falha dá o motivo (e a mensagem do
   * 409). `GET /jobs/:id/application` usa a mesma função, então o botão só aparece quando o POST aceitaria.
   */
  const applyChecks = async (job: JobRow, hasApplication: boolean) => {
    const match = siteFor(
      { id: job.id, source: job.source, url: job.url, externalId: job.externalId, company: job.company, title: job.title },
      ctx.sites,
    );
    const site: ApplySiteId | null = match?.site.id ?? null;
    const fail = (reason: CannotApplyReason, message: string) => ({ site, match, cfg: null, refusal: { reason, message } });
    if (!match) return fail('unsupported_site', 'Esta vaga não é de um site que o app sabe preencher.');
    if (jobAlreadyApplied(job)) return fail('already_applied', ALREADY_APPLIED_MESSAGE);
    const availability = await applyAvailabilityNow(db);
    if (!availability.available) return fail('apply_unavailable', unavailableBody(availability.reason).message);
    const cfg = await ctx.settings.applyConfig();
    if (!cfg.enabled) return fail('apply_disabled', 'A candidatura automática está desligada em Configurações.');
    const hit = isBlocked(job, cfg);
    if (hit) return fail('blocked', `A vaga bate com a sua lista de bloqueio ("${hit}").`);
    if (hasApplication) return fail('already_exists', ALREADY_EXISTS_MESSAGE);
    return { site, match, cfg, refusal: null };
  };
  const jobById = async (id: number | null): Promise<JobRow | null> => {
    const [job] = id === null ? [] : await db.select().from(jobs).where(eq(jobs.id, id));
    return job ?? null;
  };

  /** Lista da aba Candidaturas: as 200 mais novas do filtro pedido e a contagem verdadeira de cada filtro. */
  app.get('/applications', async (req) => {
    const query = ListQuerySchema.parse(req.query);
    const body: { items: ApplicationListItemDto[]; counts: Record<ApplicationFilter, number> } = {
      items: await listApplications(db, query),
      counts: await applicationFilterCounts(db),
    };
    return body;
  });

  /**
   * A candidatura da vaga (ou null) e se "Aplicar com IA" pode aparecer. Vaga sem candidatura é o caso comum (o painel
   * pergunta por toda vaga aberta): 200, não um 404 que o navegador registraria como erro no console. 404 só para vaga
   * que não existe.
   */
  app.get('/jobs/:id/application', async (req, reply) => {
    const job = await jobById(idParam(req));
    if (!job) return reply.code(404).send(jobNotFound);
    const row = await applicationForJob(db, job.id);
    const checks = await applyChecks(job, row !== null);
    const body: JobApplicationDto = {
      application: row ? await dto(row) : null,
      site: checks.site,
      canApply: checks.refusal === null,
      cannotApplyReason: checks.refusal?.reason ?? null,
    };
    return body;
  });

  /** "Candidatar agora": cria a candidatura manual (entra na frente da fila). O worker faz o resto. */
  app.post('/jobs/:id/application', async (req, reply) => {
    const job = await jobById(idParam(req));
    if (!job) return reply.code(404).send(jobNotFound);
    const checks = await applyChecks(job, false);
    if (checks.refusal) return reply.code(409).send({ error: checks.refusal.reason, message: checks.refusal.message });
    const site = checks.match!.site.id;
    const created = await createApplication(
      db, { jobId: job.id, site, trigger: 'manual', mode: checks.cfg!.siteModes[site] }, ctx.now(),
    );
    if (created === null) return reply.code(409).send({ error: 'already_exists', message: ALREADY_EXISTS_MESSAGE });
    return reply.code(202).send({ id: created });
  });

  app.post('/applications/:id/retry', async (req, reply) => {
    if (await refuseUnlessWorkerCanRun(db, reply)) return reply;
    const id = idParam(req);
    const outcome = id === null ? 'not_found' : await retryApplication(db, id, ctx.now());
    switch (outcome) {
      case 'queued': return reply.code(202).send({ queued: true });
      case 'not_found': return reply.code(404).send(appNotFound);
      case 'sent': return reply.code(409).send({ error: 'sent', message: 'Esta candidatura já foi enviada: nunca é enviada duas vezes.' });
      case 'in_progress': return reply.code(409).send({ error: 'in_progress', message: 'Esta candidatura está em andamento.' });
      case 'already_applied': return reply.code(409).send(alreadyApplied);
      case 'confirm_submission':
        return reply.code(409).send({
          error: 'confirm_submission',
          message: 'Não dá para saber se o site recebeu o envio. Confira no site; se já enviou, mova o card para Aplicadas, senão cancele.',
        });
      default: return reply.code(409).send({ error: 'not_retryable', message: 'Esta candidatura não está parada.' });
    }
  });

  app.post('/applications/:id/cancel', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const row = await withApplication(req);
    if (!row) return reply.code(404).send(appNotFound);
    const done = await db.transaction(async (tx) => {
      const changed = await requestCancel(tx, row.jobId, ctx.now());
      if (changed) await tx.update(jobs).set({ needsHuman: false, needsHumanReason: null }).where(eq(jobs.id, row.jobId));
      return changed;
    });
    if (!done) return reply.code(409).send({ error: 'not_cancellable', message: 'Esta candidatura já terminou.' });
    return reply.code(204).send();
  });

  const notRehearsal = { error: 'not_rehearsal', message: 'Só um ensaio pronto pode ser enviado de verdade.' };
  app.post('/applications/:id/send', async (req, reply) => {
    if (await refuseUnlessWorkerCanRun(db, reply)) return reply;
    const id = idParam(req);
    const outcome = id === null ? 'not_found' : await sendRehearsal(db, id, ctx.now());
    if (outcome === 'not_found') return reply.code(404).send(appNotFound);
    if (outcome === 'not_rehearsal') return reply.code(409).send(notRehearsal);
    if (outcome === 'already_applied') return reply.code(409).send(alreadyApplied);
    return reply.code(202).send({ queued: true });
  });
  /**
   * "Enviar todos os ensaios": envia exatamente as candidaturas que a tela listou (`ids`) e que ainda são ensaio pronto de
   * uma vaga não aplicada; diz quantas foram e quantas ficaram de fora. Nenhuma enviada e alguma das listadas é de vaga
   * que o dono já aplicou: 409 `already_applied`.
   */
  app.post('/applications/send-rehearsals', async (req, reply) => {
    const { ids } = SendAllBodySchema.parse(req.body);
    if (await refuseUnlessWorkerCanRun(db, reply)) return reply;
    const result = await sendAllRehearsals(db, ids, ctx.now());
    if (result.queued === 0 && (await anyJobAlreadyApplied(db, ids))) return reply.code(409).send(alreadyApplied);
    return reply.code(202).send(result);
  });

  /** O dono responde as perguntas paradas. Tudo numa transação, e as gravações no banco vêm ANTES da volta à fila. */
  app.put('/applications/:id/answers', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    const body = PendingAnswersBodySchema.parse(req.body);
    if (id === null) return reply.code(404).send(appNotFound);
    const now = ctx.now();
    try {
      const outcome = await db.transaction(async (tx) => {
        // A vaga e depois a candidatura: a ordem dos locks de todo lugar.
        const locked = await lockApplicationWithJob(tx, id);
        if (!locked) return 'not_found' as const;
        const { row, job } = locked;
        if (row.status !== 'needs_human' || row.reason !== 'question' || row.pendingQuestions.length === 0) return 'not_pending' as const;
        const { writes, answered } = planAnswers(row.pendingQuestions, body.answers);
        // Um PUT por vez grava no banco de respostas: dois PUTs que respondem a mesma pergunta ao mesmo tempo (em
        // candidaturas diferentes) não criam duas linhas iguais.
        await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(APPLY_ANSWERS_WRITE_LOCK))})`);
        for (const w of writes) {
          // Lido de novo a cada gravação: duas perguntas com o mesmo rótulo no mesmo PUT viram uma linha só.
          const bank = await listApplyAnswers(tx);
          if (w.type === 'alias') {
            const saved = bank.find((b) => b.id === w.bankAnswerId);
            if (!saved) throw new AnswerRejected('a resposta salva proposta foi apagada: responda de novo');
            // O dono editou a resposta salva depois da proposta: o valor proposto era da resposta antiga.
            if (saved.answer !== w.bankAnswer) throw new AnswerRejected(`${w.label}: a resposta salva mudou desde a proposta: responda de novo`);
            await confirmAlias(tx, w.bankAnswerId, w.alias, now);
            continue;
          }
          const scopeValue = w.scope === 'company' ? job.company : w.scope === 'job' ? String(row.jobId) : null;
          // Só as perguntas pessoais (salário, visto, autorização de trabalho, mudança...) dependem do país da vaga: a
          // resposta vale para vagas desse país. As demais valem em qualquer vaga.
          const country = w.category === 'personal' ? job.country : null;
          const normalized = normalizeQuestionText(w.question.label);
          // A mesma pergunta, alcance e país já salvos (por exemplo a linha vazia das perguntas comuns): atualiza, não duplica.
          const same = bank.find(
            (b) => b.normalized === normalized && b.scope === w.scope && b.scopeValue === scopeValue && b.country === country,
          );
          await saveApplyAnswer(
            tx,
            { id: same?.id, question: w.question.label, answer: w.text, kind: bankKind(w.question), scope: w.scope, scopeValue, country },
            now,
          );
        }
        const remaining = row.pendingQuestions.filter((p) => !answered.has(p.question.id));
        await settlePendingQuestions(tx, row, remaining, now);
        // Uma resposta nova pode servir às outras que esperavam pergunta: a resolução decide de novo.
        if (writes.length > 0) await requeueQuestionWaits(tx, id, now);
        return 'ok' as const;
      });
      if (outcome === 'not_found') return reply.code(404).send(appNotFound);
      if (outcome === 'not_pending') {
        return reply.code(409).send({ error: 'not_pending', message: 'Esta candidatura não está esperando respostas.' });
      }
    } catch (e) {
      if (e instanceof AnswerRejected) return reply.code(400).send({ error: 'validation', message: e.message });
      throw e;
    }
    return dto((await applicationById(db, id))!);
  });

  app.get('/applications/:id/resume.pdf', async (req, reply) => {
    const id = idParam(req);
    const [row] = id === null
      ? []
      : await db.select({ pdf: applications.resumePdf, name: applications.resumeFileName }).from(applications).where(eq(applications.id, id));
    if (!row?.pdf) return reply.code(404).send({ error: 'not_found', message: 'esta candidatura não tem currículo' });
    const name = (row.name ?? `curriculo-${id}.pdf`).replace(/[^\w.-]+/g, '_');
    // Cross-Origin-Resource-Policy: outra origem não embute o arquivo (nem descobre se ele existe).
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .header('cross-origin-resource-policy', 'same-origin')
      .send(row.pdf);
  });

  app.get('/applications/:id/shots/:kind', async (req, reply) => {
    const kind = (req.params as { kind: string }).kind as ShotKind;
    const shots = (SHOT_KINDS as readonly string[]).includes(kind) ? await shotsOf(req) : null;
    const rel = shots?.[kind];
    // Só fotos desta candidatura (`shots/<id>/`), e `resolveShot` ainda recusa caminho que sai da pasta de dados: o valor
    // gravado nunca é confiado (nada de `browser/Default/Cookies`).
    const own = rel !== undefined && rel.replaceAll('\\', '/').startsWith(`shots/${idParam(req)}/`);
    const absolute = rel && own ? resolveShot(ctx.dataDir, rel) : null;
    const bytes = absolute ? await readFile(absolute).catch(() => null) : null;
    if (!bytes) return reply.code(404).send({ error: 'not_found', message: 'foto não encontrada' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-store')
      .header('cross-origin-resource-policy', 'same-origin')
      .send(bytes);
  });
}

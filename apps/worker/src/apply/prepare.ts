import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { baseProfile, applications, companyFormsSince, jobs, profileFor, updateSiteState, type ApplicationRow, type Db } from '@kv/db';
import { gateJob, type JobForAi } from '@kv/ai';
import { decideGate, isBlocked, siteFor, type ApplySite, type ApplyTarget, type BrowserSession } from '@kv/apply';
import { MAX_DESCRIPTION_CHARS, type DescriptionFetcher } from '@kv/connectors';
import { APPLY_DEFAULTS, type ApplyConfig, type CandidateProfile, type ResumeLang } from '@kv/shared';
import type { Billing } from '../ai/billing';
import type { ApplyAi } from './ai-calls';
import { moveCardByAi } from './board';
import { DAY_MS } from './day';
import { cancelRequested, requeueTomorrow, settle, stopForOwner, BUDGET_DETAIL } from './outcome';
import { applicationResume } from './resume';

export type JobRow = typeof jobs.$inferSelect;

export interface PrepareContext {
  db: Db;
  cfg: ApplyConfig;
  sites: ApplySite[];
  browser: BrowserSession;
  dataDir: string;
  fetchDescription: DescriptionFetcher;
  ai: ApplyAi;
  signal: AbortSignal;
  now: () => number;
  log: (msg: string) => void;
}

/** Pronta para o motor: a vaga (com descrição), o site, o currículo em disco e o perfil do idioma do currículo. */
export interface Prepared {
  job: JobRow;
  site: ApplySite;
  target: ApplyTarget;
  resumePath: string;
  resumeFileName: string;
  lang: ResumeLang;
  profile: CandidateProfile;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_BILLING: Billing = {
  provider: { id: 'fake', generate: async () => { throw new Error('nenhuma chamada ao modelo era esperada aqui'); } },
  billed: async () => { throw new Error('nenhuma chamada ao modelo era esperada aqui'); },
};

export const jobForAi = (job: JobRow): JobForAi => ({
  id: job.id, title: job.title, company: job.company, location: job.location, description: job.description,
});

/** Descrição no teto de MAX_DESCRIPTION_CHARS, sem cortar um par substituto (emoji) ao meio. */
function clipDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  let end = MAX_DESCRIPTION_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

/** A descrição, buscada pelo conector (sem página logada) quando falta, e gravada na vaga. Falha: segue sem ela. */
async function withDescription(c: PrepareContext, job: JobRow): Promise<JobRow> {
  if (job.description.trim()) return job;
  try {
    const fetched = await c.fetchDescription({ source: job.source, externalId: job.externalId, url: job.url }, c.signal);
    const text = fetched ? clipDescription(fetched) : '';
    if (!text) return job;
    await c.db.update(jobs).set({ description: text, descriptionFetchedAt: c.now() }).where(eq(jobs.id, job.id));
    return { ...job, description: text };
  } catch (e) {
    c.log(`candidatura: descrição da vaga ${job.id} (${job.source}) indisponível: ${errorText(e)}`);
    return job;
  }
}

/**
 * Prepara a candidatura já em `preparing`. Devolve null quando ela parou aqui (o desfecho já foi gravado):
 * cancelada; vaga bloqueada, abaixo da nota ou inelegível (`skipped`); limite por empresa ou limite diário de IA (de volta
 * à fila para amanhã); currículo barrado ou site deslogado (`needs_human`). Uma chamada ao modelo recusada pelo limite
 * diário lança `ApplyBudgetError`; outro erro é passageiro (quem chama decide).
 */
export async function prepare(c: PrepareContext, row: ApplicationRow): Promise<Prepared | null> {
  const { db, cfg } = c;
  const cancel = async () => {
    await settle(db, row.id, { status: 'cancelled', message: 'Cancelada pelo dono.' }, c.now());
    return null;
  };
  if (await cancelRequested(db, row.id)) return cancel();

  const [found] = await db.select().from(jobs).where(eq(jobs.id, row.jobId));
  if (!found) return null; // vaga apagada: a candidatura foi junto
  const match = siteFor(
    { id: found.id, source: found.source, url: found.url, externalId: found.externalId, company: found.company, title: found.title },
    c.sites,
  );
  if (!match || match.site.id !== row.site) {
    await settle(db, row.id, { status: 'failed', detail: 'nenhum site cadastrado atende esta vaga agora' }, c.now());
    return null;
  }
  const job = await withDescription(c, found);
  const manual = row.trigger === 'manual';

  // Bloqueio (vale também para o pedido manual), limite por empresa e conferência da vaga (só automáticas).
  const blockedBy = isBlocked(job, cfg);
  let gate: { score: number; eligible: boolean; ineligibleReason: string } | null = null;
  if (!manual && blockedBy === null) {
    const since = c.now() - APPLY_DEFAULTS.companyCapDays * DAY_MS;
    let used = await companyFormsSince(db, job.company, since);
    if (row.formOpenedAt !== null && row.formOpenedAt >= since) used -= 1; // ela mesma, numa tentativa anterior
    if (used >= cfg.companyCap) {
      await requeueTomorrow(db, row.id, `limite de ${cfg.companyCap} candidaturas por empresa em ${APPLY_DEFAULTS.companyCapDays} dias atingido`, c.now(), cfg.timeZone);
      return null;
    }
    const profile = await baseProfile(db);
    if (profile) gate = (await c.ai.call('fast', (p) => gateJob(p, profile.data, jobForAi(job), { signal: c.signal }))).data;
  }
  const decision = decideGate({ blockedBy, gate, minScore: cfg.minScore, manual });
  if (!decision.pass) {
    await settle(db, row.id, { status: 'skipped', reason: decision.reason, detail: decision.detail, set: { gateScore: gate?.score ?? null } }, c.now());
    return null;
  }
  if (await cancelRequested(db, row.id)) return cancel();

  await moveCardByAi(db, job.id, 'selecionadas', c.now());
  const billing = cfg.resumeMode === 'tailored' && job.description.trim() !== '' ? await c.ai.billing() : NO_BILLING;
  const resume = await applicationResume({ db, billing, mayCall: () => c.ai.mayCall(), now: c.now }, job, cfg.resumeMode, c.signal);
  if (!resume.ok) {
    if (resume.reason === 'cancelled') return null; // a vaga foi apagada no meio
    if (resume.reason === 'budget') await requeueTomorrow(db, row.id, BUDGET_DETAIL, c.now(), cfg.timeZone);
    else await stopForOwner(db, row, 'resume_blocked', resume.detail, c.now());
    return null;
  }
  const profile = await profileFor(db, resume.lang);
  if (!profile) throw new Error('o perfil do idioma do currículo sumiu durante a preparação');
  await db
    .update(applications)
    .set({ gateScore: decision.score, resumePdf: resume.pdf, resumeFileName: resume.fileName, resumeLang: resume.lang })
    .where(eq(applications.id, row.id));
  const dir = join(c.dataDir, 'resumes', String(row.id));
  await mkdir(dir, { recursive: true });
  const resumePath = join(dir, resume.fileName);
  await writeFile(resumePath, resume.pdf);

  if (match.site.needsLogin) {
    const session = await match.site.sessionState(await c.browser.page());
    await updateSiteState(db, match.site.id, { session, sessionCheckedAt: c.now() });
    if (session === 'logged_out') {
      await stopForOwner(db, row, 'login', 'entre na sua conta no site pela tela de candidaturas', c.now());
      return null;
    }
  }
  return { job, site: match.site, target: match.target, resumePath, resumeFileName: resume.fileName, lang: resume.lang, profile: profile.data };
}

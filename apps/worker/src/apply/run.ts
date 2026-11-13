import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { dayStartMs } from '@kv/ai';
import { runApplication, type ApplySite, type BrowserSession, type EngineResult } from '@kv/apply';
import { applications, updateSiteState, type ApplicationRow, type Db } from '@kv/db';
import { getConnector, type DescriptionFetcher } from '@kv/connectors';
import type { ApplyConfig } from '@kv/shared';
import { ApplyBudgetError, createApplyAi, resolveDepsFor } from './ai-calls';
import { WorkClock, buildEngineDeps, type RunState } from './engine-deps';
import { BUDGET_DETAIL, recordResult, recordTransient, requeueTomorrow, stopForOwner } from './outcome';
import { jobForAi, prepare, type Prepared } from './prepare';
import type { ApplyQueueDeps } from './queue';

export interface RunContext {
  db: Db;
  cfg: ApplyConfig;
  sites: ApplySite[];
  browser: BrowserSession;
  dataDir: string;
  ai: ApplyQueueDeps['ai'];
  fetchDescription: DescriptionFetcher;
  now: () => number;
  log: (msg: string) => void;
  humanPollMs: number;
  humanWaitMs: number;
  workTimeoutMs: number;
  /** Depois de abortar por tempo, quanto esperar o motor descartar o formulário. */
  abortGraceMs: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<'grace'>((r) => setTimeout(() => r('grace'), ms));
const ABANDONED_DETAIL =
  'o envio foi clicado e o site não respondeu a tempo; confira no site se a candidatura chegou';

type Raced = { kind: 'done'; result: EngineResult } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Uma candidatura, do `preparing` (já reivindicado) ao desfecho gravado: prepara, grava o formulário aberto, roda o motor
 * com tempo de trabalho e grava o resultado. Não lança: um erro antes do clique é passageiro, o limite diário de IA
 * devolve a candidatura à fila para amanhã, e nada depois do clique volta à fila.
 */
export async function runOne(c: RunContext, row: ApplicationRow): Promise<void> {
  const controller = new AbortController();
  const ai = createApplyAi({ db: c.db, ai: c.ai, now: c.now, log: c.log });
  const state: RunState = { phase: 'pre' };
  let resumeDir: string | null = null;
  try {
    const ready = await prepare({ ...c, ai, signal: controller.signal }, row);
    if (!ready) return;
    resumeDir = dirname(ready.resumePath);
    await markOpened(c, row, ready.site.id);
    const result = await engine(c, row, ready, ai, state, controller);
    if (result) await recordResult(c.db, row, ready.site.id, result, c.now());
  } catch (e) {
    if (state.phase === 'click' || state.phase === 'abandoned') {
      // O clique aconteceu ou pode ter acontecido: nunca volta à fila. A linha fica em `submitting` e a recuperação
      // do próximo início a manda para o dono confirmar no site.
      c.log(`candidatura ${row.id}: erro depois do envio, ficou para conferir: ${errorText(e)}`);
    } else if (e instanceof ApplyBudgetError) {
      await requeueTomorrow(c.db, row.id, BUDGET_DETAIL, c.now(), c.cfg.timeZone).catch((err) => c.log(errorText(err)));
    } else {
      c.log(`candidatura ${row.id}: erro passageiro: ${errorText(e)}`);
      await recordTransient(c.db, row, errorText(e), c.now()).catch((err) => c.log(errorText(err)));
    }
  } finally {
    controller.abort();
    if (resumeDir) await rm(resumeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Grava a vaga vista e o formulário aberto (uma linha conta uma vez no dia, mesmo voltando à fila) e o ritmo do site. */
async function markOpened(c: RunContext, row: ApplicationRow, site: ApplySite['id']): Promise<void> {
  const at = c.now();
  const dayStart = dayStartMs(at, c.cfg.timeZone);
  const today = (value: number | null) => value !== null && value >= dayStart;
  await c.db
    .update(applications)
    .set({ viewedAt: today(row.viewedAt) ? row.viewedAt : at, formOpenedAt: today(row.formOpenedAt) ? row.formOpenedAt : at })
    .where(eq(applications.id, row.id));
  await updateSiteState(c.db, site, { lastFormAt: at, lastViewAt: at });
}

/**
 * Roda o motor com o tempo de trabalho. Antes do clique, o tempo esgotado aborta (o motor descarta e relança
 * `WorkTimeoutError`, um erro passageiro). Depois do clique, o motor tem mais um tempo inteiro; se nem assim terminar, a
 * fila grava `confirm_submission` e abandona a execução (que não clica mais: `report` passa a devolver false).
 * Devolve null quando o desfecho já foi gravado aqui.
 */
async function engine(
  c: RunContext, row: ApplicationRow, ready: Prepared, ai: ReturnType<typeof createApplyAi>, state: RunState,
  controller: AbortController,
): Promise<EngineResult | null> {
  let expired!: () => void;
  const timeout = new Promise<Raced>((resolve) => {
    expired = () => resolve({ kind: 'timeout' });
  });
  const clock = new WorkClock(c.workTimeoutMs, () => expired());
  const page = await c.browser.page();
  const approved = row.mode === 'real' ? row.approvedAnswers : [];
  const deps = buildEngineDeps({
    db: c.db, applicationId: row.id, site: ready.site, page, browser: c.browser, dataDir: c.dataDir, mode: row.mode,
    resumePath: ready.resumePath, approved, aiAnswers: c.cfg.aiAnswers,
    ctx: {
      profile: ready.profile,
      job: { id: ready.job.id, source: ready.job.source, url: ready.job.url, externalId: ready.job.externalId, company: ready.job.company, title: ready.job.title },
      sourceLabel: sourceLabel(ready.job.source), resumeFileName: ready.resumeFileName,
      company: ready.job.company, jobId: ready.job.id, country: ready.job.country === 'BR' ? 'BR' : null,
    },
    resolveDeps: resolveDepsFor(ai, { profile: ready.profile, job: jobForAi(ready.job), lang: ready.lang, signal: controller.signal, now: c.now }),
    state, clock, workTimeoutMs: c.workTimeoutMs, humanPollMs: c.humanPollMs, humanWaitMs: c.humanWaitMs, now: c.now,
  });

  const work: Promise<Raced> = runApplication(ready.target, deps).then(
    (result) => ({ kind: 'done', result }),
    (error) => ({ kind: 'error', error }),
  );
  clock.start();
  try {
    let raced = await Promise.race([work, timeout]);
    if (raced.kind === 'timeout' && state.phase === 'pre') {
      state.phase = 'aborted';
      controller.abort();
      await ready.site.discard(page).catch(() => {});
      await Promise.race([work, sleep(c.abortGraceMs)]);
      throw new Error(`o trabalho passou de ${Math.round(c.workTimeoutMs / 60_000)} min e o formulário foi descartado`);
    }
    if (raced.kind === 'timeout') {
      // Já depois do clique: mais um tempo inteiro para o site responder.
      const second = new Promise<Raced>((resolve) => {
        expired = () => resolve({ kind: 'timeout' });
      });
      clock.restart();
      raced = await Promise.race([work, second]);
      if (raced.kind === 'timeout') {
        state.phase = 'abandoned';
        await stopForOwner(c.db, row, 'confirm_submission', ABANDONED_DETAIL, c.now(), {}, { keepOnCancel: true });
        return null;
      }
    }
    if (raced.kind === 'error') throw raced.error;
    return raced.result;
  } finally {
    clock.stop();
  }
}

/** "Como soube da vaga?": o nome da fonte, como o conector se chama. */
const sourceLabel = (source: string) => getConnector(source)?.name ?? source;

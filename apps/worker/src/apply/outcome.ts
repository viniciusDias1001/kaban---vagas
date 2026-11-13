import { and, eq, isNull } from 'drizzle-orm';
import type { EngineResult } from '@kv/apply';
import {
  applications, jobs, lockApplication, markAnswersUsed, siteState, transitionApplication, updateSiteState, type ApplicationRow, type Db,
  type Transition,
} from '@kv/db';
import { APPLY_TIMING, type ApplicationStatus, type ApplySiteId, type SitePauseReason } from '@kv/shared';
import { markAppliedByOwner, moveCardByAi, needsHumanText, setNeedsHuman } from './board';
import { nextMidnight } from './day';

/** Estados gravados só antes do clique de envio. */
export const BEFORE_CLICK: readonly ApplicationStatus[] = ['preparing', 'filling', 'waiting_human'];
const IN_PROGRESS: readonly ApplicationStatus[] = [...BEFORE_CLICK, 'submitting'];
export const BUDGET_DETAIL = 'limite diário de IA atingido';
const CANCELLED_MESSAGE = 'Cancelada pelo dono.';

export async function cancelRequested(db: Db, id: number): Promise<boolean> {
  const [row] = await db.select({ flag: applications.cancelRequested }).from(applications).where(eq(applications.id, id));
  return row?.flag ?? false;
}

/**
 * Grava o fim de uma execução, sempre limpando o pedido de cancelamento e a espera ao vivo. Um cancelamento pedido
 * durante a execução vence qualquer desfecho, menos os que `keepOnCancel` protege (o clique pode ter acontecido).
 * Só grava a partir de um estado em andamento (ou de `from`). Devolve o estado gravado, ou null se nada foi gravado.
 * A leitura do pedido e a gravação são uma transação com a linha travada: um cancelamento chega antes (e vence) ou
 * depois (e encontra a linha já no desfecho), nunca no meio.
 */
export async function settle(
  db: Db, id: number, t: Transition, now: number, opts: { keepOnCancel?: boolean } = {},
): Promise<ApplicationStatus | null> {
  return db.transaction(async (tx) => {
    const row = await lockApplication(tx, id);
    if (!row) return null;
    const cancelled = !opts.keepOnCancel && row.cancelRequested;
    const final: Transition = cancelled ? { status: 'cancelled', message: CANCELLED_MESSAGE } : t;
    const ok = await transitionApplication(
      tx, id,
      { ...final, from: t.from ?? IN_PROGRESS, set: { ...final.set, cancelRequested: false, waitingGate: null } },
      now,
    );
    return ok ? final.status : null;
  });
}

/** De volta à fila para a próxima meia-noite do fuso, sem gastar tentativa. Só antes do clique de envio. */
export function requeueTomorrow(db: Db, id: number, detail: string, now: number, timeZone: string): Promise<ApplicationStatus | null> {
  return settle(db, id, { status: 'queued', detail, message: detail, from: BEFORE_CLICK, set: { runAfter: nextMidnight(now, timeZone) } }, now);
}

/** Para a candidatura no dono, com a marca "precisa de você" no card (só se ela de fato parou nele). */
export async function stopForOwner(
  db: Db, row: Pick<ApplicationRow, 'id' | 'jobId'>, reason: Parameters<typeof needsHumanText>[0], detail: string, now: number,
  set: Transition['set'] = {}, opts: { keepOnCancel?: boolean } = {},
): Promise<ApplicationStatus | null> {
  const status = await settle(db, row.id, { status: 'needs_human', reason, detail, set }, now, opts);
  if (status === 'needs_human') await setNeedsHuman(db, row.jobId, needsHumanText(reason, detail));
  return status;
}

/**
 * Erro passageiro (antes do clique): soma a tentativa e volta à fila em `APPLY_TIMING.retryMs`; esgotadas, `failed`. Se a
 * linha já está em `submitting` (o clique pode ter acontecido), nunca volta à fila: vira `confirm_submission`.
 */
export async function recordTransient(db: Db, row: ApplicationRow, error: string, now: number): Promise<ApplicationStatus | null> {
  const attempts = row.attempts + 1;
  const retry = APPLY_TIMING.retryMs[attempts - 1];
  const t: Transition = retry !== undefined
    ? { status: 'queued', detail: error, message: `Erro passageiro: ${error}`, from: BEFORE_CLICK, set: { attempts, runAfter: now + retry } }
    : { status: 'failed', detail: error, message: `Erro: ${error}`, from: BEFORE_CLICK, set: { attempts } };
  const status = await settle(db, row.id, t, now);
  if (status !== null) return status;
  const [current] = await db.select({ status: applications.status }).from(applications).where(eq(applications.id, row.id));
  if (current?.status !== 'submitting') return null;
  return stopForOwner(db, row, 'confirm_submission', `o envio pode ter sido clicado antes do erro; confira no site se a candidatura chegou (erro: ${error})`, now, {}, { keepOnCancel: true });
}

async function pause(db: Db, site: ApplySiteId, reason: SitePauseReason, now: number, patch: Parameters<typeof updateSiteState>[2] = {}) {
  await updateSiteState(db, site, { ...patch, paused: true, pauseReason: reason, pausedAt: now });
}

/** Uma espera pelo dono acabou sem ele: `ownerAwayAfter` seguidas pausam o site com `owner_away`. */
export async function recordMissedWait(db: Db, site: ApplySiteId, now: number): Promise<void> {
  const humanTimeouts = (await siteState(db, site)).humanTimeouts + 1;
  if (humanTimeouts >= APPLY_TIMING.ownerAwayAfter) await pause(db, site, 'owner_away', now, { humanTimeouts });
  else await updateSiteState(db, site, { humanTimeouts });
}

export async function recordSolvedWait(db: Db, site: ApplySiteId): Promise<void> {
  await updateSiteState(db, site, { humanTimeouts: 0 });
}

/**
 * Sequências do site: formulário desconhecido (`unsupported_form`) numa, parada depois do clique (`confirm_submission`)
 * noutra; `brakeAfter` seguidas pausam o site com `brake`. Página de restrição pausa na hora. Um envio zera as três.
 */
async function updateSiteAfter(db: Db, site: ApplySiteId, result: EngineResult, now: number): Promise<void> {
  if (result.status === 'submitted') {
    await updateSiteState(db, site, { consecutiveFailures: 0, consecutiveRejections: 0, humanTimeouts: 0 });
    return;
  }
  if (result.status !== 'needs_human') return;
  const state = await siteState(db, site);
  if (result.reason === 'restricted') await pause(db, site, 'restricted', now);
  else if (result.reason === 'login') await updateSiteState(db, site, { session: 'logged_out', sessionCheckedAt: now });
  else if (result.reason === 'unsupported_form' || result.reason === 'confirm_submission') {
    const key = result.reason === 'unsupported_form' ? 'consecutiveFailures' : 'consecutiveRejections';
    const streak = state[key] + 1;
    if (streak >= APPLY_TIMING.brakeAfter) await pause(db, site, 'brake', now, { [key]: streak });
    else await updateSiteState(db, site, { [key]: streak });
  }
}

/** O card mostra o envio: `aplicada` com `applied_by = 'ia'` de onde quer que o dono o tenha deixado antes dela. */
async function showSent(db: Db, jobId: number, now: number): Promise<void> {
  await moveCardByAi(db, jobId, 'aplicada', now);
  await db.update(jobs).set({ appliedBy: 'ia' }).where(and(eq(jobs.id, jobId), isNull(jobs.appliedBy)));
  await setNeedsHuman(db, jobId, null);
}

/**
 * Grava o resultado do motor. Um cancelamento pedido durante a execução vence tudo, menos `submitted` e `needs_human`
 * com `confirm_submission` (o clique aconteceu ou pode ter acontecido).
 */
export async function recordResult(
  db: Db, row: ApplicationRow, site: ApplySiteId, result: EngineResult, now: number,
): Promise<ApplicationStatus | null> {
  let status: ApplicationStatus | null;
  switch (result.status) {
    case 'submitted':
      status = await settle(
        db, row.id,
        { status: 'submitted', message: result.confirmation, set: { confirmation: result.confirmation, answers: result.answers, pendingQuestions: [] } },
        now, { keepOnCancel: true },
      );
      if (status === 'submitted') {
        await showSent(db, row.jobId, now);
        await markAnswersUsed(db, result.usedBankIds);
      }
      break;
    case 'dry_run_ready':
      // Ensaio pronto (ou envio de verdade cujo formulário ganhou pergunta obrigatória): o modo da linha não muda.
      status = await settle(db, row.id, { status: 'dry_run_ready', set: { answers: result.answers, pendingQuestions: [] } }, now);
      break;
    case 'needs_human':
      status = await stopForOwner(
        db, row, result.reason, result.detail, now, { answers: result.answers, pendingQuestions: result.pending },
        { keepOnCancel: result.reason === 'confirm_submission' },
      );
      break;
    case 'skipped':
      status = await settle(db, row.id, { status: 'skipped', reason: result.reason }, now);
      if (status === 'skipped' && result.reason === 'already_applied') await markAppliedByOwner(db, row.jobId, now);
      break;
    case 'cancelled':
      status = await settle(db, row.id, { status: 'cancelled', message: CANCELLED_MESSAGE }, now);
      break;
  }
  await updateSiteAfter(db, site, result, now);
  return status;
}

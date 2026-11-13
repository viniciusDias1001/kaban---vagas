import type { Page } from 'playwright';
import type {
  AnswerRecord, ApplyMode, NeedsHumanReason, PendingQuestion, Question, ResolvedAnswer, ShotKind,
} from '@kv/shared';
import { matchesApproved, type Resolution } from './answers/resolve';
import { SiteLayoutError, SubmitRejectedError } from './types';
import type { ApplySite, ApplyTarget, HumanGate } from './types';

export type EngineUpdate =
  | { status: 'filling' }
  | { status: 'waiting_human'; gate: HumanGate }
  | { status: 'submitting'; answers: AnswerRecord[] };

export interface EngineDeps {
  site: ApplySite;
  page: Page;
  mode: ApplyMode;
  resumePath: string;
  /**
   * The answers of a rehearsal that the owner saw and explicitly asked to send ("Enviar de verdade"). The worker
   * passes them on every real run of that application (a retry and a run after a pending question included): once
   * approved for sending, they stay approved for that application until it is sent. Empty for an application the
   * owner never approved that way.
   */
  approved: AnswerRecord[];
  /** Resolves the questions of one step. The caller binds `approved`, the bank and the profile. */
  resolve(questions: Question[]): Promise<Resolution>;
  /** Records the state. Returns false if the owner cancelled: the engine stops without sending. */
  report(update: EngineUpdate): Promise<boolean>;
  /** Takes the photo and returns the relative path recorded. */
  shot(kind: ShotKind): Promise<string>;
  /** Waits for the owner to solve what the page asks for, up to the time limit. */
  waitHuman(gate: HumanGate): Promise<'solved' | 'timeout'>;
}

export type EngineResult =
  | { status: 'submitted'; confirmation: string; answers: AnswerRecord[]; usedBankIds: number[] }
  | { status: 'dry_run_ready'; answers: AnswerRecord[] }
  | { status: 'needs_human'; reason: NeedsHumanReason; detail: string; answers: AnswerRecord[]; pending: PendingQuestion[] }
  | { status: 'skipped'; reason: 'closed' | 'external' | 'already_applied' }
  | { status: 'cancelled' };

/** A form with more steps than this is not a form the engine understands. */
export const MAX_FORM_STEPS = 12;
/** Solved waits per application; a gate that keeps coming back after that goes to the owner. */
export const MAX_GATE_WAITS = 5;

/** Before the click: what the page asked for. */
const GATE_DETAIL: Record<HumanGate, string> = {
  captcha: 'o site pediu uma verificação de que você não é um robô',
  verification_code: 'o site pediu um código de verificação',
  login: 'o site pediu login',
  restricted: 'o site restringiu a conta ou a candidatura; nada foi enviado',
};
/**
 * After the click every stop that is not `submitted` is `confirm_submission`: a click may have reached the site.
 * No detail here may say that nothing was sent; each ends with the instruction to check.
 */
const CHECK = 'confira no site se a candidatura chegou';
const GATE_AFTER_CLICK: Record<HumanGate, string> = {
  captcha: 'o site pediu uma verificação (captcha) depois do clique de envio',
  verification_code: 'o site pediu um código de verificação depois do clique de envio',
  login: 'o site pediu login depois do clique de envio',
  restricted: 'o site mostrou uma página de restrição depois do clique de envio',
};
const REJECTED_AFTER_CLICK_DETAIL = `o site recusou o envio automático depois do clique; ${CHECK} e, se não chegou, envie por conta própria`;
const CANCELLED_AFTER_CLICK_DETAIL = `o envio foi iniciado antes do cancelamento; ${CHECK}`;
const ERROR_EVIDENCE_MAX = 200;

/** Ends the run with a result; thrown from helpers so the sequence reads top to bottom. */
class Finish {
  constructor(readonly result: EngineResult) {}
}

const toRecord = (answer: ResolvedAnswer, question: Question): AnswerRecord => ({
  ...answer, label: question.label, help: question.help, kind: question.kind, options: [...question.options],
  required: question.required,
});

/**
 * Runs one application over the site contract, from opening the job to the confirmation.
 *
 * Ordering guarantees: `report({ status: 'submitting' })` is awaited and must return true before every `submit`
 * click; after any `report` returns false nothing is submitted; a `submit` is called again only after a gate on
 * screen was solved by the owner, never blindly after an error. On that call the site script does not click at once:
 * it waits for the first submission to land and clicks again only when nothing can still be in flight (see
 * `submitAndWait`); in doubt it throws, and that ends as `confirm_submission`. Before the first click, an error the engine does not classify
 * discards the form and is rethrown; after it, nothing is rethrown.
 */
export async function runApplication(target: ApplyTarget, deps: EngineDeps): Promise<EngineResult> {
  const { site, page } = deps;
  const answers = new Map<string, AnswerRecord>();
  const questions = new Map<string, Question>();
  const bankIds = new Set<number>();
  let solvedWaits = 0;
  let clicked = false;

  const records = () => [...answers.values()];
  const discard = async () => { try { await site.discard(page); } catch { /* closing is best effort */ } };
  /** Photos are evidence, not a step: a failed photo never stops the application. */
  const photo = async (kind: ShotKind) => { try { await deps.shot(kind); } catch { /* no photo */ } };
  const gateOnScreen = async (): Promise<HumanGate | null> => {
    try { return await site.humanGate(page); } catch { return null; }
  };
  const needsHuman = (reason: NeedsHumanReason, detail: string, pending: PendingQuestion[] = []): EngineResult =>
    ({ status: 'needs_human', reason, detail, answers: records(), pending });
  /** Before the click, every stop closes the form without sending; after it, the page stays as the site left it. */
  const finish = async (result: EngineResult): Promise<never> => {
    if (result.status === 'cancelled' || (result.status === 'needs_human' && !clicked)) await discard();
    throw new Finish(result);
  };
  const report = async (update: EngineUpdate) => {
    if (!(await deps.report(update))) await finish({ status: 'cancelled' });
  };
  /** The stored status is `filling`: reported once per run of filling (again only after a wait). */
  let filling = false;
  const markFilling = async () => {
    if (filling) return;
    await report({ status: 'filling' });
    filling = true;
  };
  /**
   * Waits for the owner to solve `gate`; returns only when solved. Before the click the wait is recorded as
   * `waiting_human` and `filling` comes back after it. After the click the stored state stays `submitting` (that is
   * what makes crash recovery confirm with the site instead of re-queueing): no other status is reported, and the
   * `submitting` report before the next click is only the cancel check. After the click every way this ends other
   * than solved is `confirm_submission`, since a click may already have reached the site.
   */
  const waitGate = async (gate: HumanGate) => {
    /** Stops on the gate: before the click with the gate as reason, after it as `confirm_submission`. */
    const stop = (suffix: string) => finish(clicked
      ? needsHuman('confirm_submission', `${GATE_AFTER_CLICK[gate]}${suffix}; ${CHECK}`)
      : needsHuman(gate, `${GATE_DETAIL[gate]}${suffix}`));
    if (gate === 'restricted') await stop('');
    if (solvedWaits >= MAX_GATE_WAITS) {
      await stop(clicked ? `, de novo depois de ${MAX_GATE_WAITS} esperas resolvidas` : ` de novo, depois de ${MAX_GATE_WAITS} esperas resolvidas`);
    }
    if (!clicked) {
      await report({ status: 'waiting_human', gate });
      filling = false;
    }
    if ((await deps.waitHuman(gate)) === 'timeout') await stop(' e o tempo de espera acabou');
    solvedWaits += 1;
    if (!clicked) await markFilling();
    else if (!(await deps.report({ status: 'submitting', answers: records() }))) {
      await finish(needsHuman('confirm_submission', CANCELLED_AFTER_CLICK_DETAIL));
    }
  };

  // Before the click: open, walk the steps, decide whether to send, record `submitting`.
  try {
    let needOpen = true;
    let readSinceOpen = false;
    let step = 1;
    for (;;) {
      try {
        if (needOpen) {
          const opened = await site.open(page, target);
          if (opened.kind === 'unavailable') return { status: 'skipped', reason: opened.reason };
          needOpen = false;
          readSinceOpen = false;
          step = 1;
          await markFilling();
        }
        const gate = await site.humanGate(page);
        if (gate) {
          await waitGate(gate);
          if (!readSinceOpen) needOpen = true;
          continue;
        }
        const read = await site.readStep(page);
        readSinceOpen = true;
        for (const question of read.questions) questions.set(question.id, question);
        const resolution = await deps.resolve(read.questions);
        for (const answer of resolution.answers) {
          const question = read.questions.find((x) => x.id === answer.questionId);
          if (question) answers.set(answer.questionId, toRecord(answer, question));
        }
        if (resolution.pending.length > 0) {
          const n = resolution.pending.length;
          await finish(needsHuman('question', n === 1 ? 'uma pergunta precisa de você' : `${n} perguntas precisam de você`,
            resolution.pending));
        }
        for (const id of resolution.usedBankIds) bankIds.add(id);
        await site.fillStep(page, resolution.answers, { resumePath: deps.resumePath });
        if (read.isLast) break;
        if (step >= MAX_FORM_STEPS) {
          await photo('blocked');
          await finish(needsHuman('unsupported_form', `o formulário passou de ${MAX_FORM_STEPS} etapas`));
        }
        await site.next(page);
        step += 1;
      } catch (err) {
        if (err instanceof Finish || !(err instanceof SiteLayoutError || err instanceof SubmitRejectedError)) throw err;
        // With a gate on screen, the gate counts, not the error.
        const gate = await gateOnScreen();
        if (gate) {
          await waitGate(gate);
          if (!readSinceOpen) needOpen = true;
          continue;
        }
        await photo('blocked');
        await finish(needsHuman('unsupported_form', err.message || 'o formulário não é o que o roteiro espera'));
      }
    }

    await photo('filled');
    if (deps.mode === 'dry_run') {
      await discard();
      return { status: 'dry_run_ready', answers: records() };
    }
    // A rehearsal was approved, but the form now asks something required the owner did not see: rehearse again.
    if (deps.approved.length > 0) {
      const unseen = [...questions.values()].some((q) => q.required && !deps.approved.some((r) => matchesApproved(r, q)));
      if (unseen) {
        await discard();
        return { status: 'dry_run_ready', answers: records() };
      }
    }
    for (let gate = await site.humanGate(page); gate; gate = await site.humanGate(page)) await waitGate(gate);
    await report({ status: 'submitting', answers: records() });
  } catch (err) {
    if (err instanceof Finish) return err.result;
    await discard();
    throw err;
  }

  // The click. From here on nothing is rethrown and nothing is sent again without a gate the owner solved.
  clicked = true;
  try {
    for (;;) {
      let confirmation: string;
      try {
        ({ confirmation } = await site.submit(page));
      } catch (err) {
        const gate = await gateOnScreen();
        if (gate) {
          await waitGate(gate);
          continue;
        }
        if (err instanceof SubmitRejectedError) return needsHuman('confirm_submission', REJECTED_AFTER_CLICK_DETAIL);
        await photo('blocked');
        return needsHuman('confirm_submission', confirmDetail(err));
      }
      await photo('confirmation');
      return { status: 'submitted', confirmation, answers: records(), usedBankIds: [...bankIds] };
    }
  } catch (err) {
    if (err instanceof Finish) return err.result;
    return needsHuman('confirm_submission', confirmDetail(err));
  }
}

/** The Portuguese sentence first; the error's first line, cut short, only as evidence after it. */
function confirmDetail(err: unknown): string {
  const line = err instanceof Error ? (err.message.split(/\r?\n/)[0] ?? '').trim().slice(0, ERROR_EVIDENCE_MAX) : '';
  return `o envio foi clicado, mas não deu para confirmar que o site recebeu; ${CHECK}${line ? ` (erro: ${line})` : ''}`;
}

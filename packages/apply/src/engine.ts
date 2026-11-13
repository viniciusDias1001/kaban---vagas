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
   * The answers of a rehearsal that the owner saw and explicitly asked to send ("Enviar de verdade").
   * Empty everywhere else: a first run, a retry, a run after the owner answered a pending question.
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

const SUBMIT_REJECTED_DETAIL = 'o site recusou o envio automático; envie por conta própria';
const GATE_DETAIL: Record<HumanGate, string> = {
  captcha: 'o site pediu uma verificação de que você não é um robô',
  verification_code: 'o site pediu um código de verificação',
  login: 'o site pediu login',
  restricted: 'o site restringiu a conta ou a candidatura; nada foi enviado',
};

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
 * screen was solved by the owner (the site scripts guarantee `submit` does not click twice when the confirmation
 * is already showing), never blindly after an error. Before the first click, an error the engine does not classify
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
  /** Waits for the owner to solve `gate`; returns only when solved, with the state recorded again. */
  const waitGate = async (gate: HumanGate) => {
    if (gate === 'restricted') await finish(needsHuman(gate, GATE_DETAIL[gate]));
    if (solvedWaits >= MAX_GATE_WAITS) {
      await finish(needsHuman(gate, `${GATE_DETAIL[gate]} de novo, depois de ${MAX_GATE_WAITS} esperas resolvidas`));
    }
    await report({ status: 'waiting_human', gate });
    if ((await deps.waitHuman(gate)) === 'timeout') {
      await finish(needsHuman(gate, `${GATE_DETAIL[gate]} e o tempo de espera acabou`));
    }
    solvedWaits += 1;
    await report(clicked ? { status: 'submitting', answers: records() } : { status: 'filling' });
  };

  // Before the click: open, walk the steps, decide whether to send, record `submitting`.
  try {
    let needOpen = true;
    let filling = false;
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
          if (!filling) {
            await report({ status: 'filling' });
            filling = true;
          }
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
        if (err instanceof SubmitRejectedError) return needsHuman('captcha', SUBMIT_REJECTED_DETAIL);
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

function confirmDetail(err: unknown): string {
  const why = err instanceof Error && err.message ? ` (${err.message})` : '';
  return `o envio foi clicado, mas não deu para confirmar que o site recebeu${why}; confira no site antes de enviar de novo`;
}

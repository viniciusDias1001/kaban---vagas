import type { Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AnswerRecord, PendingQuestion, Question, ResolvedAnswer } from '@kv/shared';
import type { Resolution } from './answers/resolve';
import type { ApplySite, ApplyTarget, HumanGate, StepRead } from './types';
import { SiteLayoutError, SubmitRejectedError } from './types';
import { MAX_FORM_STEPS, MAX_GATE_WAITS, runApplication, type EngineDeps, type EngineUpdate } from './engine';

const q = (id: string, required = true): Question => ({
  id, label: `Pergunta ${id}`, help: '', kind: 'text', options: [], required, maxLength: null,
});
const answerFor = (question: Question, bankAnswerId: number | null = null): ResolvedAnswer => ({
  questionId: question.id, value: `resposta ${question.id}`, source: bankAnswerId === null ? 'rule' : 'bank',
  category: 'identity', basis: [], bankAnswerId,
});
const recordFor = (id: string): AnswerRecord => {
  const question = q(id);
  return { ...answerFor(question), label: question.label, help: question.help, kind: question.kind, options: [], required: true };
};
const pendingQ: PendingQuestion = { question: q('q9'), category: 'unknown', kind: 'unanswered', proposal: null };

const target: ApplyTarget = { site: 'fake', url: 'http://apply.fake.test/jobs/1', ref: {} };
const page = {} as Page;

let order: string[];
beforeEach(() => { order = []; });

type SiteOverrides = Partial<Pick<ApplySite, 'open' | 'readStep' | 'fillStep' | 'next' | 'submit' | 'humanGate' | 'discard'>>;
type Options = Partial<EngineDeps> & SiteOverrides & { steps?: Question[][] };

/** Um site de mentira que registra cada chamada em `order`; por padrão, uma etapa com q1 e q2. */
function deps(opts: Options = {}): EngineDeps {
  const steps = opts.steps ?? [[q('q1'), q('q2')]];
  let at = 0;
  const log = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => { order.push(`site:${name}`); return fn(...args); };
  const site: ApplySite = {
    id: 'fake', needsLogin: false,
    match: () => null,
    sessionState: async () => 'logged_in',
    open: log('open', opts.open ?? (async () => { at = 0; return { kind: 'form' as const }; })),
    readStep: log('readStep', opts.readStep ?? (async (): Promise<StepRead> =>
      ({ questions: steps[at]!, isLast: at === steps.length - 1 }))),
    fillStep: log('fillStep', opts.fillStep ?? (async () => {})),
    next: log('next', opts.next ?? (async () => { at += 1; })),
    submit: log('submit', opts.submit ?? (async () => ({ confirmation: 'Candidatura recebida: nº 1234' }))),
    humanGate: log('humanGate', opts.humanGate ?? (async () => null)),
    discard: log('discard', opts.discard ?? (async () => {})),
  };
  const report = opts.report ?? (async () => true);
  const shot = opts.shot ?? (async (kind) => `shots/${kind}.png`);
  const waitHuman = opts.waitHuman ?? (async () => 'solved' as const);
  return {
    site, page, mode: opts.mode ?? 'real', resumePath: 'C:/tmp/cv.pdf', approved: opts.approved ?? [],
    resolve: opts.resolve ?? (async (questions): Promise<Resolution> => ({
      answers: questions.map((x) => answerFor(x, Number(x.id.slice(1)))),
      pending: [],
      usedBankIds: questions.map((x) => Number(x.id.slice(1))),
    })),
    report: async (u: EngineUpdate) => { order.push(`report:${u.status}`); return report(u); },
    shot: async (kind) => { order.push(`shot:${kind}`); return shot(kind); },
    waitHuman: async (gate) => { order.push(`wait:${gate}`); return waitHuman(gate); },
  };
}

/** `humanGate` devolve cada valor da lista uma vez, e null depois. */
const gates = (...seq: (HumanGate | null)[]) => async () => seq.shift() ?? null;
const count = (call: string) => order.filter((c) => c === call).length;

describe('runApplication', () => {
  it('reports submitting before it clicks submit', async () => {
    const res = await runApplication(target, deps({ mode: 'real' }));
    expect(res.status).toBe('submitted');
    expect(order.indexOf('report:submitting')).toBeLessThan(order.indexOf('site:submit'));
    expect(order).toEqual([
      'site:open', 'report:filling', 'site:humanGate', 'site:readStep', 'site:fillStep', 'shot:filled',
      'site:humanGate', 'report:submitting', 'site:submit', 'shot:confirmation',
    ]);
  });

  it('returns the confirmation, the answers as asked and the bank answers used', async () => {
    const res = await runApplication(target, deps({ mode: 'real' }));
    expect(res).toEqual({
      status: 'submitted', confirmation: 'Candidatura recebida: nº 1234', usedBankIds: [1, 2],
      answers: [
        { ...answerFor(q('q1'), 1), label: 'Pergunta q1', help: '', kind: 'text', options: [], required: true },
        { ...answerFor(q('q2'), 2), label: 'Pergunta q2', help: '', kind: 'text', options: [], required: true },
      ],
    });
  });

  it('sends the answers in the submitting update', async () => {
    const updates: EngineUpdate[] = [];
    await runApplication(target, deps({ report: async (u) => { updates.push(u); return true; } }));
    const submitting = updates.find((u) => u.status === 'submitting');
    expect(submitting).toMatchObject({ answers: [{ questionId: 'q1' }, { questionId: 'q2' }] });
  });

  it('never submits in rehearsal mode', async () => {
    const res = await runApplication(target, deps({ mode: 'dry_run' }));
    expect(res.status).toBe('dry_run_ready');
    expect(res).toMatchObject({ answers: [{ questionId: 'q1' }, { questionId: 'q2' }] });
    expect(order).not.toContain('site:submit');
    expect(order).not.toContain('report:submitting');
    expect(order).toContain('site:discard');
  });

  it('stops without submitting when the owner cancelled', async () => {
    const res = await runApplication(target, deps({ mode: 'real', report: async (u) => u.status !== 'submitting' }));
    expect(res).toEqual({ status: 'cancelled' });
    expect(order).not.toContain('site:submit');
    expect(order).toContain('site:discard');
  });

  it('stops without reading when the owner cancelled at filling', async () => {
    const res = await runApplication(target, deps({ report: async (u) => u.status !== 'filling' }));
    expect(res).toEqual({ status: 'cancelled' });
    expect(order).toEqual(['site:open', 'report:filling', 'site:discard']);
  });

  it('stops without waiting when the owner cancelled at waiting_human', async () => {
    const res = await runApplication(target, deps({
      humanGate: gates('captcha'), report: async (u) => u.status !== 'waiting_human',
    }));
    expect(res).toEqual({ status: 'cancelled' });
    expect(order).not.toContain('wait:captcha');
    expect(order).not.toContain('site:submit');
    expect(order).toContain('site:discard');
  });

  it('ignores a discard failure when the owner cancelled', async () => {
    const res = await runApplication(target, deps({
      report: async (u) => u.status !== 'submitting', discard: async () => { throw new Error('page closed'); },
    }));
    expect(res).toEqual({ status: 'cancelled' });
  });

  it('skips a job that is no longer open', async () => {
    const res = await runApplication(target, deps({ open: async () => ({ kind: 'unavailable', reason: 'closed' }) }));
    expect(res).toEqual({ status: 'skipped', reason: 'closed' });
    expect(order).toEqual(['site:open']);
  });

  it('discards and asks the owner when a required question has no answer', async () => {
    const res = await runApplication(target, deps({ resolve: async () => ({ answers: [], pending: [pendingQ], usedBankIds: [] }) }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'question', pending: [pendingQ] });
    expect(order).not.toContain('site:fillStep');
    expect(order).toContain('site:discard');
  });

  it('carries the answers resolved so far and every pending question of the step', async () => {
    const confirm: PendingQuestion = { ...pendingQ, question: q('q4'), kind: 'confirm_match' };
    const res = await runApplication(target, deps({
      steps: [[q('q1')], [q('q3'), q('q4'), q('q9')]],
      resolve: async (questions) => questions[0]!.id === 'q1'
        ? { answers: [answerFor(q('q1'), 1)], pending: [], usedBankIds: [1] }
        : { answers: [answerFor(q('q3'))], pending: [confirm, pendingQ], usedBankIds: [] },
    }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'question', pending: [confirm, pendingQ],
      answers: [{ questionId: 'q1' }, { questionId: 'q3' }],
    });
  });

  it('waits for the owner on a captcha and continues when solved', async () => {
    const res = await runApplication(target, deps({ humanGate: gates('captcha') }));
    expect(res.status).toBe('submitted');
    expect(order.slice(0, 6)).toEqual(['site:open', 'report:filling', 'site:humanGate', 'report:waiting_human', 'wait:captcha', 'report:filling']);
  });

  it('gives up without sending when the owner does not come', async () => {
    const res = await runApplication(target, deps({ humanGate: async () => 'captcha', waitHuman: async () => 'timeout' }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'captcha' });
    expect(order).not.toContain('site:submit');
    expect(order).toContain('site:discard');
  });

  it('does not wait on a restriction page', async () => {
    const res = await runApplication(target, deps({ humanGate: async () => 'restricted' }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'restricted' });
    expect(order.some((c) => c.startsWith('wait:'))).toBe(false);
    expect(order).not.toContain('report:waiting_human');
    expect(order).toContain('site:discard');
  });

  it(`stops waiting after ${MAX_GATE_WAITS} solved waits`, async () => {
    const res = await runApplication(target, deps({ humanGate: async () => 'verification_code' }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'verification_code' });
    expect(count('wait:verification_code')).toBe(MAX_GATE_WAITS);
    expect(order).not.toContain('site:submit');
    expect(order).toContain('site:discard');
  });

  it('reports filling once when a gate is solved before anything was read', async () => {
    let opens = 0;
    const res = await runApplication(target, deps({
      open: async () => {
        if (++opens === 1) throw new SiteLayoutError('página de login');
        return { kind: 'form' };
      },
      humanGate: async () => (opens === 1 ? 'login' : null),
    }));
    expect(res.status).toBe('submitted');
    expect(count('site:open')).toBe(2);
    expect(order.filter((c) => c.startsWith('report:'))).toEqual(['report:waiting_human', 'report:filling', 'report:submitting']);
  });

  it('discards and rethrows when the gate check right before submitting fails', async () => {
    const boom = new Error('Target page, context or browser has been closed');
    await expect(runApplication(target, deps({
      humanGate: async () => { if (order.includes('site:fillStep')) throw boom; return null; },
    }))).rejects.toBe(boom);
    expect(order).toContain('site:discard');
    expect(order).not.toContain('report:submitting');
    expect(order).not.toContain('site:submit');
  });

  it('walks a multi-step form and photographs the last step', async () => {
    const res = await runApplication(target, deps({ steps: [[q('q1'), q('q2')], [q('q3'), q('q2')]] }));
    expect(res.status).toBe('submitted');
    expect(count('site:next')).toBe(1);
    expect(count('shot:filled')).toBe(1);
    expect(order.indexOf('shot:filled')).toBeGreaterThan(order.lastIndexOf('site:fillStep'));
    expect(res).toMatchObject({ answers: [{ questionId: 'q1' }, { questionId: 'q2' }, { questionId: 'q3' }], usedBankIds: [1, 2, 3] });
  });

  it('makes a new rehearsal when the form gained a required question', async () => {
    const res = await runApplication(target, deps({ mode: 'real', approved: [recordFor('q1')] /* o formulário tem q1 e q2 obrigatórias */ }));
    expect(res.status).toBe('dry_run_ready');
    expect(order).not.toContain('site:submit');
    expect(order).toContain('site:discard');
  });

  it('sends when every required question was in the approved rehearsal', async () => {
    const res = await runApplication(target, deps({
      mode: 'real', approved: [recordFor('q1')], steps: [[q('q1'), q('q2', false)]],
    }));
    expect(res.status).toBe('submitted');
  });

  it('turns an unknown layout into unsupported_form with a photo', async () => {
    const res = await runApplication(target, deps({ readStep: async () => { throw new SiteLayoutError('formulário estranho'); } }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'unsupported_form', detail: 'formulário estranho' });
    expect(order.slice(-4)).toEqual(['site:readStep', 'site:humanGate', 'shot:blocked', 'site:discard']);
  });

  it('keeps going when a photo fails', async () => {
    const res = await runApplication(target, deps({ shot: async () => { throw new Error('disk full'); } }));
    expect(res).toMatchObject({ status: 'submitted', confirmation: 'Candidatura recebida: nº 1234' });
  });

  it('is submitted even when the confirmation photo fails', async () => {
    const res = await runApplication(target, deps({
      shot: async (kind) => { if (kind === 'confirmation') throw new Error('disk full'); return 'x.png'; },
    }));
    expect(res.status).toBe('submitted');
  });

  it('discards and rethrows an error the engine does not know before the click', async () => {
    const boom = new Error('net::ERR_CONNECTION_RESET');
    await expect(runApplication(target, deps({ readStep: async () => { throw boom; } }))).rejects.toBe(boom);
    expect(order).toContain('site:discard');
    expect(order).not.toContain('site:submit');
  });

  it('turns a silent refusal after the click into confirm_submission', async () => {
    const res = await runApplication(target, deps({ submit: async () => { throw new SubmitRejectedError('recusado'); } }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission',
      detail: 'o site recusou o envio automático depois do clique; confira no site se a candidatura chegou e, se não chegou, envie por conta própria',
    });
    expect(count('site:submit')).toBe(1);
    expect(order).not.toContain('site:discard');
  });

  it('turns a restriction page after the click into confirm_submission, without waiting', async () => {
    let clicked = false;
    const res = await runApplication(target, deps({
      submit: async () => { clicked = true; throw new SiteLayoutError('restrição'); },
      humanGate: async () => (clicked ? 'restricted' : null),
    }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission',
      detail: 'o site mostrou uma página de restrição depois do clique de envio; confira no site se a candidatura chegou',
    });
    expect(count('site:submit')).toBe(1);
    expect(order.some((c) => c.startsWith('wait:'))).toBe(false);
    expect(order).not.toContain('site:discard');
  });

  it('keeps only the first line of the error, cut at 200 characters, after the Portuguese sentence', async () => {
    const long = `page.click: Timeout ${'x'.repeat(300)}\nCall log:\n  - waiting for locator`;
    const res = await runApplication(target, deps({ submit: async () => { throw new Error(long); } }));
    expect(res.status).toBe('needs_human');
    const detail = res.status === 'needs_human' ? res.detail : '';
    expect(detail.startsWith('o envio foi clicado, mas não deu para confirmar que o site recebeu; confira no site se a candidatura chegou')).toBe(true);
    expect(detail).toContain(long.split('\n')[0]!.slice(0, 200));
    expect(detail).not.toContain(long.split('\n')[0]!.slice(0, 201));
    expect(detail).not.toContain('Call log');
  });

  it(`gives up after ${MAX_FORM_STEPS} steps`, async () => {
    const res = await runApplication(target, deps({ readStep: async () => ({ questions: [q('q1')], isLast: false }) }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'unsupported_form' });
    expect(count('site:readStep')).toBe(MAX_FORM_STEPS);
    expect(count('site:next')).toBe(MAX_FORM_STEPS - 1);
    expect(order).not.toContain('site:submit');
  });

  it('opens the job again after a gate solved right after open', async () => {
    const res = await runApplication(target, deps({ humanGate: gates('login') }));
    expect(res.status).toBe('submitted');
    expect(order.filter((c) => c === 'site:open')).toHaveLength(2);
    expect(order.indexOf('wait:login')).toBeLessThan(order.lastIndexOf('site:open'));
    expect(order.lastIndexOf('site:open')).toBeLessThan(order.indexOf('site:readStep'));
  });

  it('reads the step again, without reopening, after a gate solved between steps', async () => {
    let calls = 0;
    const res = await runApplication(target, deps({
      steps: [[q('q1')], [q('q2')]],
      humanGate: async () => (++calls === 2 ? 'captcha' : null),
    }));
    expect(res.status).toBe('submitted');
    expect(count('site:open')).toBe(1);
    expect(count('site:readStep')).toBe(2);
  });

  it('asks the owner to confirm when submit fails after the click', async () => {
    const res = await runApplication(target, deps({ mode: 'real', submit: async () => { throw new SiteLayoutError('confira no site'); } }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'confirm_submission' });
    expect(res.status === 'needs_human' && res.detail).not.toMatch(/nada foi enviado/);
    expect(order.filter((c) => c === 'site:submit')).toHaveLength(1);
    expect(order).not.toContain('site:discard');
  });

  it('never rethrows after the click', async () => {
    const res = await runApplication(target, deps({
      submit: async () => { throw new Error('Target page, context or browser has been closed'); },
      humanGate: async () => { if (order.includes('site:submit')) throw new Error('closed'); return null; },
    }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'confirm_submission' });
    expect(count('site:submit')).toBe(1);
  });

  it('submits again after a captcha that showed up on submit', async () => {
    let rejected = false;
    const res = await runApplication(target, deps({
      submit: async () => {
        if (!rejected) { rejected = true; throw new SubmitRejectedError('captcha'); }
        return { confirmation: 'Candidatura recebida: nº 1234' };
      },
      humanGate: async () => (rejected && !order.includes('wait:captcha') ? 'captcha' : null),
    }));
    expect(res.status).toBe('submitted');
    expect(order.filter((c) => c === 'site:submit')).toHaveLength(2);
    // Antes do segundo clique, o estado volta a `submitting`.
    const second = order.lastIndexOf('site:submit');
    expect(order.slice(order.indexOf('site:submit') + 1, second)).toEqual([
      'site:humanGate', 'wait:captcha', 'report:submitting',
    ]);
    // Depois do primeiro `submitting` aceito, o estado gravado nunca sai de `submitting`.
    const after = order.slice(order.indexOf('report:submitting'));
    expect(after.filter((c) => c.startsWith('report:') && c !== 'report:submitting')).toEqual([]);
  });

  it('still reports waiting_human for a gate before the click', async () => {
    let calls = 0;
    const res = await runApplication(target, deps({ humanGate: async () => (++calls === 2 ? 'captcha' : null) }));
    expect(res.status).toBe('submitted');
    expect(order.indexOf('report:waiting_human')).toBeGreaterThan(-1);
    expect(order.indexOf('report:waiting_human')).toBeLessThan(order.indexOf('report:submitting'));
  });

  it('asks the owner to confirm when the owner cancels during a wait after the click', async () => {
    let rejected = false;
    let submittingReports = 0;
    const res = await runApplication(target, deps({
      submit: async () => { rejected = true; throw new SubmitRejectedError('captcha'); },
      humanGate: async () => (rejected ? 'captcha' : null),
      report: async (u) => u.status !== 'submitting' || ++submittingReports === 1,
    }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission',
      detail: 'o envio foi iniciado antes do cancelamento; confira no site se a candidatura chegou',
      answers: [{ questionId: 'q1' }, { questionId: 'q2' }], pending: [],
    });
    expect(count('site:submit')).toBe(1);
    expect(order).toContain('wait:captcha');
    expect(order).not.toContain('report:waiting_human');
    expect(order).not.toContain('site:discard');
  });

  it(`gives the gate back to the owner after ${MAX_GATE_WAITS} solved waits after the click`, async () => {
    let rejected = false;
    const res = await runApplication(target, deps({
      submit: async () => { rejected = true; throw new SubmitRejectedError('captcha'); },
      humanGate: async () => (rejected ? 'captcha' : null),
    }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission',
      detail: `o site pediu uma verificação (captcha) depois do clique de envio, de novo depois de ${MAX_GATE_WAITS} esperas resolvidas; confira no site se a candidatura chegou`,
    });
    expect(count('wait:captcha')).toBe(MAX_GATE_WAITS);
    expect(count('site:submit')).toBe(MAX_GATE_WAITS + 1);
    expect(order).not.toContain('report:waiting_human');
    expect(order).not.toContain('site:discard');
  });

  it('asks the owner to confirm when nobody solves a gate after the click', async () => {
    let rejected = false;
    const res = await runApplication(target, deps({
      submit: async () => { rejected = true; throw new SubmitRejectedError('captcha'); },
      humanGate: async () => (rejected ? 'captcha' : null),
      waitHuman: async () => 'timeout',
    }));
    expect(res).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission',
      detail: 'o site pediu uma verificação (captcha) depois do clique de envio e o tempo de espera acabou; confira no site se a candidatura chegou',
    });
    expect(count('site:submit')).toBe(1);
    expect(order).not.toContain('report:waiting_human');
    expect(order).not.toContain('site:discard');
  });

  it('prefers the gate to the layout error', async () => {
    const res = await runApplication(target, deps({
      readStep: async () => { throw new SiteLayoutError('sobreposição'); },
      humanGate: async () => (order.includes('site:readStep') ? 'restricted' : null),
    }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'restricted' });
    expect(order).not.toContain('shot:blocked');
  });
});

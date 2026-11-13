import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import type { HumanGate } from '../types';
import { forgetSubmitClick, submitAndWait, submitClicked, type SubmitWait } from './shared';

interface Script {
  /** Estados sucessivos de `confirmationText`, `formOnScreen`, `fieldErrorVisible` e `gate`; o último se repete. */
  confirmation?: Array<string | null>;
  form?: boolean[];
  error?: boolean[];
  gate?: Array<HumanGate | null>;
  inFlight?: boolean[];
  refused?: boolean[];
  submitMs?: number;
}

const next = <T>(list: T[] | undefined, fallback: T): (() => Promise<T>) => {
  let i = 0;
  return async () => (list ? list[Math.min(i++, list.length - 1)] : fallback);
};

/** Troca o roteiro das leituras (para a chamada seguinte de `submitAndWait` na mesma página). */
function rescript(options: SubmitWait, script: Script): void {
  options.formOnScreen = next(script.form, true);
  options.confirmationText = next(script.confirmation, null);
  options.fieldErrorVisible = next(script.error, false);
  options.gate = next(script.gate, null);
  options.inFlight = next(script.inFlight, false);
  if (script.submitMs !== undefined) options.submitMs = script.submitMs;
}

function setup(script: Script): { options: SubmitWait; clicks: () => number; times: number[]; page: Page } {
  let clicks = 0;
  const times: number[] = [];
  const button = { first: () => ({ click: async () => { clicks++; times.push(Date.now()); } }) } as unknown as Locator;
  return {
    clicks: () => clicks,
    times,
    page: {} as Page,
    options: {
      site: 'X',
      submitButton: button,
      formOnScreen: next(script.form, true),
      confirmationText: next(script.confirmation, null),
      fieldErrorVisible: next(script.error, false),
      gate: next(script.gate, null),
      inFlight: next(script.inFlight, false),
      ...(script.refused ? { refused: next(script.refused, false) } : {}),
      stepMs: 100,
      submitMs: script.submitMs ?? 400,
    },
  };
}

describe('submitAndWait', () => {
  it('returns a confirmation already on screen, with the form gone, without clicking', async () => {
    const { options, clicks, page } = setup({ confirmation: ['Enviado!'], form: [false] });
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Enviado!' });
    expect(clicks()).toBe(0);
  });

  it('is a layout error, without clicking, when the form is gone and nothing confirms', async () => {
    const { options, clicks, page } = setup({ form: [false] });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(0);
  });

  it('clicks once and succeeds when the form leaves and a confirmation shows', async () => {
    // antes do clique: formulário na tela, sem confirmação; no ciclo seguinte: formulário fora e confirmação.
    const { options, clicks, page } = setup({ confirmation: [null, null, 'Obrigado'], form: [true, true, false] });
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Obrigado' });
    expect(clicks()).toBe(1);
  });

  it('does not count a confirmation while the form is still on screen', async () => {
    const { options, clicks, page } = setup({ confirmation: ['Obrigado'], form: [true], submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(clicks()).toBe(1);
  });

  it('throws SubmitRejectedError at once when a gate appears after the click', async () => {
    const { options, clicks, page } = setup({ gate: [null, 'captcha'], submitMs: 10_000 });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks()).toBe(1);
  });

  it('throws SiteLayoutError at once when a field error shows with the form on screen', async () => {
    const { options, page } = setup({ error: [false, true], submitMs: 10_000 });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('after the deadline with the form on screen and no error: SubmitRejectedError', async () => {
    const { options, clicks, page } = setup({ submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(clicks()).toBe(1);
  });

  it('after the deadline with the form gone and no confirmation: SiteLayoutError', async () => {
    const { options, clicks, page } = setup({ form: [true, false], submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(1);
  });

  it('keeps waiting through a transient error from a callback', async () => {
    const { options, page } = setup({ confirmation: [null, null], form: [true, true], submitMs: 300 });
    let calls = 0;
    const real = options.gate;
    options.gate = async () => { if (calls++ === 0) throw new Error('Execution context was destroyed'); return real(); };
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(calls).toBeGreaterThan(1);
  });

  it('throws SubmitRejectedError at once when the site refuses with the form on screen', async () => {
    const { options, clicks, page } = setup({ refused: [false, true], submitMs: 10_000 });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks()).toBe(1);
  });
});

describe('submitAndWait after an earlier click on the same page (C-1)', () => {
  /** Primeiro clique: um portão aparece logo depois (o motor espera o dono e chama de novo). */
  async function firstClickHitsGate(submitMs = 400) {
    const s = setup({ gate: [null, 'captcha'], submitMs: 10_000 });
    await expect(submitAndWait(s.page, s.options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(s.clicks()).toBe(1);
    expect(submitClicked(s.page)).toBe(true);
    s.options.submitMs = submitMs;
    return s;
  }

  it('does not click at once: a confirmation that arrives while it waits wins, with one click in all', async () => {
    const { options, clicks, page } = await firstClickHitsGate();
    rescript(options, { confirmation: [null, null, null, 'Obrigado'], form: [true, true, true, false] });
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Obrigado' });
    expect(clicks()).toBe(1);
  });

  it('clicks again only after the whole wait, with the form idle, no gate and nothing in flight', async () => {
    const { options, clicks, times, page } = await firstClickHitsGate(400);
    rescript(options, { inFlight: [false] });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(clicks()).toBe(2);
    expect(times[1]! - started).toBeGreaterThanOrEqual(390);
  });

  it('a second click that is answered by a confirmation succeeds', async () => {
    const { options, clicks, page } = await firstClickHitsGate(300);
    // Durante a espera (uns 3 ciclos) e na leitura final: formulário parado; depois do segundo clique, a confirmação.
    let clicked = false;
    rescript(options, {});
    const button = options.submitButton;
    options.submitButton = { first: () => ({ click: async () => { clicked = true; await (button.first() as unknown as { click(): Promise<void> }).click(); } }) } as unknown as Locator;
    options.confirmationText = async () => (clicked ? 'Obrigado' : null);
    options.formOnScreen = async () => !clicked;
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Obrigado' });
    expect(clicks()).toBe(2);
  });

  it('never clicks again while the first submission may be in flight: a layout error, which the engine turns into confirm_submission', async () => {
    const { options, clicks, page } = await firstClickHitsGate(300);
    rescript(options, { inFlight: [true] });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(1);
  });

  it('a gate back on screen while it waits is a rejection at once, not a click', async () => {
    const { options, clicks, page } = await firstClickHitsGate(10_000);
    rescript(options, { gate: [null, 'captcha'] });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks()).toBe(1);
  });

  it('the form gone without a confirmation after the wait is a layout error, not a click', async () => {
    const { options, clicks, page } = await firstClickHitsGate(300);
    rescript(options, { form: [false] });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(1);
  });

  it('a field error while it waits is a layout error, not a click', async () => {
    const { options, clicks, page } = await firstClickHitsGate(300);
    rescript(options, { error: [true] });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(1);
  });

  it('after forgetSubmitClick (the form was opened again) the first call clicks at once', async () => {
    const { options, clicks, page } = await firstClickHitsGate(10_000);
    forgetSubmitClick(page);
    expect(submitClicked(page)).toBe(false);
    rescript(options, { gate: [null, 'captcha'] });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks()).toBe(2);
  });
});

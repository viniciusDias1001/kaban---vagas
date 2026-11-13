import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import type { HumanGate } from '../types';
import { submitAndWait, type SubmitWait } from './shared';

interface Script {
  /** Estados sucessivos de `confirmationText`, `formOnScreen`, `fieldErrorVisible` e `gate`; o último se repete. */
  confirmation?: Array<string | null>;
  form?: boolean[];
  error?: boolean[];
  gate?: Array<HumanGate | null>;
  submitMs?: number;
}

function setup(script: Script): { options: SubmitWait; clicks: () => number } {
  let clicks = 0;
  const next = <T>(list: T[] | undefined, fallback: T): (() => Promise<T>) => {
    let i = 0;
    return async () => (list ? list[Math.min(i++, list.length - 1)] : fallback);
  };
  const button = { first: () => ({ click: async () => { clicks++; } }) } as unknown as Locator;
  return {
    clicks: () => clicks,
    options: {
      site: 'X',
      submitButton: button,
      formOnScreen: next(script.form, true),
      confirmationText: next(script.confirmation, null),
      fieldErrorVisible: next(script.error, false),
      gate: next(script.gate, null),
      stepMs: 100,
      submitMs: script.submitMs ?? 400,
    },
  };
}

const page = {} as Page;

describe('submitAndWait', () => {
  it('returns a confirmation already on screen, with the form gone, without clicking', async () => {
    const { options, clicks } = setup({ confirmation: ['Enviado!'], form: [false] });
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Enviado!' });
    expect(clicks()).toBe(0);
  });

  it('is a layout error, without clicking, when the form is gone and nothing confirms', async () => {
    const { options, clicks } = setup({ form: [false] });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(0);
  });

  it('clicks once and succeeds when the form leaves and a confirmation shows', async () => {
    // antes do clique: formulário na tela, sem confirmação; no ciclo seguinte: formulário fora e confirmação.
    const { options, clicks } = setup({ confirmation: [null, null, 'Obrigado'], form: [true, true, false] });
    expect(await submitAndWait(page, options)).toEqual({ confirmation: 'Obrigado' });
    expect(clicks()).toBe(1);
  });

  it('does not count a confirmation while the form is still on screen', async () => {
    const { options, clicks } = setup({ confirmation: ['Obrigado'], form: [true], submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(clicks()).toBe(1);
  });

  it('throws SubmitRejectedError at once when a gate appears after the click', async () => {
    const { options, clicks } = setup({ gate: [null, 'captcha'], submitMs: 10_000 });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks()).toBe(1);
  });

  it('throws SiteLayoutError at once when a field error shows with the form on screen', async () => {
    const { options } = setup({ error: [false, true], submitMs: 10_000 });
    const started = Date.now();
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('after the deadline with the form on screen and no error: SubmitRejectedError', async () => {
    const { options, clicks } = setup({ submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(clicks()).toBe(1);
  });

  it('after the deadline with the form gone and no confirmation: SiteLayoutError', async () => {
    const { options, clicks } = setup({ form: [true, false], submitMs: 300 });
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks()).toBe(1);
  });

  it('keeps waiting through a transient error from a callback', async () => {
    const { options } = setup({ confirmation: [null, null], form: [true, true], submitMs: 300 });
    let calls = 0;
    const real = options.gate;
    options.gate = async () => { if (calls++ === 0) throw new Error('Execution context was destroyed'); return real(); };
    await expect(submitAndWait(page, options)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(calls).toBeGreaterThan(1);
  });
});

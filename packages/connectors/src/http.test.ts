import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchText } from './http';

afterEach(() => vi.unstubAllGlobals());

/** Um `fetch` que só termina quando o sinal recebido é abortado, como uma requisição presa. */
function hangingFetch() {
  const calls: { url: string; signal: AbortSignal }[] = [];
  vi.stubGlobal('fetch', (url: string, init: { signal: AbortSignal }) => {
    calls.push({ url, signal: init.signal });
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  return calls;
}

describe('fetchText / fetchJson', () => {
  it('aborts the request when the caller signal is aborted', async () => {
    const calls = hangingFetch();
    const controller = new AbortController();
    const pending = fetchJson('https://example.com/feed', controller.signal);
    controller.abort(new Error('timeout do worker'));
    await expect(pending).rejects.toThrow('timeout do worker');
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(true);
  });

  it('still sends a signal (its own 30 s timeout) when the caller passes none', async () => {
    const calls: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { signal: AbortSignal }) => {
      calls.push(init.signal);
      return new Response('ok');
    });
    expect(await fetchText('https://example.com/')).toBe('ok');
    expect(calls[0]).toBeInstanceOf(AbortSignal);
    expect(calls[0].aborted).toBe(false);
  });
});

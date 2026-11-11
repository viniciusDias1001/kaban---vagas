import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGeminiProvider } from './gemini';
import { fakeHttp, type FakeReply } from './http-fake';

const schema = z.object({ score: z.number().int(), reason: z.string() });
const models = { fast: 'gemini-3.5-flash-lite', strong: 'gemini-4-carbon' };

/** Corpo de uma resposta de models/<modelo>:generateContent (escrito à mão a partir dos tipos do SDK). */
const response = (over: Record<string, unknown> = {}) => ({
  candidates: [
    { content: { role: 'model', parts: [{ text: '{"score":82,"reason":"React e TypeScript"}' }] }, finishReason: 'STOP', index: 0 },
  ],
  usageMetadata: { promptTokenCount: 640, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 665 },
  modelVersion: 'gemini-3.5-flash-lite',
  ...over,
});
const apiError = (status: number): FakeReply => ({ status, json: { error: { code: status, message: 'x', status: 'ERRO' } } });

/** O SDK do Gemini não aceita `fetch` injetado: o teste troca o `fetch` global. */
function setup(...replies: FakeReply[]) {
  const http = fakeHttp(...replies);
  vi.stubGlobal('fetch', http.fetch);
  const provider = createGeminiProvider({ apiKey: 'g-test', models });
  const call = (tier: 'fast' | 'strong' = 'fast', signal?: AbortSignal) =>
    provider.generate({ tier, system: 'INSTRUÇÕES + PERFIL', prompt: 'DADOS DA VAGA', schema, maxOutputTokens: 500, signal });
  return { ...http, call };
}

afterEach(() => vi.unstubAllGlobals());

describe('gemini adapter', () => {
  it('fast tier: generateContent with a json schema, system instruction and normalised usage', async () => {
    const { call, requests } = setup({ json: response() });
    expect(await call('fast')).toEqual({
      data: { score: 82, reason: 'React e TypeScript' },
      model: 'gemini-3.5-flash-lite',
      // saída = candidatos + raciocínio
      usage: { inputTokens: 640, outputTokens: 25 },
    });
    const { url, headers, body } = requests[0];
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(headers['x-goog-api-key']).toBe('g-test');
    expect(JSON.stringify(body.contents)).toContain('DADOS DA VAGA');
    expect(JSON.stringify(body.systemInstruction)).toContain('INSTRUÇÕES + PERFIL');
    const config = body.generationConfig as { responseMimeType: string; responseJsonSchema: Record<string, unknown>; maxOutputTokens: number };
    expect(config.responseMimeType).toBe('application/json');
    expect(config.maxOutputTokens).toBe(2_500);
    expect(config.responseJsonSchema).toMatchObject({ type: 'object', required: ['score', 'reason'] });
    expect(config.responseJsonSchema).not.toHaveProperty('$schema');
  });

  it('strong tier uses the strong model', async () => {
    const { call, requests } = setup({ json: response({ modelVersion: 'gemini-4-carbon' }) });
    expect((await call('strong')).model).toBe('gemini-4-carbon');
    expect(requests[0].url).toContain('/models/gemini-4-carbon:generateContent');
  });

  it('reports a blocked prompt, a blocked answer and a truncated answer as typed errors', async () => {
    const blockedPrompt = response({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });
    await expect(setup({ json: blockedPrompt }).call()).rejects.toMatchObject({ kind: 'refused' });
    const blockedAnswer = response({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY', index: 0 }] });
    await expect(setup({ json: blockedAnswer }).call()).rejects.toMatchObject({ kind: 'refused' });
    const cut = response({ candidates: [{ content: { role: 'model', parts: [{ text: '{"score":8' }] }, finishReason: 'MAX_TOKENS', index: 0 }] });
    await expect(setup({ json: cut }).call()).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('validates the json with the caller schema', async () => {
    const wrong = response({ candidates: [{ content: { role: 'model', parts: [{ text: '{"score":"alta"}' }] }, finishReason: 'STOP', index: 0 }] });
    await expect(setup({ json: wrong }).call()).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('maps provider errors to the typed set and does not retry inside the sdk', async () => {
    const cases: [FakeReply, string][] = [
      [apiError(429), 'rate_limited'], [apiError(401), 'config'], [apiError(403), 'config'], [apiError(404), 'config'],
      [apiError(400), 'other'], [apiError(500), 'transient'], [apiError(503), 'transient'],
      [{ networkError: 'fetch failed' }, 'transient'],
    ];
    for (const [reply, kind] of cases) {
      const { call, requests } = setup(reply);
      await expect(call(), kind).rejects.toMatchObject({ name: 'AiError', kind });
      expect(requests, `${kind}: uma única requisição`).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it('never carries the api key or the sdk error: fixed messages, no cause, even when the provider echoes the key', async () => {
    const echo: FakeReply = { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'Incorrect API key provided: g-test', code: 'invalid_api_key' } } };
    const error = await setup(echo).call().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AiError', kind: 'config', detail: 'auth' });
    const dump = inspect(error, { depth: 8, showHidden: true }) + JSON.stringify(error) + String((error as Error).stack);
    expect(dump).not.toContain('g-test');
    expect((error as Error).cause).toBeUndefined();
  });

  it('tells a missing model and an account without credit apart', async () => {
    await expect(setup(apiError(404)).call()).rejects.toMatchObject({ kind: 'config', detail: 'model' });
    await expect(setup(apiError(402)).call()).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
  });

  it('reads a 400 with reason API_KEY_INVALID as an invalid key, without passing the provider message on', async () => {
    const invalidKey: FakeReply = {
      status: 400,
      json: { error: { code: 400, message: 'API key not valid: g-test', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } },
    };
    const error = await setup(invalidKey).call().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AiError', kind: 'config', detail: 'auth' });
    expect(inspect(error, { depth: 8, showHidden: true }) + String((error as Error).stack)).not.toContain('g-test');
  });

  it('does not let the sdk continue a response by itself: one request, CONTINUATION is an incomplete answer', async () => {
    const partial = response({ candidates: [{ content: { role: 'model', parts: [{ text: '{"score":8' }] }, finishReason: 'CONTINUATION', continuationToken: 'dG9rZW4=', index: 0 }] });
    const { call, requests } = setup({ json: partial }, { json: response() });
    await expect(call()).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(requests).toHaveLength(1);
  });

  it('turns an aborted signal into a transient error', async () => {
    await expect(setup({ json: response() }).call('fast', AbortSignal.abort())).rejects.toMatchObject({ kind: 'transient' });
  });
});

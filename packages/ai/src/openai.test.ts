import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeHttp, type FakeReply } from './http-fake';
import { createOpenAiProvider } from './openai';

const schema = z.object({ score: z.number().int(), reason: z.string() });
const models = { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' };

/** Corpo de uma resposta de POST /v1/responses (escrito à mão a partir do tipo `Response` do SDK). */
const response = (over: Record<string, unknown> = {}) => ({
  id: 'resp_01', object: 'response', created_at: 1_794_400_000, status: 'completed', model: 'gpt-6-luna',
  error: null, incomplete_details: null,
  output: [
    { id: 'rs_01', type: 'reasoning', summary: [] },
    {
      id: 'msg_01', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '{"score":82,"reason":"React e TypeScript"}', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 640, output_tokens: 25, total_tokens: 665,
    input_tokens_details: { cached_tokens: 600 }, output_tokens_details: { reasoning_tokens: 10 },
  },
  ...over,
});
const apiError = (status: number): FakeReply => ({
  status, json: { error: { message: 'x', type: 'invalid_request_error', param: null, code: null } },
});

function setup(...replies: FakeReply[]) {
  const http = fakeHttp(...replies);
  const provider = createOpenAiProvider({ apiKey: 'sk-test', models, fetch: http.fetch });
  const call = (tier: 'fast' | 'strong' = 'fast', signal?: AbortSignal) =>
    provider.generate({ tier, system: 'INSTRUÇÕES + PERFIL', prompt: 'DADOS DA VAGA', schema, maxOutputTokens: 500, signal });
  return { ...http, call };
}

describe('openai adapter', () => {
  it('fast tier: Responses API with a strict json schema, low reasoning effort and normalised usage', async () => {
    const { call, requests } = setup({ json: response() });
    expect(await call('fast')).toEqual({
      data: { score: 82, reason: 'React e TypeScript' },
      model: 'gpt-6-luna',
      usage: { inputTokens: 640, outputTokens: 25 },
    });
    const { url, headers, body } = requests[0];
    expect(url).toMatch(/\/v1\/responses$/);
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body).toMatchObject({
      model: 'gpt-6-luna', instructions: 'INSTRUÇÕES + PERFIL', input: 'DADOS DA VAGA', max_output_tokens: 2_500,
      reasoning: { effort: 'low' }, store: false,
      text: { format: { type: 'json_schema', name: 'result', strict: true } },
    });
    const format = (body.text as { format: { schema: { required: string[]; additionalProperties: boolean } } }).format;
    expect(format.schema.required).toEqual(['score', 'reason']);
    expect(format.schema.additionalProperties).toBe(false);
  });

  it('strong tier: the strong model with medium effort', async () => {
    const { call, requests } = setup({ json: response({ model: 'gpt-6.1-sol' }) });
    expect((await call('strong')).model).toBe('gpt-6.1-sol');
    expect(requests[0].body).toMatchObject({ model: 'gpt-6.1-sol', max_output_tokens: 8_500, reasoning: { effort: 'medium' } });
  });

  it('does not send reasoning to a model that is not a reasoning model', async () => {
    const http = fakeHttp({ json: response({ model: 'gpt-4.1-mini' }) });
    const provider = createOpenAiProvider({ apiKey: 'k', models: { fast: 'gpt-4.1-mini', strong: 'gpt-4.1' }, fetch: http.fetch });
    await provider.generate({ tier: 'fast', system: 's', prompt: 'p', schema, maxOutputTokens: 500 });
    expect(http.requests[0].body).not.toHaveProperty('reasoning');
    expect(http.requests[0].body.max_output_tokens).toBe(500);
  });

  it('reports a refusal, a content filter and a truncated answer as typed errors', async () => {
    const refusal = response({
      output: [{ id: 'msg_01', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'não posso ajudar' }] }],
    });
    await expect(setup({ json: refusal }).call()).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('não posso ajudar') });
    const filtered = response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] });
    await expect(setup({ json: filtered }).call()).rejects.toMatchObject({ kind: 'refused' });
    const cut = response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    await expect(setup({ json: cut }).call()).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('validates the json with the caller schema', async () => {
    const wrong = response({
      output: [{ id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"score":"alta"}', annotations: [] }] }],
    });
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
    }
  });

  it('never carries the api key or the sdk error: fixed messages, no cause, even when the provider echoes the key', async () => {
    const echo: FakeReply = { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'Incorrect API key provided: sk-test', code: 'invalid_api_key' } } };
    const error = await setup(echo).call().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AiError', kind: 'config', detail: 'auth' });
    const dump = inspect(error, { depth: 8, showHidden: true }) + JSON.stringify(error) + String((error as Error).stack);
    expect(dump).not.toContain('sk-test');
    expect((error as Error).cause).toBeUndefined();
  });

  it('tells a missing model and an account without credit apart', async () => {
    await expect(setup(apiError(404)).call()).rejects.toMatchObject({ kind: 'config', detail: 'model' });
    await expect(setup(apiError(402)).call()).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
  });

  it('reads insufficient_quota (429) as an account without credit, not as a rate limit', async () => {
    const quota: FakeReply = { status: 429, json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } } };
    await expect(setup(quota).call()).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
  });

  it('reads the documented billing codes (429) as an account without credit, and slow_down as a rate limit', async () => {
    const billing = (code: string, type = 'insufficient_quota'): FakeReply => ({ status: 429, json: { error: { message: 'x', type, param: null, code } } });
    for (const code of ['credit_balance_exhausted', 'billing_not_active', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
      await expect(setup(billing(code, 'invalid_request_error')).call(), code).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
    }
    await expect(setup(billing('algum_codigo_novo')).call()).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
    await expect(setup(billing('slow_down', 'rate_limit_error')).call()).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('turns an aborted signal into a transient error', async () => {
    await expect(setup({ json: response() }).call('fast', AbortSignal.abort())).rejects.toMatchObject({ kind: 'transient' });
  });
});

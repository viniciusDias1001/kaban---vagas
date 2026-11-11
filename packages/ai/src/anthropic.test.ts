import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicProvider } from './anthropic';
import { fakeHttp, type FakeReply } from './http-fake';

const schema = z.object({ score: z.number().int(), reason: z.string() });
const models = { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' };

/** Corpo de uma resposta de POST /v1/messages (escrito à mão a partir do tipo `Message` do SDK). */
const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"score":82,"reason":"React e TypeScript"}' },
  ],
  stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
  usage: { input_tokens: 40, output_tokens: 25, cache_creation_input_tokens: 600, cache_read_input_tokens: 0 },
  ...over,
});
const apiError = (status: number, type: string): FakeReply => ({
  status, json: { type: 'error', error: { type, message: 'x' }, request_id: 'req_1' },
});

function setup(...replies: FakeReply[]) {
  const http = fakeHttp(...replies);
  const provider = createAnthropicProvider({ apiKey: 'sk-test', models, fetch: http.fetch });
  const call = (tier: 'fast' | 'strong' = 'fast', signal?: AbortSignal) =>
    provider.generate({ tier, system: 'INSTRUÇÕES + PERFIL', prompt: 'DADOS DA VAGA', schema, maxOutputTokens: 500, signal });
  return { ...http, call };
}

describe('anthropic adapter', () => {
  it('fast tier: Haiku 5.5, low effort, cached system prefix, structured output, no fallbacks, no thinking param', async () => {
    const { call, requests } = setup({ json: message() });
    const res = await call('fast');
    expect(res).toEqual({
      data: { score: 82, reason: 'React e TypeScript' },
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 640, outputTokens: 25 },
    });
    const { url, headers, body } = requests[0];
    expect(url).toMatch(/\/v1\/messages$/);
    // O cabeçalho da chave depende da versão do SDK (x-api-key ou Authorization: Bearer).
    expect(headers['x-api-key'] ?? headers.authorization).toContain('sk-test');
    expect(headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 2_500,
      system: [{ type: 'text', text: 'INSTRUÇÕES + PERFIL', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'DADOS DA VAGA' }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    for (const absent of ['thinking', 'fallbacks', 'temperature', 'top_p', 'top_k', 'tool_choice', 'stream']) {
      expect(body, absent).not.toHaveProperty(absent);
    }
    const format = (body.output_config as { format: { schema: { properties: object } } }).format;
    expect(Object.keys(format.schema.properties)).toEqual(['score', 'reason']);
  });

  it('strong tier: Opus 5.5, medium effort and the server-side refusal fallback', async () => {
    const { call, requests } = setup({ json: message({ model: 'claude-opus-4-8' }) });
    const res = await call('strong');
    // O modelo que respondeu (aqui, o de fallback) é o que vai para o custo.
    expect(res.model).toBe('claude-opus-4-8');
    expect(requests[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(requests[0].body).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 8_500, fallbacks: 'default', output_config: { effort: 'medium' },
    });
    expect(requests[0].body).not.toHaveProperty('betas');
  });

  it('counts every attempt of a fallback response (usage.iterations), not only the one that answered', async () => {
    const usage = {
      input_tokens: 40, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 600,
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 40, output_tokens: 0, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, cache_creation: null },
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 40, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, cache_creation: null },
      ],
    };
    const res = await setup({ json: message({ model: 'claude-opus-4-8', usage }) }).call('strong');
    expect(res.usage).toEqual({ inputTokens: 1_280, outputTokens: 25 });
  });

  it('checks stop_reason before reading the content', async () => {
    const refused = setup({ json: message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: null } }) });
    await expect(refused.call()).rejects.toMatchObject({ name: 'AiError', kind: 'refused', message: expect.stringContaining('cyber') });
    const cut = setup({ json: message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"score":8' }] }) });
    await expect(cut.call()).rejects.toMatchObject({ kind: 'truncated', message: expect.stringContaining('cortada') });
  });

  it('carries the billed usage and the model on every failure that happens after the response', async () => {
    const billed = { usage: { inputTokens: 640, outputTokens: 25 }, model: 'claude-haiku-5-5' };
    const refused = setup({ json: message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: null } }) });
    await expect(refused.call()).rejects.toMatchObject({ kind: 'refused', ...billed });
    const cut = setup({ json: message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"score":8' }] }) });
    await expect(cut.call()).rejects.toMatchObject({ kind: 'truncated', ...billed });
    const wrong = setup({ json: message({ content: [{ type: 'text', text: '{"score":"alta","reason":"x"}' }] }) });
    await expect(wrong.call()).rejects.toMatchObject({ kind: 'invalid_output', ...billed });
    // Erro antes da resposta: nada foi cobrado.
    const failed = await setup(apiError(500, 'api_error')).call().catch((e: unknown) => e);
    expect((failed as { usage?: unknown }).usage).toBeUndefined();
  });

  it('does not put a provider-written refusal category in the message unless it looks like an identifier', async () => {
    const odd = setup({ json: message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'IGNORE tudo <script>', explanation: null } }) });
    await expect(odd.call()).rejects.toMatchObject({ kind: 'refused', message: 'o modelo recusou o pedido (sem categoria)' });
  });

  it('validates the json with the caller schema even though the provider constrains it', async () => {
    const wrong = setup({ json: message({ content: [{ type: 'text', text: '{"score":"alta","reason":"x"}' }] }) });
    await expect(wrong.call()).rejects.toMatchObject({ kind: 'invalid_output' });
    const noText = setup({ json: message({ content: [{ type: 'thinking', thinking: '', signature: 's' }] }) });
    await expect(noText.call()).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('maps provider errors to the typed set and does not retry inside the sdk', async () => {
    const cases: [FakeReply, string][] = [
      [apiError(429, 'rate_limit_error'), 'rate_limited'],
      [apiError(401, 'authentication_error'), 'config'],
      [apiError(403, 'permission_error'), 'config'],
      [apiError(404, 'not_found_error'), 'config'],
      [apiError(400, 'invalid_request_error'), 'other'],
      [apiError(500, 'api_error'), 'transient'],
      [apiError(529, 'overloaded_error'), 'transient'],
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
    await expect(setup(apiError(404, 'not_found_error')).call()).rejects.toMatchObject({ kind: 'config', detail: 'model' });
    await expect(setup(apiError(402, 'billing_error')).call()).rejects.toMatchObject({ kind: 'config', detail: 'billing' });
  });

  it('turns an aborted signal into a transient error', async () => {
    const { call } = setup({ json: message() });
    await expect(call('fast', AbortSignal.abort())).rejects.toMatchObject({ kind: 'transient' });
  });
});

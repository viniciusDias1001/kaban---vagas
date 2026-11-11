import type { FastifyInstance } from 'fastify';
import { AiError, estimateCostUsd, testConnection } from '@kv/ai';
import { recordUsage, type Db } from '@kv/db';
import { EnvKeyError, SecretMissingError, SettingsValidationError } from '@kv/settings';
import {
  AI_PROVIDER_LABELS, AiProviderIdSchema, ApiKeyInputSchema, SettingsPatchSchema, type AiProviderId, type SettingsDto,
  type TestConnectionDto, type TestConnectionOutcome,
} from '@kv/shared';
import { notConfigured, type AiContext } from '../ai-context';

const HOUR = 3_600_000;
/** Tempo limite da chamada de teste. */
const TEST_TIMEOUT_MS = 20_000;

/** A busca horária roda na hora cheia (ver `scheduleHourly` no worker). */
const nextRunAt = (now: number) => Math.floor(now / HOUR) * HOUR + HOUR;

const providerParam = (req: { params: unknown }): AiProviderId =>
  AiProviderIdSchema.parse((req.params as { provider?: string }).provider);

function outcomeOf(e: unknown): TestConnectionOutcome {
  if (!(e instanceof AiError)) return 'other';
  if (e.kind === 'config') {
    return e.detail === 'auth' ? 'invalid_key' : e.detail === 'model' ? 'model_not_found' : e.detail === 'billing' ? 'no_credit' : 'other';
  }
  if (e.kind === 'rate_limited') return 'rate_limited';
  if (e.kind === 'transient') return 'network';
  if (e.kind === 'refused') return 'refused';
  return 'other';
}

/** Frases fixas por desfecho: nada do que o provedor respondeu (que pode ecoar a chave) chega à tela. */
const OUTCOME_MESSAGES: Record<TestConnectionOutcome, (label: string, model: string) => string> = {
  ok: (label, model) => `Conexão com ${label} funcionando (modelo ${model}).`,
  invalid_key: (label) => `${label} recusou a chave de API: ela é inválida ou não tem permissão.`,
  model_not_found: (label, model) => `${label} não encontrou o modelo "${model}". Confira o nome do modelo rápido.`,
  no_credit: (label) => `A conta de ${label} está sem crédito ou com cobrança pendente.`,
  rate_limited: (label) => `${label} respondeu que o limite de taxa foi atingido. Tente de novo em instantes.`,
  network: (label) => `Não foi possível falar com ${label} (rede ou tempo esgotado).`,
  refused: (label) => `${label} recusou o pedido de teste.`,
  other: (label) => `${label} respondeu com um erro inesperado. Confira o provedor e os modelos.`,
};

export function settingsRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  const dto = (): Promise<SettingsDto> => ctx.settings.dto(nextRunAt(ctx.now()));

  /** Tudo que a aba Configurações mostra. Das chaves, só metadados: provedor, 4 últimos caracteres, data. */
  app.get('/settings', dto);

  app.patch('/settings', async (req, reply) => {
    const patch = SettingsPatchSchema.parse(req.body);
    try {
      await ctx.settings.update(patch);
    } catch (e) {
      if (e instanceof SettingsValidationError) return reply.code(400).send({ error: 'validation', message: e.message });
      throw e;
    }
    return dto();
  });

  /** Grava (cifrada) a chave de um provedor. É só de escrita: nenhuma rota devolve a chave. */
  app.put('/settings/ai-keys/:provider', async (req, reply) => {
    const provider = providerParam(req);
    const { key } = ApiKeyInputSchema.parse(req.body);
    try {
      return await ctx.settings.saveKey(provider, key);
    } catch (e) {
      if (e instanceof EnvKeyError) return reply.code(409).send({ error: 'env_key', message: e.message });
      if (e instanceof SecretMissingError) return reply.code(409).send({ error: 'no_app_secret', message: e.message });
      throw e;
    }
  });

  app.delete('/settings/ai-keys/:provider', async (req, reply) => {
    await ctx.settings.deleteKey(providerParam(req));
    return reply.code(204).send();
  });

  /**
   * "Testar conexão": UMA chamada mínima no modelo rápido do provedor em vigor. Não aceita corpo: o
   * prompt é fixo (`testConnection`), então a rota não serve de oráculo nem de amplificador de gasto.
   * Tem limite de frequência e é registrada em `ai_usage` (camada `test`).
   */
  app.post('/settings/ai/test', async (_req, reply) => {
    const decision = ctx.testLimiter.take();
    if (!decision.ok) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      return reply
        .code(429)
        .header('retry-after', String(seconds))
        .send({ error: 'rate_limited', message: `Aguarde ${seconds} s para testar a conexão de novo.` });
    }
    // A chave decifrada vive só dentro desta requisição.
    const { config, problem } = await ctx.settings.aiConfig();
    if (!config) return reply.code(409).send(notConfigured(problem));
    const label = config.provider === 'fake' ? AI_PROVIDER_LABELS.fake : AI_PROVIDER_LABELS[config.provider];
    const started = ctx.now();
    let body: TestConnectionDto;
    try {
      const res = await testConnection(ctx.createProvider(config), { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      await recordUsage(db, {
        provider: config.provider, model: res.model, layer: 'test', inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model, res.usage, config.models.fast),
        createdAt: ctx.now(),
      });
      body = { outcome: 'ok', message: OUTCOME_MESSAGES.ok(label, res.model), provider: config.provider, model: res.model, latencyMs: ctx.now() - started };
    } catch (e) {
      // A resposta veio fora do formato, mas veio: chave e modelo funcionam.
      const outcome = e instanceof AiError && e.kind === 'invalid_output' ? 'ok' : outcomeOf(e);
      body = { outcome, message: OUTCOME_MESSAGES[outcome](label, config.models.fast), provider: config.provider, model: config.models.fast, latencyMs: null };
    }
    return body;
  });
}

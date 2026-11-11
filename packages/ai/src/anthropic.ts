import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AiError, detailFromStatus, kindFromStatus, parseJsonText, scrubSecrets, withUsage } from './errors';
import type { AiProvider, AiTier, AiUsage } from './types';

/**
 * `effort` explícito por nível (o padrão dos dois modelos é `medium`). fast: triagem em volume, onde
 * `low` basta; strong: análise e escrita, no ponto de partida recomendado para o Opus 5.5.
 */
const EFFORT = { fast: 'low', strong: 'medium' } as const;
/**
 * O raciocínio adaptativo (ligado por padrão no Haiku 5.5 e no Opus 5.5; `thinking` não é enviado)
 * conta em `max_tokens`: folga somada ao teto de saída visível. O total fica abaixo de ~16 000 tokens,
 * então a chamada não precisa de streaming.
 */
const THINKING_HEADROOM: Record<AiTier, number> = { fast: 2_000, strong: 8_000 };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * Modelos com fallback de recusa no servidor: se um classificador de segurança recusar o pedido, a API
 * o refaz no modelo recomendado, na mesma chamada. O Haiku 5.5 NÃO tem esse recurso (uma lista de
 * fallbacks devolve 400), por isso o nível fast usa a rota normal e trata a recusa como erro.
 */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1',
]);

export interface AnthropicOptions {
  apiKey: string;
  models: Record<AiTier, string>;
  /** Só nos testes: camada HTTP falsa. */
  fetch?: typeof fetch;
}

/**
 * Do mais específico para o mais geral (APIConnectionError é subclasse de APIError no SDK de TypeScript).
 * As mensagens são fixas: a do SDK repete o corpo da resposta do provedor, que pode conter a chave. O
 * erro do SDK não segue adiante (nada de `cause`).
 */
function mapError(e: unknown, apiKey: string): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new AiError('transient', 'chamada cancelada (tempo esgotado)');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('transient', 'falha de rede ao falar com a Anthropic');
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError('rate_limited', 'limite de taxa da Anthropic');
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('config', 'a chave de API da Anthropic é inválida ou não tem permissão', 'auth');
  }
  if (e instanceof Anthropic.NotFoundError) return new AiError('config', 'modelo da Anthropic não encontrado', 'model');
  if (e instanceof Anthropic.APIError) {
    const kind = kindFromStatus(e.status);
    return new AiError(kind, `Anthropic respondeu ${e.status ?? 'sem status'}`, kind === 'config' ? detailFromStatus(e.status) : undefined);
  }
  return new AiError('other', scrubSecrets(e instanceof Error ? e.message : String(e), [apiKey]));
}

/**
 * Com fallback de recusa, `usage` do topo cobre só a tentativa que produziu a resposta; a fonte por
 * tentativa é `usage.iterations` (inclusive a tentativa recusada). Somamos todas: para um limite de
 * gasto, errar para mais é o lado seguro. Sem `iterations`, vale o `usage` do topo.
 */
function totalUsage(u: Anthropic.Usage | Anthropic.Beta.BetaUsage): AiUsage {
  const iterations = 'iterations' in u ? u.iterations : null;
  const attempts = iterations && iterations.length > 0 ? iterations : [u];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const a of attempts) {
    inputTokens += a.input_tokens + (a.cache_creation_input_tokens ?? 0) + (a.cache_read_input_tokens ?? 0);
    outputTokens += a.output_tokens;
  }
  return { inputTokens, outputTokens };
}

export function createAnthropicProvider(opts: AnthropicOptions): AiProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: 0, // quem tenta de novo é a fila de IA
    timeout: 120_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    id: 'anthropic',
    async generate(req) {
      const model = opts.models[req.tier];
      const base = {
        model,
        max_tokens: req.maxOutputTokens + THINKING_HEADROOM[req.tier],
        // Prefixo estável (instruções + perfil) em cache; a vaga vem depois do ponto de corte.
        // Abaixo do mínimo do modelo (512 tokens no Haiku 5.5 e no Opus 5.5) o cache é ignorado sem erro.
        system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
        messages: [{ role: 'user' as const, content: req.prompt }],
      };
      const effort = EFFORT[req.tier];
      let res: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        res = FALLBACK_MODELS.has(model)
          ? await client.beta.messages.create(
              {
                ...base,
                betas: [FALLBACK_BETA],
                fallbacks: 'default',
                output_config: { effort, format: betaZodOutputFormat(req.schema) },
              },
              { signal: req.signal },
            )
          : await client.messages.create(
              { ...base, output_config: { effort, format: zodOutputFormat(req.schema) } },
              { signal: req.signal },
            );
      } catch (e) {
        throw mapError(e, opts.apiKey);
      }
      // A partir daqui a chamada já foi cobrada: todo erro leva o uso, para entrar na contabilidade.
      const billed = { usage: res.usage ? totalUsage(res.usage) : undefined, model: res.model || model };
      // Sempre conferir stop_reason antes de ler o conteúdo: na recusa e no corte o JSON não é confiável.
      if (res.stop_reason === 'refusal') {
        // A categoria vem do provedor: só entra na mensagem se tiver cara de identificador.
        const category = String(res.stop_details?.category ?? '');
        throw new AiError('refused', `o modelo recusou o pedido (${/^[a-z_]{1,40}$/.test(category) ? category : 'sem categoria'})`, undefined, billed);
      }
      if (res.stop_reason === 'max_tokens') throw new AiError('truncated', 'resposta cortada pelo limite de tokens', undefined, billed);
      // A resposta pode começar com blocos `thinking`: ler por tipo, nunca por posição.
      let text = '';
      for (const block of res.content) if (block.type === 'text') text += block.text;
      try {
        return { data: parseJsonText(req.schema, text), model: res.model, usage: totalUsage(res.usage) };
      } catch (e) {
        throw withUsage(e, billed);
      }
    },
  };
}

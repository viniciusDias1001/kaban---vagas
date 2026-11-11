import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AiError, detailFromStatus, kindFromStatus, parseJsonText, scrubSecrets } from './errors';
import type { AiProvider, AiTier } from './types';

const EFFORT = { fast: 'low', strong: 'medium' } as const;
/** Tokens de raciocínio contam em `max_output_tokens`. */
const REASONING_HEADROOM: Record<AiTier, number> = { fast: 2_000, strong: 8_000 };
/** Só modelos de raciocínio aceitam `reasoning.effort` (vale se AI_MODEL_* apontar para um modelo antigo). */
const isReasoningModel = (model: string) => /^(gpt-[5-9]|o\d)/.test(model);

/**
 * Códigos de cobrança documentados em https://developers.openai.com/api/docs/guides/error-codes (lidos em
 * 2026-11-11), todos com status 429. `insufficient_quota` é o código antigo, mantido por segurança.
 */
const BILLING_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'billing_not_active', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

export interface OpenAiOptions {
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
  if (e instanceof OpenAI.APIUserAbortError) return new AiError('transient', 'chamada cancelada (tempo esgotado)');
  if (e instanceof OpenAI.APIConnectionError) return new AiError('transient', 'falha de rede ao falar com a OpenAI');
  if (e instanceof OpenAI.RateLimitError) {
    // Conta sem crédito ou no teto de gasto: a OpenAI responde 429 e o motivo vem em `error.code`
    // (o `error.type` mais amplo pode ser `insufficient_quota`). Esperar não resolve: não é limite de taxa.
    if (BILLING_CODES.has(e.code ?? '') || e.type === 'insufficient_quota') {
      return new AiError('config', 'a conta da OpenAI está sem crédito ou atingiu o limite de gasto', 'billing');
    }
    return new AiError('rate_limited', 'limite de taxa da OpenAI');
  }
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return new AiError('config', 'a chave de API da OpenAI é inválida ou não tem permissão', 'auth');
  }
  if (e instanceof OpenAI.NotFoundError) return new AiError('config', 'modelo da OpenAI não encontrado', 'model');
  if (e instanceof OpenAI.APIError) {
    const kind = kindFromStatus(e.status);
    return new AiError(kind, `OpenAI respondeu ${e.status ?? 'sem status'}`, kind === 'config' ? detailFromStatus(e.status) : undefined);
  }
  return new AiError('other', scrubSecrets(e instanceof Error ? e.message : String(e), [apiKey]));
}

export function createOpenAiProvider(opts: OpenAiOptions): AiProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    maxRetries: 0, // quem tenta de novo é a fila de IA
    timeout: 120_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    id: 'openai',
    async generate(req) {
      const model = opts.models[req.tier];
      const reasoning = isReasoningModel(model);
      let res: OpenAI.Responses.Response;
      try {
        res = await client.responses.create(
          {
            model,
            // `instructions` vem antes de `input` no prompt: é o prefixo que o cache automático reaproveita.
            instructions: req.system,
            input: req.prompt,
            max_output_tokens: req.maxOutputTokens + (reasoning ? REASONING_HEADROOM[req.tier] : 0),
            ...(reasoning ? { reasoning: { effort: EFFORT[req.tier] } } : {}),
            text: { format: zodTextFormat(req.schema, 'result') },
            store: false,
          },
          { signal: req.signal },
        );
      } catch (e) {
        throw mapError(e, opts.apiKey);
      }
      if (res.status === 'incomplete') {
        const reason = res.incomplete_details?.reason;
        if (reason === 'content_filter') throw new AiError('refused', 'a OpenAI bloqueou a resposta (content_filter)');
        throw new AiError('invalid_output', `resposta incompleta (${reason ?? 'motivo desconhecido'})`);
      }
      let text = '';
      for (const item of res.output) {
        if (item.type !== 'message') continue;
        for (const part of item.content) {
          // A recusa vem em um campo próprio, fora do schema.
          if (part.type === 'refusal') throw new AiError('refused', `o modelo recusou o pedido: ${part.refusal}`);
          if (part.type === 'output_text') text += part.text;
        }
      }
      const data = parseJsonText(req.schema, text);
      return {
        data,
        model: res.model,
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      };
    },
  };
}

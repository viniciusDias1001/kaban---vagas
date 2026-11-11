import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AiError, detailFromStatus, kindFromStatus, parseJsonText, scrubSecrets, withUsage } from './errors';
import { CALL_TIMEOUT_MS, REASONING_HEADROOM } from './limits';
import type { AiProvider, AiTier } from './types';

const EFFORT = { fast: 'low', strong: 'medium' } as const;
/*
 * Tokens de raciocínio contam em `max_output_tokens` (folga em REASONING_HEADROOM). A chamada NÃO usa streaming:
 * o tempo limite por nível (CALL_TIMEOUT_MS) cobre a resposta inteira.
 */
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
  if (e instanceof OpenAI.APIUserAbortError) return new AiError('transient', 'chamada cancelada (tempo esgotado)', 'timeout');
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new AiError('transient', 'tempo esgotado ao falar com a OpenAI', 'timeout');
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
    timeout: CALL_TIMEOUT_MS.strong,
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
          { signal: req.signal, timeout: CALL_TIMEOUT_MS[req.tier] },
        );
      } catch (e) {
        throw mapError(e, opts.apiKey);
      }
      const usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
      // A partir daqui a chamada já foi cobrada: todo erro leva o uso, para entrar na contabilidade.
      const billed = { usage: res.usage ? usage : undefined, model: res.model || model };
      if (res.status === 'incomplete') {
        const reason = res.incomplete_details?.reason;
        if (reason === 'content_filter') throw new AiError('refused', 'a OpenAI bloqueou a resposta (content_filter)', undefined, billed);
        if (reason === 'max_output_tokens') throw new AiError('truncated', 'resposta cortada pelo limite de tokens', undefined, billed);
        throw new AiError('invalid_output', 'resposta incompleta (motivo desconhecido)', undefined, billed);
      }
      let text = '';
      for (const item of res.output) {
        if (item.type !== 'message') continue;
        for (const part of item.content) {
          // A recusa vem em um campo próprio, fora do schema. O texto dela é escrito pelo modelo (sem limite
          // de tamanho e influenciável pelos dados da vaga): NÃO entra na mensagem, que vai para
          // `ai_tasks.error` e para a interface.
          if (part.type === 'refusal') throw new AiError('refused', 'o modelo recusou o pedido', undefined, billed);
          if (part.type === 'output_text') text += part.text;
        }
      }
      try {
        return { data: parseJsonText(req.schema, text), model: res.model, usage };
      } catch (e) {
        throw withUsage(e, billed);
      }
    },
  };
}

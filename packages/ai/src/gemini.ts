import { ApiError, FinishReason, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { AiError, detailFromStatus, kindFromStatus, parseJsonText, withUsage } from './errors';
import { CALL_TIMEOUT_MS, REASONING_HEADROOM } from './limits';
import type { AiProvider, AiTier } from './types';

/*
 * Tokens de raciocínio ("thoughts") contam em `maxOutputTokens` (folga em REASONING_HEADROOM). A chamada NÃO usa
 * streaming: o tempo limite por nível (CALL_TIMEOUT_MS) cobre a resposta inteira.
 */
const BLOCKED = new Set<string>([
  FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.BLOCKLIST, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII,
]);

export interface GeminiOptions {
  apiKey: string;
  models: Record<AiTier, string>;
}

/**
 * Mensagens fixas: a do SDK repete o corpo da resposta do provedor, que pode conter a chave. O erro do
 * SDK não segue adiante (nada de `cause`).
 */
function mapError(e: unknown, aborted: boolean): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof ApiError) {
    // Defensivo (não confirmado na documentação lida em 2026-11-11, que lista 401 para chave inválida): o
    // `generateContent` historicamente responde 400 INVALID_ARGUMENT com o motivo API_KEY_INVALID. A
    // mensagem do SDK (o corpo da resposta) só é LIDA aqui para classificar; nunca é repassada.
    if (e.status === 400 && e.message.includes('API_KEY_INVALID')) {
      return new AiError('config', 'a chave de API do Gemini é inválida ou não tem permissão', 'auth');
    }
    const kind = kindFromStatus(e.status);
    const detail = kind === 'config' ? detailFromStatus(e.status) : undefined;
    const what =
      detail === 'auth' ? 'a chave de API do Gemini é inválida ou não tem permissão'
      : detail === 'model' ? 'modelo do Gemini não encontrado'
      : detail === 'billing' ? 'a conta do Gemini está sem crédito'
      : `Gemini respondeu ${e.status}`;
    return new AiError(kind, what, detail);
  }
  // Fora de ApiError, o SDK lança erros de rede, de cancelamento (AbortError) e de tempo esgotado.
  const name = e instanceof Error ? e.name : '';
  if (aborted || name === 'AbortError' || name === 'TimeoutError') {
    return new AiError('transient', 'chamada cancelada (tempo esgotado)', 'timeout');
  }
  return new AiError('transient', 'falha de rede ao falar com o Gemini');
}

export function createGeminiProvider(opts: GeminiOptions): AiProvider {
  // attempts: 1 = sem novas tentativas dentro do SDK (quem tenta de novo é a fila de IA).
  const ai = new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: CALL_TIMEOUT_MS.strong, retryOptions: { attempts: 1 } } });
  return {
    id: 'gemini',
    async generate(req) {
      const model = opts.models[req.tier];
      const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
      let res;
      try {
        res = await ai.models.generateContent({
          model,
          contents: req.prompt,
          config: {
            systemInstruction: req.system,
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchema,
            maxOutputTokens: req.maxOutputTokens + REASONING_HEADROOM[req.tier],
            abortSignal: req.signal,
            httpOptions: { timeout: CALL_TIMEOUT_MS[req.tier] },
            // O SDK 3.x, por padrão, refaz a requisição sozinho quando a resposta termina em CONTINUATION,
            // e cada requisição é cobrada. Desligado: uma chamada = uma requisição = um `usageMetadata`.
            automaticContinuation: false,
          },
        });
      } catch (e) {
        throw mapError(e, req.signal?.aborted === true);
      }
      const u = res.usageMetadata;
      const usage = {
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      };
      // A partir daqui a chamada já foi cobrada (quando há `usageMetadata`): todo erro leva o uso.
      const billed = { usage: u ? usage : undefined, model: res.modelVersion ?? model };
      // Os motivos vêm do provedor: só entram na mensagem se tiverem cara de identificador.
      const label = (value: unknown) => (/^[A-Z_]{1,40}$/.test(String(value)) ? String(value) : 'motivo desconhecido');
      const blockReason = res.promptFeedback?.blockReason;
      if (blockReason) throw new AiError('refused', `o Gemini bloqueou o pedido (${label(blockReason)})`, undefined, billed);
      const finish = res.candidates?.[0]?.finishReason;
      if (finish && BLOCKED.has(finish)) throw new AiError('refused', `o Gemini bloqueou a resposta (${label(finish)})`, undefined, billed);
      if (finish === FinishReason.MAX_TOKENS) throw new AiError('truncated', 'resposta cortada pelo limite de tokens', undefined, billed);
      if (finish === FinishReason.CONTINUATION) throw new AiError('truncated', 'resposta incompleta (pede continuação)', undefined, billed);
      try {
        return { data: parseJsonText(req.schema, res.text), model: res.modelVersion ?? model, usage };
      } catch (e) {
        throw withUsage(e, billed);
      }
    },
  };
}

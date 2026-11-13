import type { AiRequest, AiTier, AiUsage } from './types';

/**
 * Tokens de raciocínio somados ao teto de saída VISÍVEL de cada chamada, nos três provedores (na Anthropic eles
 * contam em `max_tokens`; na OpenAI, em `max_output_tokens`; no Gemini, em `maxOutputTokens`). O raciocínio é
 * cobrado como saída. O total de uma chamada é `outputAllowance()`:
 *
 * | chamada               | visível | raciocínio | total  |
 * | --------------------- | ------- | ---------- | ------ |
 * | camada 1 (10 vagas)   | 1 800   | 2 000      | 3 800  |
 * | camada 2              | 8 000   | 8 000      | 16 000 |
 * | camada 3              | 6 000   | 8 000      | 14 000 |
 * | perfil (ler/traduzir) | 9 000   | 8 000      | 17 000 |
 */
export const REASONING_HEADROOM: Record<AiTier, number> = { fast: 2_000, strong: 8_000 };

/** Teto de saída COBRÁVEL de uma chamada: o visível pedido pela tarefa mais a folga de raciocínio do nível. */
export const outputAllowance = (tier: AiTier, visibleTokens: number): number => visibleTokens + REASONING_HEADROOM[tier];

/**
 * Tempo limite HTTP de uma chamada, por nível. A conta parte do teto de saída e de uma vazão pessimista de
 * 40 tokens/s: o nível forte gera até 17 000 tokens (425 s) e ganha folga até 480 s; o rápido gera até 3 800
 * (95 s) e fica em 120 s. Uma chamada típica termina bem antes (3 000 a 6 000 tokens no nível forte).
 * Os tempos da fila de IA (apps/worker) são sempre maiores que estes: quem corta primeiro é o SDK, com um erro
 * limpo; a fila é a rede de segurança (e a única trava das chamadas em streaming, cujo corpo não tem tempo limite).
 */
export const CALL_TIMEOUT_MS: Record<AiTier, number> = { fast: 120_000, strong: 480_000 };

/** Estimativa conservadora de tokens de um texto: 3 caracteres por token (o usual em português fica entre 3,5 e 4). */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/**
 * Uso ESTIMADO de uma chamada abortada por tempo. O provedor pode cobrar uma requisição abortada (a geração já
 * estava em curso) e não devolve o uso: a entrada é estimada pelo tamanho do prompt e a saída entra no teto da
 * chamada, para o limite de gasto do dia errar para o lado seguro.
 */
export function estimateAbortedUsage(req: Pick<AiRequest<unknown>, 'tier' | 'system' | 'prompt' | 'maxOutputTokens'>): AiUsage {
  return {
    inputTokens: estimateTokens(req.system.length + req.prompt.length),
    outputTokens: outputAllowance(req.tier, req.maxOutputTokens),
  };
}

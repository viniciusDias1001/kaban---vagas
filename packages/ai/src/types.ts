import type { AiProviderId } from '@kv/shared';
import type { ZodType } from 'zod';

export type { AiProviderId } from '@kv/shared';
export type AiTier = 'fast' | 'strong';

export interface AiRequest<T> {
  tier: AiTier;
  /** Parte estável: instruções + perfil. Os adaptadores a colocam onde o provedor faz cache de prefixo. */
  system: string;
  /** Parte volátil: os dados da vaga, sempre delimitados como dados. */
  prompt: string;
  schema: ZodType<T>;
  /** Tokens de saída VISÍVEL. Cada adaptador soma a folga de raciocínio do seu modelo. */
  maxOutputTokens: number;
  /** Abortado pela fila quando a chamada estoura o tempo. */
  signal?: AbortSignal;
}

export interface AiUsage {
  /** Toda a entrada cobrada, inclusive a parte lida ou gravada em cache. */
  inputTokens: number;
  /** Toda a saída cobrada, inclusive tokens de raciocínio. */
  outputTokens: number;
}

export interface AiResult<T> {
  data: T;
  usage: AiUsage;
  /** Modelo que de fato respondeu (pode ser o de fallback). */
  model: string;
}

export interface AiProvider {
  id: AiProviderId | 'fake';
  generate<T>(req: AiRequest<T>): Promise<AiResult<T>>;
}

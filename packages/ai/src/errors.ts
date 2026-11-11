import type { ZodType } from 'zod';

export type AiErrorKind = 'rate_limited' | 'refused' | 'invalid_output' | 'config' | 'transient' | 'other';

/** Detalhe de um erro `config`, para o "Testar conexão" dizer o que está errado. */
export type AiErrorDetail = 'auth' | 'model' | 'billing';

/**
 * Único tipo de erro que sai de um AiProvider. `kind` decide a nova tentativa na fila.
 *
 * NUNCA carrega o erro original do SDK (`cause`): os três SDKs copiam o corpo da resposta do provedor
 * para `message`/`error`, e um provedor pode ecoar a chave ali. A mensagem daqui é fixa ou passa por
 * `scrubSecrets`; é ela que vai para log, `ai_tasks.error` e resposta da API.
 */
export class AiError extends Error {
  override name = 'AiError';
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly detail?: AiErrorDetail,
  ) {
    super(message);
  }
}

/** Formatos comuns de chave de API (inclusive mascaradas com `*`), para o caso de o provedor ecoar outra chave. */
const KEY_SHAPES = /\b(sk-[A-Za-z0-9_*-]{6,}|AIza[0-9A-Za-z_-]{10,})/g;

/** Tira de um texto as chaves conhecidas e qualquer coisa com cara de chave de API. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[chave removida]');
  return out.replace(KEY_SHAPES, '[chave removida]');
}

/** Chave ou modelo errado não se resolve tentando de novo; todo o resto é tentado até o limite da fila. */
export const isRetryable = (kind: AiErrorKind): boolean => kind !== 'config';

/** Classificação por status HTTP, usada pelos três adaptadores depois dos casos específicos de cada SDK. */
export function kindFromStatus(status: number | undefined): AiErrorKind {
  if (status === undefined) return 'transient';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'config';
  if (status === 408 || status === 409 || status >= 500) return 'transient';
  return 'other';
}

export function detailFromStatus(status: number | undefined): AiErrorDetail | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 404) return 'model';
  return undefined;
}

/** Valida com o schema Zod de quem chamou, qualquer que seja a garantia do provedor. */
export function parseOutput<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new AiError('invalid_output', `saída fora do schema: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
}

export function parseJsonText<T>(schema: ZodType<T>, text: string | null | undefined): T {
  if (!text) throw new AiError('invalid_output', 'resposta sem texto');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AiError('invalid_output', 'resposta não é JSON válido');
  }
  return parseOutput(schema, raw);
}

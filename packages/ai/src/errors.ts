import type { ZodType } from 'zod';
import type { AiUsage } from './types';

/**
 * `truncated`: a resposta parou no teto de tokens (repetir a mesma chamada dá o mesmo corte e a mesma
 * cobrança). `input`: a entrada foi recusada ANTES de chamar o modelo (ex.: currículo longo demais).
 * `refused`: o MODELO (ou o filtro de segurança do provedor) recusou o pedido. `draft_blocked`: o modelo
 * respondeu, mas o verificador de não invenção descartou o currículo proposto; são desfechos diferentes
 * para o usuário (um é do provedor, o outro é a proteção do app funcionando).
 */
export type AiErrorKind =
  | 'rate_limited' | 'refused' | 'draft_blocked' | 'invalid_output' | 'truncated' | 'input' | 'config' | 'transient' | 'other';

/** O que um erro pode carregar além de tipo e mensagem. */
export interface AiErrorExtra {
  /** Uso cobrado pela chamada que falhou (recusa, corte ou saída inválida vêm DEPOIS da resposta paga). */
  usage?: AiUsage;
  /** Modelo que respondeu, quando o provedor informou. */
  model?: string;
}

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
  /** Presente quando o provedor respondeu (e cobrou) antes de a chamada falhar: quem chama deve contabilizar. */
  usage?: AiUsage;
  model?: string;
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly detail?: AiErrorDetail,
    extra: AiErrorExtra = {},
  ) {
    super(message);
    if (extra.usage) this.usage = extra.usage;
    if (extra.model) this.model = extra.model;
  }
}

/** Anexa o uso cobrado a um erro que ainda não o tem (o primeiro uso informado vale) e devolve o mesmo erro. */
export function withUsage<E>(error: E, extra: AiErrorExtra): E {
  if (error instanceof AiError) {
    if (!error.usage && extra.usage) error.usage = extra.usage;
    if (!error.model && extra.model) error.model = extra.model;
  }
  return error;
}

/** Formatos comuns de chave de API (inclusive mascaradas com `*`), para o caso de o provedor ecoar outra chave. */
const KEY_SHAPES = /\b(sk-[A-Za-z0-9_*-]{6,}|AIza[0-9A-Za-z_-]{10,})/g;

/** Tira de um texto as chaves conhecidas e qualquer coisa com cara de chave de API. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[chave removida]');
  return out.replace(KEY_SHAPES, '[chave removida]');
}

const NOT_RETRYABLE: ReadonlySet<string> = new Set<AiErrorKind>(['config', 'truncated', 'refused', 'draft_blocked', 'input']);

/**
 * Vale a pena repetir a chamada? Não para erro determinístico: chave ou modelo errado (`config`), resposta
 * cortada no teto de tokens (`truncated`), recusa do modelo ou filtro de segurança (`refused`), rascunho
 * barrado pelo verificador depois da tentativa corretiva (`draft_blocked`) e entrada recusada antes da
 * chamada (`input`). Repetir esses casos só cobra de novo. O resto (rede, limite de taxa,
 * saída fora do schema, que varia entre chamadas) é tentado até o limite da fila.
 * Aceita o tipo (como sempre) ou o próprio erro.
 */
export function isRetryable(kindOrError: AiErrorKind | Error): boolean {
  const kind = typeof kindOrError === 'string' ? kindOrError : kindOrError instanceof AiError ? kindOrError.kind : 'other';
  return !NOT_RETRYABLE.has(kind);
}

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

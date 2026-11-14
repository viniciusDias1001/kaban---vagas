import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AI_PROVIDER_IDS, APP_SECRET_COMMAND, APP_SECRET_MIN_LENGTH, type AiProviderId, type SecretName } from '@kv/shared';

/**
 * Cifra das chaves de API gravadas pela aba Configurações. Só `node:crypto`.
 *
 * Formato de `sealed` (o que vai para a coluna `ai_keys.sealed`):
 *
 *   byte 0        versão do esquema (hoje 1)
 *   bytes 1..12   nonce de 96 bits, aleatório a cada gravação
 *   bytes 13..28  tag de autenticação do GCM (128 bits)
 *   bytes 29..    texto cifrado (AES-256-GCM)
 *
 * - Chave do AES: HKDF-SHA256 de APP_SECRET, com sal e `info` fixos e públicos. APP_SECRET é um segredo
 *   gerado por máquina (32 bytes aleatórios; exigimos ao menos 32 caracteres), não uma senha: o que se
 *   precisa é derivar uma chave de tamanho certo de um segredo de alta entropia, que é o papel do HKDF.
 *   Um KDF de senha (scrypt, Argon2) só ajudaria um segredo fraco, que é recusado, e custaria a cada
 *   leitura do worker. A unicidade por gravação vem do nonce, não de sal por registro.
 * - Dados associados (AAD): `kv:ai-key:v1:<provedor>`. Um `sealed` copiado para a linha de outro provedor
 *   não decifra: a chave da OpenAI não pode ser trocada pela da Anthropic no banco.
 * - Segredos nomeados (senha da caixa, token do bot): `sealSecret`/`openSecret` usam a mesma chave derivada e o
 *   mesmo formato, e só diferem no AAD (`kv:secret:v1:<nome>`). `sealApiKey`/`openApiKey` não mudam.
 * - A versão permite trocar o esquema depois: `openApiKey` escolhe o caminho pelo primeiro byte.
 * - Comparação em tempo constante: a única comparação de segredo é a da tag do GCM, feita pelo OpenSSL
 *   dentro de `decipher.final()`. Este módulo não compara chaves nem segredos por conta própria.
 * - Entradas: `sealApiKey` recusa chave vazia ou só de espaços (um `sealed` de texto vazio não abriria
 *   depois), e as duas funções recusam provedor fora de `AI_PROVIDER_IDS` (senão `undefined` viraria o AAD
 *   `…:undefined`). As duas recusas são `SecretInputError`, conferidas antes de tocar em APP_SECRET.
 * - Memória: este módulo não guarda nada entre chamadas. O que ele zera ao terminar cada chamada são os
 *   Buffers que ele mesmo criou: a chave do AES derivada, a cópia em bytes de APP_SECRET usada no HKDF e,
 *   em `openApiKey`, os bytes decifrados. O que NÃO é zerado, e não há como zerar daqui: as strings (a
 *   chave de API recebida ou devolvida e APP_SECRET, que continua em `process.env`; strings do JavaScript
 *   são imutáveis e ficam na memória até o coletor de lixo), a cópia da chave do AES dentro do objeto de
 *   cifra do OpenSSL (liberada quando ele é coletado) e o que quem chama fizer com o valor devolvido.
 *   Zerar os Buffers só encurta o tempo em que a chave derivada existe; não protege de quem lê a
 *   memória do processo.
 */

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const HKDF_SALT = Buffer.from('kanban-vagas/ai-keys', 'utf8');
const HKDF_INFO = Buffer.from('aes-256-gcm/v1', 'utf8');

/** APP_SECRET ausente ou curta demais: não dá para cifrar nem decifrar. */
export class SecretMissingError extends Error {
  override name = 'SecretMissingError';
  constructor(readonly reason: 'missing' | 'too_short') {
    super(appSecretProblem(reason === 'missing' ? undefined : 'x')!);
  }
}

/** O conteúdo não decifra: APP_SECRET mudou, o dado foi alterado ou pertence a outro provedor. */
export class DecryptError extends Error {
  override name = 'DecryptError';
  constructor() {
    // Mensagem única de propósito: não diz qual das causas foi.
    super('não foi possível decifrar a chave gravada');
  }
}

/** Por que APP_SECRET não serve (texto para a tela), ou null se serve. */
export function appSecretProblem(secret: string | undefined): string | null {
  const how = `Gere um com: ${APP_SECRET_COMMAND} e defina APP_SECRET no ambiente do servidor (no .env, em desenvolvimento).`;
  if (!secret || secret.trim() === '') return `APP_SECRET não está definida. ${how}`;
  if (secret.trim().length < APP_SECRET_MIN_LENGTH) {
    return `APP_SECRET tem menos de ${APP_SECRET_MIN_LENGTH} caracteres. ${how}`;
  }
  return null;
}

/** Argumento inválido para cifrar ou decifrar: chave de API vazia, ou provedor fora de `AI_PROVIDER_IDS`. */
export class SecretInputError extends Error {
  override name = 'SecretInputError';
  constructor(readonly reason: 'empty_key' | 'unknown_provider' | 'unknown_name') {
    // A mensagem nunca inclui o valor recebido: ele pode ser (parte de) um segredo.
    super(
      reason === 'empty_key' ? 'a chave de API está vazia'
        : reason === 'unknown_name' ? `nome de segredo desconhecido (use ${SECRET_NAMES.join(', ')})`
        : `provedor de IA desconhecido (use ${AI_PROVIDER_IDS.join(', ')})`,
    );
  }
}

function assertProvider(provider: unknown): asserts provider is AiProviderId {
  if (typeof provider !== 'string' || !(AI_PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new SecretInputError('unknown_provider');
  }
}

/** Os nomes de segredo aceitos (o Record garante que a lista acompanha `SecretName`). */
const SECRET_NAMES = Object.keys({ mail_password: 1, telegram_bot_token: 1 } satisfies Record<SecretName, 1>) as SecretName[];

function assertName(name: unknown): asserts name is SecretName {
  if (typeof name !== 'string' || !(SECRET_NAMES as readonly string[]).includes(name)) throw new SecretInputError('unknown_name');
}

function deriveKey(appSecret: string | undefined): Buffer {
  if (!appSecret || appSecret.trim() === '') throw new SecretMissingError('missing');
  const secret = appSecret.trim();
  if (secret.length < APP_SECRET_MIN_LENGTH) throw new SecretMissingError('too_short');
  const ikm = Buffer.from(secret, 'utf8');
  try {
    // `hkdfSync` devolve um ArrayBuffer; o Buffer é uma visão dele, então zerar o Buffer zera a chave.
    return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, 32));
  } finally {
    ikm.fill(0);
  }
}

const aad = (provider: AiProviderId) => Buffer.from(`kv:ai-key:v${VERSION}:${provider}`, 'utf8');
const secretAad = (name: SecretName) => Buffer.from(`kv:secret:v${VERSION}:${name}`, 'utf8');

/**
 * Cifra a chave de API de um provedor. Cada chamada usa um nonce novo. Lança SecretInputError (chave vazia
 * ou só de espaços, provedor desconhecido) ou SecretMissingError. A chave não é aparada: isso é de quem chama.
 */
export function sealApiKey(plaintext: string, provider: AiProviderId, appSecret: string | undefined): Buffer {
  assertProvider(provider);
  if (typeof plaintext !== 'string' || plaintext.trim() === '') throw new SecretInputError('empty_key');
  return sealWith(plaintext, aad(provider), appSecret);
}

function sealWith(plaintext: string, aadBytes: Buffer, appSecret: string | undefined): Buffer {
  const key = deriveKey(appSecret);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadBytes);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
  }
}

/**
 * Decifra. Lança SecretInputError (provedor desconhecido), SecretMissingError (sem APP_SECRET) ou
 * DecryptError (todo o resto).
 */
export function openApiKey(sealed: Uint8Array, provider: AiProviderId, appSecret: string | undefined): string {
  assertProvider(provider);
  return openWith(sealed, aad(provider), appSecret);
}

function openWith(sealed: Uint8Array, aadBytes: Buffer, appSecret: string | undefined): string {
  const key = deriveKey(appSecret);
  const parts: Buffer[] = [];
  try {
    const buf = Buffer.from(sealed);
    if (buf.length <= HEADER_BYTES || buf[0] !== VERSION) throw new DecryptError();
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(buf.subarray(1 + NONCE_BYTES, HEADER_BYTES));
    parts.push(decipher.update(buf.subarray(HEADER_BYTES)));
    parts.push(decipher.final());
    const plain = Buffer.concat(parts);
    parts.push(plain);
    return plain.toString('utf8');
  } catch (e) {
    if (e instanceof SecretMissingError) throw e;
    throw new DecryptError();
  } finally {
    key.fill(0);
    for (const part of parts) part.fill(0);
  }
}

/** Cifra um segredo nomeado (AAD `kv:secret:v1:<nome>`). Lança SecretInputError (nome desconhecido, valor vazio) ou SecretMissingError. */
export function sealSecret(plaintext: string, name: SecretName, appSecret: string | undefined): Buffer {
  assertName(name);
  if (typeof plaintext !== 'string' || plaintext.trim() === '') throw new SecretInputError('empty_key');
  return sealWith(plaintext, secretAad(name), appSecret);
}

/** Decifra um segredo nomeado. Lança SecretInputError (nome desconhecido), SecretMissingError ou DecryptError. */
export function openSecret(sealed: Uint8Array, name: SecretName, appSecret: string | undefined): string {
  assertName(name);
  return openWith(sealed, secretAad(name), appSecret);
}

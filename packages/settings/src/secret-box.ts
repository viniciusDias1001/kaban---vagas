import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { APP_SECRET_COMMAND, APP_SECRET_MIN_LENGTH, type AiProviderId } from '@kv/shared';

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
 * - A versão permite trocar o esquema depois: `openApiKey` escolhe o caminho pelo primeiro byte.
 * - Comparação em tempo constante: a única comparação de segredo é a da tag do GCM, feita pelo OpenSSL
 *   dentro de `decipher.final()`. Este módulo não compara chaves nem segredos por conta própria.
 * - A chave derivada é zerada depois de cada uso; nada é guardado em memória entre chamadas.
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

function deriveKey(appSecret: string | undefined): Buffer {
  if (!appSecret || appSecret.trim() === '') throw new SecretMissingError('missing');
  const secret = appSecret.trim();
  if (secret.length < APP_SECRET_MIN_LENGTH) throw new SecretMissingError('too_short');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, HKDF_INFO, 32));
}

const aad = (provider: AiProviderId) => Buffer.from(`kv:ai-key:v${VERSION}:${provider}`, 'utf8');

/** Cifra a chave de API de um provedor. Cada chamada usa um nonce novo. Lança SecretMissingError. */
export function sealApiKey(plaintext: string, provider: AiProviderId, appSecret: string | undefined): Buffer {
  const key = deriveKey(appSecret);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(provider));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
  }
}

/** Decifra. Lança SecretMissingError (sem APP_SECRET) ou DecryptError (todo o resto). */
export function openApiKey(sealed: Uint8Array, provider: AiProviderId, appSecret: string | undefined): string {
  const key = deriveKey(appSecret);
  try {
    const buf = Buffer.from(sealed);
    if (buf.length <= HEADER_BYTES || buf[0] !== VERSION) throw new DecryptError();
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(provider));
    decipher.setAuthTag(buf.subarray(1 + NONCE_BYTES, HEADER_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof SecretMissingError) throw e;
    throw new DecryptError();
  } finally {
    key.fill(0);
  }
}

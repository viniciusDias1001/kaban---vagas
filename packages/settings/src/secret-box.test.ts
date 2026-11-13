import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AiProviderId } from '@kv/shared';
import { DecryptError, SecretInputError, SecretMissingError, appSecretProblem, openApiKey, openSecret, sealApiKey, sealSecret } from './secret-box';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0001';
const OTHER_SECRET = 'outro-segredo-de-teste-com-mais-de-32-caracteres';
const KEY = 'sk-test-chave-ficticia-1234567890';

describe('sealApiKey / openApiKey', () => {
  it('round-trips a key for the same provider and secret', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    expect(openApiKey(sealed, 'openai', SECRET)).toBe(KEY);
    // PGlite e postgres-js devolvem tipos diferentes para bytea: os dois precisam abrir.
    expect(openApiKey(new Uint8Array(sealed), 'openai', SECRET)).toBe(KEY);
    expect(openApiKey(sealApiKey('chave-com-acento-ç-e-emoji-🔑', 'gemini', SECRET), 'gemini', SECRET)).toBe('chave-com-acento-ç-e-emoji-🔑');
  });

  it('uses the documented layout: version byte, 96-bit nonce, 128-bit tag, ciphertext', () => {
    const sealed = sealApiKey(KEY, 'anthropic', SECRET);
    expect(sealed[0]).toBe(1);
    expect(sealed.length).toBe(1 + 12 + 16 + Buffer.byteLength(KEY));
  });

  it('never stores the plaintext, in any encoding', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    for (const encoding of ['latin1', 'utf8', 'hex', 'base64'] as const) {
      expect(sealed.toString(encoding)).not.toContain(KEY);
      expect(sealed.toString(encoding)).not.toContain(Buffer.from(KEY).toString(encoding === 'latin1' || encoding === 'utf8' ? 'utf8' : encoding));
    }
  });

  it('uses a fresh nonce on every write: the same key seals differently each time', () => {
    const seals = Array.from({ length: 200 }, () => sealApiKey(KEY, 'openai', SECRET));
    const nonces = new Set(seals.map((s) => s.subarray(1, 13).toString('hex')));
    expect(nonces.size).toBe(200);
    expect(new Set(seals.map((s) => s.toString('hex'))).size).toBe(200);
  });

  it('detects tampering in every part: version, nonce, tag and ciphertext', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    for (const index of [0, 1, 12, 13, 28, 29, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] ^= 0x01;
      expect(() => openApiKey(tampered, 'openai', SECRET), `byte ${index}`).toThrow(DecryptError);
    }
    expect(() => openApiKey(sealed.subarray(0, sealed.length - 1), 'openai', SECRET)).toThrow(DecryptError);
    expect(() => openApiKey(sealed.subarray(0, 29), 'openai', SECRET)).toThrow(DecryptError);
    expect(() => openApiKey(Buffer.alloc(0), 'openai', SECRET)).toThrow(DecryptError);
    expect(() => openApiKey(Buffer.concat([sealed, Buffer.from([0])]), 'openai', SECRET)).toThrow(DecryptError);
  });

  it('fails with a wrong secret (APP_SECRET rotated)', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    expect(() => openApiKey(sealed, 'openai', OTHER_SECRET)).toThrow(DecryptError);
  });

  it('binds the ciphertext to the provider: a sealed key moved to another provider does not open', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    expect(() => openApiKey(sealed, 'anthropic', SECRET)).toThrow(DecryptError);
    expect(() => openApiKey(sealed, 'gemini', SECRET)).toThrow(DecryptError);
  });

  it('gives one message for every decryption failure, without the key or the cause', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    const errors = [
      () => openApiKey(sealed, 'openai', OTHER_SECRET),
      () => openApiKey(sealed, 'gemini', SECRET),
      () => openApiKey(sealed.subarray(0, 20), 'openai', SECRET),
    ].map((run) => {
      try {
        run();
        return null;
      } catch (e) {
        return e as Error;
      }
    });
    expect(new Set(errors.map((e) => e?.message)).size).toBe(1);
    expect(errors.every((e) => e instanceof DecryptError && e.cause === undefined && !String(e.stack).includes(KEY))).toBe(true);
  });

  it('refuses to work without a usable APP_SECRET, with a typed error that says how to fix it', () => {
    for (const [secret, reason] of [[undefined, 'missing'], ['', 'missing'], ['   ', 'missing'], ['curto', 'too_short'], ['x'.repeat(31), 'too_short']] as const) {
      expect(() => sealApiKey(KEY, 'openai', secret)).toThrow(SecretMissingError);
      try {
        openApiKey(Buffer.alloc(40), 'openai', secret);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SecretMissingError);
        expect((e as SecretMissingError).reason).toBe(reason);
        expect((e as Error).message).toMatch(/APP_SECRET.*randomBytes\(32\)/);
      }
    }
    expect(() => sealApiKey(KEY, 'openai', 'x'.repeat(32))).not.toThrow();
  });

  it('refuses to seal an empty or blank key, with a typed error and before producing any blob', () => {
    for (const blank of ['', ' ', '   ', '\n', '\t \r\n', '\u00a0', 12345, null, undefined]) {
      try {
        sealApiKey(blank as string, 'openai', SECRET);
        expect.unreachable(`sealed ${JSON.stringify(blank)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(SecretInputError);
        expect((e as SecretInputError).reason).toBe('empty_key');
      }
    }
    // Espaço em volta de uma chave real continua valendo: quem apara é quem chama (a rota já apara).
    expect(openApiKey(sealApiKey(` ${KEY}\n`, 'openai', SECRET), 'openai', SECRET)).toBe(` ${KEY}\n`);
  });

  it('refuses a provider outside the known list, when sealing and when opening', () => {
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    for (const bogus of [undefined, null, '', 'fake', 'OpenAI', 'openai ', 'toString', '__proto__', 7, ['openai']]) {
      for (const run of [
        () => sealApiKey(KEY, bogus as AiProviderId, SECRET),
        () => openApiKey(sealed, bogus as AiProviderId, SECRET),
      ]) {
        try {
          run();
          expect.unreachable(`accepted ${JSON.stringify(bogus)}`);
        } catch (e) {
          expect(e).toBeInstanceOf(SecretInputError);
          expect((e as SecretInputError).reason).toBe('unknown_provider');
          expect(String((e as Error).stack)).not.toContain(KEY);
        }
      }
    }
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      expect(openApiKey(sealApiKey(KEY, provider, SECRET), provider, SECRET)).toBe(KEY);
    }
  });

  it('checks the arguments before the secret: a bad argument is reported even without APP_SECRET', () => {
    expect(() => sealApiKey('', 'openai', undefined)).toThrow(SecretInputError);
    expect(() => sealApiKey(KEY, 'nope' as AiProviderId, undefined)).toThrow(SecretInputError);
    expect(() => openApiKey(Buffer.alloc(40), 'nope' as AiProviderId, undefined)).toThrow(SecretInputError);
  });

  it('does not let a tampered blob that authenticates as empty pass for a key', () => {
    // Um blob só de cabeçalho (texto cifrado vazio) continua sendo erro de decifragem, não uma chave ''.
    const sealed = sealApiKey(KEY, 'openai', SECRET);
    expect(() => openApiKey(sealed.subarray(0, 29), 'openai', SECRET)).toThrow(DecryptError);
  });

  it('appSecretProblem explains what is wrong, or returns null', () => {
    expect(appSecretProblem(undefined)).toMatch(/APP_SECRET não está definida/);
    expect(appSecretProblem('curto')).toMatch(/menos de 32 caracteres/);
    expect(appSecretProblem(SECRET)).toBeNull();
  });
});

describe('sealSecret / openSecret', () => {
  const PASSWORD = 'abcdefghijklmnop';

  it('seals a named secret that only opens under the same name', () => {
    const sealed = sealSecret(PASSWORD, 'mail_password', SECRET);
    expect(openSecret(sealed, 'mail_password', SECRET)).toBe(PASSWORD);
    expect(openSecret(new Uint8Array(sealed), 'mail_password', SECRET)).toBe(PASSWORD);
    expect(() => openSecret(sealed, 'telegram_bot_token', SECRET)).toThrow(DecryptError);
  });

  it('does not open an AI key as a named secret, nor the other way round', () => {
    expect(() => openSecret(sealApiKey(KEY, 'openai', SECRET), 'mail_password', SECRET)).toThrow(DecryptError);
    expect(() => openApiKey(sealSecret(PASSWORD, 'mail_password', SECRET), 'openai', SECRET)).toThrow(DecryptError);
  });

  it('still opens an AI key sealed before this change', () => {
    expect(openApiKey(sealApiKey('sk-test-12345678', 'anthropic', SECRET), 'anthropic', SECRET)).toBe('sk-test-12345678');
    // Selado à mão com o esquema documentado (sal, info e AAD do código antigo): tem de abrir byte a byte.
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('kanban-vagas/ai-keys'), Buffer.from('aes-256-gcm/v1'), 32));
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('kv:ai-key:v1:openai'));
    const body = Buffer.concat([cipher.update(KEY, 'utf8'), cipher.final()]);
    const legacy = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
    expect(openApiKey(legacy, 'openai', SECRET)).toBe(KEY);
  });

  it('refuses to seal without APP_SECRET, and fails to open under another one', () => {
    expect(() => sealSecret('x', 'mail_password', undefined)).toThrow(SecretMissingError);
    expect(() => openSecret(sealSecret(PASSWORD, 'mail_password', SECRET), 'mail_password', OTHER_SECRET)).toThrow(DecryptError);
  });

  it('refuses an unknown name or an empty value, without echoing the value', () => {
    expect(() => sealSecret(PASSWORD, 'outro' as never, SECRET)).toThrow(expect.objectContaining({ reason: 'unknown_name' }));
    expect(() => openSecret(Buffer.alloc(40), 'outro' as never, SECRET)).toThrow(SecretInputError);
    expect(() => sealSecret('   ', 'mail_password', SECRET)).toThrow(expect.objectContaining({ reason: 'empty_key' }));
    try {
      sealSecret(PASSWORD, 'mail_password', 'curta');
    } catch (e) {
      expect(String(e)).not.toContain(PASSWORD);
      expect(JSON.stringify(e)).not.toContain(PASSWORD);
    }
  });
});

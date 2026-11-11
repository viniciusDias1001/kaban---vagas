import { describe, expect, it } from 'vitest';
import { DecryptError, SecretMissingError, appSecretProblem, openApiKey, sealApiKey } from './secret-box';

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

  it('appSecretProblem explains what is wrong, or returns null', () => {
    expect(appSecretProblem(undefined)).toMatch(/APP_SECRET não está definida/);
    expect(appSecretProblem('curto')).toMatch(/menos de 32 caracteres/);
    expect(appSecretProblem(SECRET)).toBeNull();
  });
});

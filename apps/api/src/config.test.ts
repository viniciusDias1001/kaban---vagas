import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveListen, resolveWebDist } from './config';

describe('resolveListen', () => {
  it('defaults to 127.0.0.1:3333, the local development address', () => {
    expect(resolveListen({})).toEqual({ host: '127.0.0.1', port: 3333 });
    expect(resolveListen({ PORT: '', API_PORT: '', HOST: '' })).toEqual({ host: '127.0.0.1', port: 3333 });
  });

  it('prefers PORT over API_PORT and takes the host from HOST', () => {
    expect(resolveListen({ API_PORT: '4000' })).toEqual({ host: '127.0.0.1', port: 4000 });
    expect(resolveListen({ PORT: '8080', API_PORT: '4000', HOST: '0.0.0.0' })).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('rejects a port that is not a valid TCP port', () => {
    expect(() => resolveListen({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => resolveListen({ API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});

describe('resolveWebDist', () => {
  it('uses WEB_DIST or the default build directory, only when it has an index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-web-resolve-'));
    const nope = join(dir, 'nope');
    try {
      expect(resolveWebDist({ WEB_DIST: dir }, nope)).toBeUndefined();
      expect(resolveWebDist({}, dir)).toBeUndefined();
      writeFileSync(join(dir, 'index.html'), 'x');
      expect(resolveWebDist({ WEB_DIST: dir }, nope)).toBe(dir);
      expect(resolveWebDist({}, dir)).toBe(dir);
      expect(resolveWebDist({ WEB_DIST: '' }, dir)).toBe(dir);
      // WEB_DIST explícito e inválido não cai silenciosamente no diretório padrão.
      expect(resolveWebDist({ WEB_DIST: nope }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

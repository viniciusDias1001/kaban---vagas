import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../..', import.meta.url));
const script = 'packages/apply/scripts/record-fixture.ts';
let work: string;

function run(...args: string[]) {
  const quoted = args.map((a) => `"${a}"`);
  const r = spawnSync('pnpm', ['exec', 'tsx', script, ...quoted], { cwd: repo, shell: true, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'kv-record-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('record-fixture refusals', () => {
  it('refuses --staging inside the repository, before opening any browser', () => {
    const r = run('profile', '--staging', 'packages/apply/tmp-stage');
    expect(r.code).toBe(1);
    expect(r.out).toContain('dentro do repositório');
  });

  it('refuses --identity inside the repository', () => {
    const from = join(work, 'in1');
    mkdirSync(from);
    writeFileSync(join(from, 'a.html'), '<p>oi</p>');
    const r = run('scrub', '--from', from, '--to', join(work, 'out1'), '--identity', 'packages/apply/package.json');
    expect(r.code).toBe(1);
    expect(r.out).toContain('dentro do repositório');
    expect(existsSync(join(work, 'out1'))).toBe(false);
  });

  it('refuses --from inside the repository, including a directory named ..foo', () => {
    for (const from of ['packages/apply/fixtures/fake', join(repo, '..foo')]) {
      const r = run('scrub', '--from', from, '--to', join(work, 'out2'));
      expect(r.code).toBe(1);
      expect(r.out).toContain('dentro do repositório');
    }
  });
});

describe('record-fixture writing', () => {
  it('writes nothing when any file still leaks, and everything when none does', () => {
    const from = join(work, 'in3');
    mkdirSync(from);
    writeFileSync(join(from, 'clean.html'), '<p>Ana Souza, rh@acme.com</p>');
    writeFileSync(join(from, 'leak.html'), '<p>https://media.licdn.com/x.jpg</p>');
    const to = join(work, 'out3');
    const blocked = run('scrub', '--from', from, '--to', to);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain('[photo]');
    expect(existsSync(to)).toBe(false);

    rmSync(join(from, 'leak.html'));
    const ok = run('scrub', '--from', from, '--to', to);
    expect(ok.code).toBe(0);
    expect(existsSync(join(to, 'clean.html'))).toBe(true);
  });

  it('refuses to write a file in which an identity name survives the scrub', () => {
    const from = join(work, 'in4');
    mkdirSync(from);
    writeFileSync(join(from, 'a.html'), '<p>Ana&nbsp;Souza</p>');
    const id = join(work, 'id.json');
    writeFileSync(id, JSON.stringify({ names: ['Ana Souza'], emails: [], phones: [], extra: [] }));
    const to = join(work, 'out4');
    const r = run('scrub', '--from', from, '--to', to, '--identity', id);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[identity]');
    expect(existsSync(to)).toBe(false);
  });
});

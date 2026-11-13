import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Os caminhos (relativos a `fixtures/`) que o `.gitignore` de lá ignora. Não precisa que existam. */
function ignored(paths: string[]): string[] {
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: fixtures, input: paths.join('\n'), encoding: 'utf8' });
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

describe('fixtures/.gitignore is an allow-list', () => {
  it('keeps the hand-written and public files', () => {
    const kept = [
      '.gitignore', 'README.md', 'fake/form.html', 'fake/captcha-sends.html', 'recording/page.html', 'recording/app.js',
      'greenhouse/job.json', 'greenhouse/confirmation.synthetic.html', 'lever/confirmation.synthetic.html',
      'linkedin/confirmation.synthetic.html',
    ];
    expect(ignored(kept)).toEqual([]);
  });

  it('ignores recordings of any site, a new one included, with no line of its own', () => {
    const recorded = [
      'greenhouse/form/routes.json', 'lever/form/document.html', 'lever/rendered.html', 'lever/closed.html',
      'linkedin/page.html', 'linkedin/form/routes.json', 'ashby/snapshot.html', 'greenhouse/other.json', 'loose.html',
    ];
    expect(ignored(recorded).sort()).toEqual([...recorded].sort());
  });
});

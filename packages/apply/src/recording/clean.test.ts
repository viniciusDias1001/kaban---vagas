import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLeaks } from './scrub';

const root = fileURLToPath(new URL('../../fixtures', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(html|json|js|css)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(root);

describe('fixtures', () => {
  it('finds fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no e-mail, phone, member id, photo or token', (file) => {
    expect(findLeaks(readFileSync(file, 'utf8'), /\.(js|css)$/.test(file) ? 'asset' : 'markup')).toEqual([]);
  });
});

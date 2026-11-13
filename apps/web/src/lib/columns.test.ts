import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLUMNS } from '@kv/shared/client';
import { COLUMN_COLOR } from './columns';

const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8');

/** Cor sRGB "#rrggbb" para luminância relativa (WCAG 2). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const cssVar = (name: string) => CSS.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];

describe('column colours', () => {
  it('has a colour for every column, in the column order, each defined in index.css', () => {
    expect(Object.keys(COLUMN_COLOR)).toEqual([...COLUMNS]);
    for (const c of COLUMNS) {
      expect(COLUMN_COLOR[c]).toBe(`var(--col-${c})`);
      expect(cssVar(`--col-${c}`), c).toBeDefined();
    }
  });

  it('reads at 4.5:1 or more on the column background, like every other column colour', () => {
    const surface = cssVar('--color-surface')!;
    for (const c of COLUMNS) expect(contrast(cssVar(`--col-${c}`)!, surface), c).toBeGreaterThanOrEqual(4.5);
  });

  it('gives Descartada its own colour, apart from Perdida and Arquivada', () => {
    const discarded = cssVar('--col-descartada');
    expect(discarded).toMatch(/^#/);
    expect(discarded).not.toBe(cssVar('--col-perdida'));
    expect(discarded).not.toBe(cssVar('--col-arquivada'));
    expect(discarded).not.toBe(cssVar('--col-selecionadas'));
  });
});

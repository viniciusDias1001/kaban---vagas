import { describe, expect, it } from 'vitest';
import { allFaces, layoutLine, sanitizePdfText } from './pdf-text';

describe('pdf fonts', () => {
  it('loads Noto Serif, regular and bold, in the seven subsets', () => {
    const faces = allFaces();
    expect(faces).toHaveLength(14);
    expect(faces.every((f) => f.path.includes('noto-serif-'))).toBe(true);
  });

  it('draws the signs the layout itself writes, in both weights', () => {
    for (const weight of ['regular', 'bold'] as const) {
      const missing = new Set<string>();
      expect(layoutLine('• · | -', weight, missing).map((r) => r.text).join('')).toBe('• · | -');
      expect([...missing]).toEqual([]);
    }
    expect(sanitizePdfText('• ·')).toBe('• ·'); // they do not fall to the "-" of ASCII_FALLBACK
  });

  it('never loses a typographic sign: each one is drawn or replaced', () => {
    const missing = new Set<string>();
    for (const sign of ['→', '⇒', '≥', '…', '“', '”', '–', '—', '‣', '€']) layoutLine(sanitizePdfText(sign), 'regular', missing);
    expect([...missing]).toEqual([]);
  });
});

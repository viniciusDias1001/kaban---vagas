import { describe, expect, it } from 'vitest';
import { fold, hasTerm, stripHtml } from './text';

describe('stripHtml', () => {
  it('removes tags, decodes entities and keeps paragraph breaks', () => {
    expect(stripHtml('<p>Oi &amp; tchau</p><p>x</p>')).toBe('Oi & tchau\nx');
  });
  it('handles entity-escaped html', () => {
    expect(stripHtml('&lt;p&gt;Hello&lt;/p&gt;')).toBe('Hello');
  });
});

describe('fold', () => {
  it('lowercases and strips accents', () => {
    expect(fold('Sênior')).toBe('senior');
  });
});

describe('hasTerm', () => {
  it('matches whole terms only', () => {
    expect(hasTerm('Senior JavaScript Engineer', 'java')).toBe(false);
    expect(hasTerm('Java Developer', 'java')).toBe(true);
    expect(hasTerm('Dev C# / .NET', 'c#')).toBe(true);
    expect(hasTerm('Dev C# / .NET', '.net')).toBe(true);
  });
});

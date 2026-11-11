const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
}

export function stripHtml(html: string): string {
  const noTags = decodeEntities(html)
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(noTags)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Minúsculas e sem acentos, para comparar texto. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Verdadeiro se `term` aparece em `text` como termo inteiro (não como parte de outra palavra). */
export function hasTerm(text: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRe(fold(term))}(?![a-z0-9])`).test(fold(text));
}

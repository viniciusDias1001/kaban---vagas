import { MAIL_LIMITS } from '@kv/shared';

const DROPPED_BLOCKS = /<!--[\s\S]*?-->|<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const LINE_BREAK = /<br\s*\/?>|<hr\b[^>]*>/gi;
const BLOCK_END = /<\/(p|div|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|header|footer|pre|dd|dt)\s*>/gi;
const ANY_TAG = /<\/?[a-z!][^>]*>/gi;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', ordm: 'º', ordf: 'ª', deg: '°',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å', iexcl: '¡', iquest: '¿',
};
// Letras acentuadas (`&eacute;`, `&atilde;`, `&ccedil;`...) montadas pela marca combinante.
const MARKS: Record<string, string> = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧' };
for (const letter of 'aeiouycnAEIOUYCN') {
  for (const [name, mark] of Object.entries(MARKS)) {
    const composed = (letter + mark).normalize('NFC');
    if (composed.length === 1) NAMED[letter + name] = composed;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[body] ?? whole;
  });
}

/** Junta espaços repetidos em cada linha e deixa no máximo uma linha em branco seguida. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML para texto: tira script, style e marcação, troca `br` e fim de bloco por quebra de linha, decodifica entidades. Não abre nada. */
export function htmlToText(html: string): string {
  const text = html
    .replace(DROPPED_BLOCKS, '')
    .replace(LINE_BREAK, '\n')
    .replace(BLOCK_END, '\n')
    .replace(ANY_TAG, '');
  return tidy(decodeEntities(text));
}

/** Junta espaços e quebras repetidas, tira o NUL e corta em MAIL_LIMITS.bodyChars. */
export function clipBody(text: string): string {
  return tidy(stripNul(text)).slice(0, MAIL_LIMITS.bodyChars);
}

/** Sem o caractere NUL, que o Postgres recusa em texto (um cabeçalho codificado pode trazê-lo). */
export function stripNul(value: string): string {
  return value.replace(/\u0000/g, '');
}

interface StructureNode { part?: unknown; type?: unknown; disposition?: unknown; childNodes?: unknown }

function textLeaves(node: unknown, out: { part: string; type: string }[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as StructureNode;
  const type = typeof n.type === 'string' ? n.type.toLowerCase() : '';
  if (typeof n.disposition === 'string' && n.disposition.toLowerCase() === 'attachment') return;
  // Mensagem encaminhada vai como anexo: o texto dela não é o deste e-mail.
  if (type === 'message/rfc822') return;
  if (type.startsWith('multipart/')) {
    if (Array.isArray(n.childNodes)) for (const child of n.childNodes) textLeaves(child, out);
    return;
  }
  // Mensagem de uma parte só: a raiz não tem número, e o corpo é a parte 1.
  out.push({ part: typeof n.part === 'string' && n.part ? n.part : '1', type });
}

/** Da estrutura MIME (`bodyStructure` do imapflow): a parte text/plain que não é anexo; sem ela, a text/html; senão null. Nunca uma parte com disposition attachment. */
export function pickTextPart(structure: unknown): { part: string; html: boolean } | null {
  const leaves: { part: string; type: string }[] = [];
  textLeaves(structure, leaves);
  const plain = leaves.find((l) => l.type === 'text/plain');
  if (plain) return { part: plain.part, html: false };
  const html = leaves.find((l) => l.type === 'text/html');
  return html ? { part: html.part, html: true } : null;
}

/** `uid-<uidValidity>-<uid>@sem-id.local` */
export function syntheticMessageId(uidValidity: number, uid: number): string {
  return `uid-${uidValidity}-${uid}@sem-id.local`;
}

/** Primeiro id de `references`; senão `inReplyTo`; senão o próprio id. */
export function threadKeyFromHeaders(h: { messageId: string; inReplyTo: string | null; references: string[] }): string {
  return h.references[0] || h.inReplyTo || h.messageId;
}

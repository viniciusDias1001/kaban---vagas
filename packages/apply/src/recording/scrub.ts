/**
 * Limpeza de dados pessoais das páginas gravadas como fixtures. Funções puras: `scrubFixture` troca o que é
 * pessoal por texto neutro; `findLeaks` é o detector que roda por cima e acusa o que a limpeza deixaria passar.
 * As duas usam as mesmas constantes de padrão, para o que uma troca ser exatamente o que a outra procura.
 */

export interface ScrubIdentity { names: string[]; emails: string[]; phones: string[]; extra: string[] }
export const NO_IDENTITY: ScrubIdentity = { names: [], emails: [], phones: [], extra: [] };

export const PLACEHOLDER = {
  name: 'Pessoa Exemplo',
  email: 'pessoa@example.com',
  phone: '+55 11 90000-0000',
  slug: 'pessoa-exemplo',
  /** GIF transparente de 1x1 pixel. */
  pixel: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
} as const;

export const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
export const PHONE_PATTERN = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,5}[\s.-]\d{4}(?!\d)/g;

/** `markup`: .html e .json; `asset`: .js e .css. */
export type FixtureKind = 'markup' | 'asset';
export interface Leak { rule: 'email' | 'phone' | 'member_id' | 'profile_url' | 'photo' | 'token'; sample: string }

const FILE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot)$/i;
const MEMBER_URN = /urn:li:([A-Za-z0-9_]*(?:member|profile|person)[A-Za-z0-9_]*):([\w-]+)/gi;
const PROFILE_URL = /(?<=linkedin\.com|["'(=\s>])\/in\/([^\s"'<>/?#&]+)/gi;
const LICDN_URL = /(?:https?:)?\/\/(?:[\w-]+\.)*licdn\.com(?:[/?#][^\s"'()<>]*)?/gi;
const DATA_IMAGE = /data:image\/[^\s"'()<>]*/gi;
const DATA_IMAGE_LIMIT = 200;
const SESSION_TOKEN = /(\b(?:JSESSIONID|li_at|csrfToken)\b["']?\s*[=:]\s*["']?)([^;"'\s&<,]+)/g;
const AJAX_TOKEN = /ajax:(\d+)/g;
const ATTRIBUTE = /(\b(?:src|srcset|href|style)\s*=\s*)("[^"]*"|'[^']*')/gi;
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const INPUT_TAG = new RegExp(`<input\\b${TAG_BODY}>`, 'gi');
const TEXTAREA = new RegExp(`(<textarea\\b${TAG_BODY}>)[\\s\\S]*?(</textarea>)`, 'gi');
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'search', 'hidden', 'password']);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Sem acento nem caixa. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** O texto dobrado, com o intervalo do texto original que gerou cada caractere dobrado. */
function foldWithMap(text: string): { folded: string; start: number[]; end: number[] } {
  let folded = '';
  const start: number[] = [];
  const end: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const next = offset + ch.length;
    const piece = fold(ch);
    if (piece === '') {
      // Marca de acento solta: pertence ao caractere anterior.
      if (end.length) end[end.length - 1] = next;
    } else {
      for (let i = 0; i < piece.length; i++) {
        folded += piece[i];
        start.push(offset);
        end.push(next);
      }
    }
    offset = next;
  }
  return { folded, start, end };
}

function replaceText(text: string, term: string, replacement: string): string {
  const needle = fold(term);
  if (!needle) return text;
  const { folded, start, end } = foldWithMap(text);
  let out = '';
  let last = 0;
  let from = 0;
  for (let at = folded.indexOf(needle, from); at !== -1; at = folded.indexOf(needle, from)) {
    out += text.slice(last, start[at]) + replacement;
    last = end[at + needle.length - 1];
    from = at + needle.length;
  }
  return out + text.slice(last);
}

function phoneRegexFor(phone: string): RegExp | null {
  const digits = digitsOf(phone);
  if (digits.length < 8) return null;
  return new RegExp(`(?<!\\d)(?:\\+\\d{1,3}[\\s.-]*)?\\(?${[...digits].join('[\\s().-]*')}(?!\\d)`, 'g');
}

function isExampleEmail(email: string): boolean {
  return /@example\.com$/i.test(email) || FILE_EXTENSION.test(email);
}

function inputType(tag: string): string {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(tag);
  return (m ? (m[1] ?? m[2] ?? m[3] ?? '') : 'text').trim().toLowerCase();
}

function scrubAttributeValue(value: string): string {
  return value
    .replace(LICDN_URL, PLACEHOLDER.pixel)
    .replace(DATA_IMAGE, (m) => (m.length > DATA_IMAGE_LIMIT ? PLACEHOLDER.pixel : m));
}

function scrubEmails(text: string, identity: ScrubIdentity): string {
  let out = text;
  for (const email of identity.emails) {
    if (email.trim()) out = out.replace(new RegExp(escapeRegExp(email.trim()), 'gi'), PLACEHOLDER.email);
  }
  return out.replace(EMAIL_PATTERN, (m) => (isExampleEmail(m) ? m : PLACEHOLDER.email));
}

/** Troca o que é pessoal por texto neutro. Idempotente. Em `asset` vale só a regra dos e-mails. */
export function scrubFixture(text: string, identity: ScrubIdentity, kind: FixtureKind = 'markup'): string {
  if (kind === 'asset') return scrubEmails(text, identity);
  let out = text;

  // 1. nomes e dados extras, os mais longos primeiro
  const terms = [...identity.names, ...identity.extra]
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => fold(b).length - fold(a).length);
  for (const term of terms) out = replaceText(out, term, PLACEHOLDER.name);

  // 2. e-mails
  out = scrubEmails(out, identity);

  // 3. telefones
  for (const phone of identity.phones) {
    const re = phoneRegexFor(phone);
    if (re) out = out.replace(re, PLACEHOLDER.phone);
  }
  out = out.replace(PHONE_PATTERN, PLACEHOLDER.phone);

  // 4. identificadores de membro
  out = out.replace(MEMBER_URN, (_m, type: string) => `urn:li:${type}:0`);

  // 5. endereços de perfil
  out = out.replace(PROFILE_URL, `/in/${PLACEHOLDER.slug}`);

  // 6. fotos
  out = out.replace(ATTRIBUTE, (_m, name: string, quoted: string) => {
    const quote = quoted[0];
    return `${name}${quote}${scrubAttributeValue(quoted.slice(1, -1))}${quote}`;
  });

  // 7. campos preenchidos
  out = out.replace(INPUT_TAG, (tag) => {
    if (!TEXT_INPUT_TYPES.has(inputType(tag))) return tag;
    return tag.replace(/(?<=[\s"'])(value\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>"']*)/i, '$1""');
  });
  out = out.replace(TEXTAREA, '$1$2');

  // 8. sessão e tokens
  out = out.replace(SESSION_TOKEN, '$1ajax:0');
  out = out.replace(AJAX_TOKEN, 'ajax:0');

  return out;
}

function sampleOf(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** O que as regras 2 a 6 e 8 deixariam passar. O próprio texto de substituição não conta. */
export function findLeaks(text: string, kind: FixtureKind = 'markup'): Leak[] {
  const leaks: Leak[] = [];
  const add = (rule: Leak['rule'], sample: string) => leaks.push({ rule, sample: sampleOf(sample) });

  for (const m of text.matchAll(EMAIL_PATTERN)) if (!isExampleEmail(m[0])) add('email', m[0]);
  if (kind === 'asset') return leaks;

  for (const m of text.matchAll(PHONE_PATTERN)) if (m[0] !== PLACEHOLDER.phone) add('phone', m[0]);
  for (const m of text.matchAll(MEMBER_URN)) if (m[2] !== '0') add('member_id', m[0]);
  for (const m of text.matchAll(PROFILE_URL)) if (m[1] !== PLACEHOLDER.slug) add('profile_url', `/in/${m[1]}`);
  for (const m of text.matchAll(LICDN_URL)) add('photo', m[0]);
  for (const m of text.matchAll(DATA_IMAGE)) if (m[0].length > DATA_IMAGE_LIMIT) add('photo', m[0]);
  for (const m of text.matchAll(SESSION_TOKEN)) if (m[2] !== 'ajax:0') add('token', `${m[1]}${m[2]}`.trim());
  for (const m of text.matchAll(AJAX_TOKEN)) if (m[1] !== '0') add('token', m[0]);
  return leaks;
}

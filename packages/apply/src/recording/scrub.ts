/**
 * Limpeza de dados pessoais das páginas gravadas como fixtures. Funções puras: `scrubFixture` troca o que é
 * pessoal por texto neutro; `findLeaks` é o detector que roda por cima e acusa o que a limpeza deixaria passar;
 * `findIdentityLeaks` confere, depois da limpeza, se o que o dono informou ainda aparece em alguma forma.
 * `scrubFixture` e `findLeaks` usam as mesmas constantes de padrão, para o que uma troca ser exatamente o que
 * a outra procura.
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
/** Dado que o dono informou e que ainda aparece no arquivo. */
export interface IdentityLeak { rule: 'identity'; sample: string }

const FILE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot)$/i;
const MEMBER_URN = /urn:li:([A-Za-z0-9_]*(?:member|profile|person)[A-Za-z0-9_]*):(\([^)\s"'<>]*\)|[\w-]+)/gi;
const PROFILE_URL = /(?<=linkedin\.com|["'(=\s>])\/in\/([^\s"'<>/?#&]+)/gi;
const PROFILE_URL_ENCODED = /(%2F)in\1([^\s"'<>&%/?#]+)/gi;
const DATA_MEMBER_ATTR = /(\bdata-[\w-]*(?:member|profile|person)[\w-]*id[\w-]*\s*=\s*)("[^"]*"|'[^']*'|[^\s>"']+)/gi;
const ENCODED_EMAIL = /[A-Z0-9._%+-]+(?:%40|&#0*64;|&#x0*40;|&commat;)[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const PLUS_PHONE = /(?<![\w.])\+\d{10,15}(?!\d)/g;
const TEL_ATTR = /(\bhref\s*=\s*(["'])\s*tel:)([^"']*)/gi;
const TEL_PLACEHOLDER = '+5511900000000';
const LICDN_URL = /(?:https?:)?\/\/(?:[\w-]+\.)*licdn\.com(?:[/?#][^\s"'()<>]*)?/gi;
const DATA_IMAGE = /data:image\/[^\s"'()<>]*/gi;
const DATA_IMAGE_LIMIT = 200;
const SESSION_TOKEN =
  /(\b(?:JSESSIONID|li_at|_csrf|authenticity[_-]?token|csrf[_-]?token|xsrf[_-]?token|x-csrf-token|session[_-]?id|access[_-]?token|id[_-]?token|auth[_-]?token)\b["']?\s*[=:]\s*["']?)([^;"'\s&<,]+)/gi;
const AJAX_TOKEN = /ajax:(\d+)/g;
const JWT = /\bey[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const ATTRIBUTE = /(\b(?:src|srcset|href|style)\s*=\s*)("[^"]*"|'[^']*')/gi;
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const INPUT_TAG = new RegExp(`<input\\b${TAG_BODY}>`, 'gi');
const META_TAG = new RegExp(`<meta\\b${TAG_BODY}>`, 'gi');
const TEXTAREA = new RegExp(`(<textarea\\b${TAG_BODY}>)[\\s\\S]*?(</textarea>)`, 'gi');
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'search', 'hidden', 'password']);
const SECRET_META_NAME = /csrf|xsrf|session|token|nonce/i;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Sem acento nem caixa. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  commat: '@', period: '.', lowbar: '_', hyphen: '-', colon: ':', sol: '/', plus: '+', num: '#', percnt: '%',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    const code = dec ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Entidades HTML e escapes de URL decodificados, para o que se escreve de um jeito poder ser lido de outro. */
function decodeEscapes(s: string): string {
  return decodeEntities(s)
    .replace(/\\u([0-9a-f]{4})/gi,(_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
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

function attributeValue(tag: string, name: string): string | null {
  const m = new RegExp(`(?<=[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function inputType(tag: string): string {
  return (attributeValue(tag, 'type') ?? 'text').trim().toLowerCase();
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
  out = out.replace(ENCODED_EMAIL, (m) => {
    const plain = decodeEscapes(m);
    return isExampleEmail(plain) ? m : PLACEHOLDER.email;
  });
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

  // 2. e-mails (também codificados)
  out = scrubEmails(out, identity);

  // 3. telefones (os do dono, os formatados, os internacionais sem formato e os de `tel:`)
  for (const phone of identity.phones) {
    const re = phoneRegexFor(phone);
    if (re) out = out.replace(re, PLACEHOLDER.phone);
  }
  out = out.replace(PHONE_PATTERN, PLACEHOLDER.phone);
  out = out.replace(PLUS_PHONE, (m) => (m === TEL_PLACEHOLDER ? m : PLACEHOLDER.phone));
  out = out.replace(TEL_ATTR, (_m, head: string) => `${head}${TEL_PLACEHOLDER}`);

  // 4. identificadores de membro
  out = out.replace(MEMBER_URN, (_m, type: string) => `urn:li:${type}:0`);
  out = out.replace(DATA_MEMBER_ATTR, (_m, head: string, value: string) => {
    const quote = value[0] === "'" ? "'" : '"';
    return `${head}${quote}0${quote}`;
  });

  // 5. endereços de perfil (também dentro de uma URL codificada)
  out = out.replace(PROFILE_URL, `/in/${PLACEHOLDER.slug}`);
  out = out.replace(PROFILE_URL_ENCODED, (_m, slash: string) => `${slash}in${slash}${PLACEHOLDER.slug}`);

  // 6. fotos
  out = out.replace(ATTRIBUTE, (_m, name: string, quoted: string) => {
    const quote = quoted[0];
    return `${name}${quote}${scrubAttributeValue(quoted.slice(1, -1))}${quote}`;
  });

  // Imagem embutida longa fora de atributo (CSS em bloco `style`): mesma regra das fotos.
  out = out.replace(DATA_IMAGE, (m) => (m.length > DATA_IMAGE_LIMIT ? PLACEHOLDER.pixel : m));

  // 7. campos preenchidos
  out = out.replace(INPUT_TAG, (tag) => {
    if (!TEXT_INPUT_TYPES.has(inputType(tag))) return tag;
    return tag.replace(/(?<=[\s"'])(value\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>"']*)/i, '$1""');
  });
  out = out.replace(TEXTAREA, '$1$2');

  // 8. sessão e tokens
  out = out.replace(META_TAG, (tag) => {
    const name = attributeValue(tag, 'name') ?? attributeValue(tag, 'http-equiv') ?? '';
    if (!SECRET_META_NAME.test(name)) return tag;
    return tag.replace(/(?<=[\s"'])(content\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>"']*)/i, '$1"ajax:0"');
  });
  out = out.replace(SESSION_TOKEN, '$1ajax:0');
  out = out.replace(JWT, 'ajax:0');
  out = out.replace(AJAX_TOKEN, 'ajax:0');

  return out;
}

function sampleOf(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function scan(text: string, kind: FixtureKind, add: (rule: Leak['rule'], sample: string) => void): void {
  for (const m of text.matchAll(EMAIL_PATTERN)) if (!isExampleEmail(m[0])) add('email', m[0]);
  if (kind === 'asset') return;

  for (const m of text.matchAll(PHONE_PATTERN)) if (m[0] !== PLACEHOLDER.phone) add('phone', m[0]);
  for (const m of text.matchAll(PLUS_PHONE)) if (m[0] !== TEL_PLACEHOLDER) add('phone', m[0]);
  for (const m of text.matchAll(TEL_ATTR)) {
    const value = m[3].trim();
    if (value !== TEL_PLACEHOLDER && value !== PLACEHOLDER.phone) add('phone', `tel:${value}`);
  }
  for (const m of text.matchAll(MEMBER_URN)) if (m[2] !== '0') add('member_id', m[0]);
  for (const m of text.matchAll(DATA_MEMBER_ATTR)) if (m[2].replace(/^["']|["']$/g, '') !== '0') add('member_id', `${m[1]}${m[2]}`);
  for (const m of text.matchAll(PROFILE_URL)) if (m[1] !== PLACEHOLDER.slug) add('profile_url', `/in/${m[1]}`);
  for (const m of text.matchAll(PROFILE_URL_ENCODED)) if (m[2] !== PLACEHOLDER.slug) add('profile_url', `${m[1]}in${m[1]}${m[2]}`);
  for (const m of text.matchAll(LICDN_URL)) add('photo', m[0]);
  for (const m of text.matchAll(DATA_IMAGE)) if (m[0].length > DATA_IMAGE_LIMIT) add('photo', m[0]);
  for (const m of text.matchAll(META_TAG)) {
    const name = attributeValue(m[0], 'name') ?? attributeValue(m[0], 'http-equiv') ?? '';
    const content = attributeValue(m[0], 'content');
    if (SECRET_META_NAME.test(name) && content && content !== 'ajax:0') add('token', m[0]);
  }
  for (const m of text.matchAll(SESSION_TOKEN)) if (m[2] !== 'ajax:0') add('token', `${m[1]}${m[2]}`.trim());
  for (const m of text.matchAll(JWT)) add('token', m[0]);
  for (const m of text.matchAll(AJAX_TOKEN)) if (m[1] !== '0') add('token', m[0]);
}

/**
 * O que as regras 2 a 6 e 8 deixariam passar, lido no texto como está e com entidades HTML e escapes de URL
 * decodificados. O próprio texto de substituição não conta.
 */
export function findLeaks(text: string, kind: FixtureKind = 'markup'): Leak[] {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const add = (rule: Leak['rule'], sample: string) => {
    const key = `${rule}\u0000${sample}`;
    if (seen.has(key)) return;
    seen.add(key);
    leaks.push({ rule, sample: sampleOf(sample) });
  };
  scan(text, kind, add);
  const decoded = decodeEscapes(text);
  if (decoded !== text) scan(decoded, kind, add);
  return leaks;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const MIN_WORD = 4;

/**
 * Conferência depois da limpeza: o nome, e-mail, telefone ou dado extra informado pelo dono ainda aparece no
 * texto (sem etiquetas, entidades e escapes de URL decodificados, espaços reduzidos, sem caixa nem acento)? Cada
 * palavra de nome com quatro letras ou mais também é procurada sozinha. Os dígitos de um telefone, em qualquer
 * ponto do arquivo. Só para `markup`.
 */
export function findIdentityLeaks(text: string, identity: ScrubIdentity): IdentityLeak[] {
  const leaks: IdentityLeak[] = [];
  const add = (sample: string) => {
    if (!leaks.some((l) => l.sample === sample)) leaks.push({ rule: 'identity', sample });
  };
  const view = (s: string) => collapse(fold(decodeEscapes(s)));
  const withTags = view(text);
  const textOnly = [view(text.replace(/<[^>]*>/g, '')), view(text.replace(/<[^>]*>/g, ' '))];

  for (const value of [...identity.names, ...identity.extra, ...identity.emails]) {
    const needle = collapse(fold(value));
    if (needle.length < 3) continue;
    if ([withTags, ...textOnly].some((v) => v.includes(needle))) add(value);
  }
  for (const name of identity.names) {
    for (const word of fold(name).match(/\p{L}+/gu) ?? []) {
      if (word.length < MIN_WORD) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u');
      if (textOnly.some((v) => re.test(v))) add(`${word} (de ${name})`);
    }
  }
  for (const phone of identity.phones) {
    const digits = digitsOf(phone);
    if (digits.length < 8) continue;
    const re = phoneRegexFor(phone);
    if (text.includes(digits) || (re && [withTags, ...textOnly].some((v) => new RegExp(re.source).test(v)))) add(phone);
  }
  return leaks;
}

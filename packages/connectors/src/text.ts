const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
};

/** Decodifica entidades numéricas (&#8211; &#x27;) e as nomeadas mais comuns. Desconhecidas ficam como estão. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? m;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return m;
    return code === 0xa0 ? ' ' : String.fromCodePoint(code);
  });
}

/**
 * Tira as tags e só então decodifica as entidades, para que `&lt;`/`&gt;` do texto não virem tags.
 * HTML que chega escapado por inteiro (Greenhouse) precisa de um `decodeEntities` antes.
 */
export function stripHtml(html: string): string {
  const noTags = html.replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return decodeEntities(noTags)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Minúsculas e sem acentos, para comparar texto. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Grafias alternativas → forma canônica. Vale tanto para o termo do usuário quanto para o texto da vaga. */
const ALIASES: Record<string, string> = {
  reactjs: 'react', 'react.js': 'react', 'react js': 'react',
  nodejs: 'node', 'node.js': 'node', 'node js': 'node',
  vuejs: 'vue', 'vue.js': 'vue', 'vue js': 'vue',
  nextjs: 'next.js', 'next js': 'next.js',
  golang: 'go',
  'asp.net': '.net', dotnet: '.net', 'dot net': '.net',
  postgresql: 'postgres',
};

// `#` e `+` contam como parte do termo à direita: `c` não casa com `C#` nem com `C++`.
const BEFORE = '(?<![a-z0-9])';
const AFTER = '(?![a-z0-9#+])';

const ALIAS_RE = new RegExp(
  `${BEFORE}(${Object.keys(ALIASES).sort((a, b) => b.length - a.length).map(escapeRe).join('|')})${AFTER}`,
  'g',
);

/** Texto pronto para comparação: sem acentos, minúsculo e com as grafias alternativas trocadas pela canônica. */
function canonicalText(text: string): string {
  return fold(text).replace(ALIAS_RE, (m) => ALIASES[m]);
}

/** Termo do usuário sem espaços sobrando, minúsculo, sem acentos e com a grafia canônica (`NodeJS` → `node`). */
export function canonicalTerm(term: string): string {
  const t = fold(term).trim().replace(/\s+/g, ' ');
  return ALIASES[t] ?? t;
}

/** Termos curtos demais (`go`, `r`, `c`) para procurar em texto corrido como a descrição. */
export function isShortTerm(term: string): boolean {
  return canonicalTerm(term).length <= 2;
}

function termRegExp(term: string): RegExp {
  let after = AFTER;
  if (term === 'go') after += '(?!-to)'; // go-to-market
  if (term.length === 1) after += '(?![&$])'; // R&D, R$
  return new RegExp(`${BEFORE}${escapeRe(term)}${after}`);
}

/** Verdadeiro se `term` aparece em `text` como termo inteiro (não como parte de outra palavra). */
export function hasTerm(text: string, term: string): boolean {
  const t = canonicalTerm(term);
  if (!t) return false;
  return termRegExp(t).test(canonicalText(text));
}

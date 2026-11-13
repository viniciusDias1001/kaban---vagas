/**
 * Funções de texto do verificador de não invenção: normalização, identidade de números e extração de
 * "termos" (nomes próprios, siglas, tokens técnicos). Tudo determinístico e sem rede.
 */

// ---------------------------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------------------------

/**
 * Letras cirílicas e gregas que se confundem com letras latinas. Conjunto coberto (maiúsculas e
 * minúsculas tratadas à parte, porque o desenho difere):
 * cirílico А В Е К М Н О Р С Т Х У І Ј Ѕ Ԁ / а е о р с х у і ј ѕ һ ԁ ԛ ԝ;
 * grego Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ / α ι κ ν ο ρ.
 * Outros alfabetos e sósias menos comuns não são cobertos.
 */
const CONFUSABLES: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S', Ԁ: 'D',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  α: 'a', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/** Valor de um dígito decimal de qualquer escrita: os blocos Unicode de dígitos são sequências 0..9. */
function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return ch;
  let back = 0;
  while (back < 60 && /\p{Nd}/u.test(String.fromCodePoint(cp - back - 1))) back++;
  return String(back % 10);
}

/**
 * Forma canônica para comparar: NFKC (dígitos e letras de largura total, sobrescritos, ligaduras), sem
 * caracteres de formato (largura zero, hífen invisível, marcas e overrides de direção, BOM, seletores de
 * variação), todo espaço Unicode vira espaço comum e todo dígito decimal vira ASCII.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cf}\uFE00-\uFE0F\u034F]/gu, '')
    .replace(/[\p{Zs}\u2028\u2029]/gu, ' ')
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(/[‘’ʼ´`]/g, "'");
}

/** Normalizado, sem sósias cirílicos/gregos, sem acentos e em minúsculas. */
export function foldText(text: string): string {
  return normalizeText(text)
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** NUL, controles C0/C1 (menos tab e quebras de linha) e overrides de direção: nada disso entra em texto gerado. */
export const hasControlChars = (text: string): boolean =>
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(text);

// ---------------------------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------------------------

const CURRENCY: Record<string, string> = {
  r$: 'BRL', brl: 'BRL', real: 'BRL', reais: 'BRL',
  us$: 'USD', $: 'USD', usd: 'USD', dolar: 'USD', dolares: 'USD', dollar: 'USD', dollars: 'USD',
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP', libra: 'GBP', libras: 'GBP', pound: 'GBP', pounds: 'GBP',
};
const MAGNITUDE: Record<string, number> = {
  mil: 1e3, k: 1e3, thousand: 1e3,
  m: 1e6, mi: 1e6, mm: 1e6, milhao: 1e6, milhoes: 1e6, million: 1e6, millions: 1e6,
  bi: 1e9, bn: 1e9, bilhao: 1e9, bilhoes: 1e9, billion: 1e9, billions: 1e9,
  tri: 1e12, trilhao: 1e12, trilhoes: 1e12, trillion: 1e12, trillions: 1e12,
};

const CUR_PREFIX = String.raw`(?:(us\$|r\$|\$|€|£|usd|brl|eur|gbp) ?)?`;
const NUM = String.raw`(\d{4}-\d{1,2}(?:-\d{1,2})?(?![\d\p{L}])|\d{1,2}\/\d{1,2}\/\d{4}(?!\d)|\d{1,2}\/\d{4}(?!\d)|\d+(?:[.,]\d+)*)`;
const MAG_WORDS = String.raw`mil|k|thousand|mm|mi|m|milh(?:ão|ao|ões|oes)|millions?|bi|bn|bilh(?:ão|ao|ões|oes)|billions?|tri|trilh(?:ão|ao|ões|oes)|trillions?`;
const SUFFIX =
  String.raw`(?: ?(%|por cento|percent)(?![\p{L}\p{N}])| ?(${MAG_WORDS}|x)(?![\p{L}\p{N}])|([ºª]|\p{L}{1,4})(?![\p{L}\p{N}]))?`;
const CUR_SUFFIX = String.raw`(?: (?:de )?(reais|real|d[oó]lar(?:es)?|dollars?|euros?|libras?|pounds?|usd|brl|eur|gbp)(?![\p{L}\p{N}]))?`;
const NUMBER_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])${CUR_PREFIX}${NUM}${SUFFIX}(?![\p{L}\p{N}])${CUR_SUFFIX}`, 'giu');

const ORDINAL = new Set(['º', 'ª', 'o', 'a', 'os', 'as', 'st', 'nd', 'rd', 'th']);

/** "1.000" e "1,000" → "1000"; "1,5" → "1.5"; "12.345,67" → "12345.67"; "1.50" → "1.5". */
function canonicalValue(raw: string): string {
  let v: string;
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) v = raw.replace(/[.,]/g, '');
  else if (raw.includes('.') && raw.includes(',')) {
    const decimal = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
    const [int, frac] = [raw.slice(0, raw.lastIndexOf(decimal)), raw.slice(raw.lastIndexOf(decimal) + 1)];
    v = `${int.replace(/[.,]/g, '')}.${frac}`;
  } else v = raw.replace(',', '.');
  if (/^\d+\.\d+$/.test(v)) v = v.replace(/0+$/, '').replace(/\.$/, '');
  return v;
}

const scale = (value: string, factor: number): string => {
  const n = Number(value) * factor;
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : `${value}e${Math.log10(factor)}`;
};

const WORD_VALUES: Record<string, number> = {
  dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
  quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200,
  duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500,
  seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900,
  novecentas: 900, mil: 1000,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};
/** Só valem como unidade DENTRO de um número composto ("vinte e um", "twenty-one"); sozinhas são artigos. */
const UNIT_ONE = new Set(['um', 'uma', 'one']);
const CONNECTORS = new Set(['e', 'and']);
/** Quantidades vagas: têm de existir (com o mesmo sentido) no texto de origem. */
const QUANTIFIERS: Record<string, string> = {
  dezenas: 'tens', dozens: 'tens', tens: 'tens', centenas: 'hundreds', hundreds: 'hundreds', milhares: 'thousands',
  thousands: 'thousands', milhao: 'millions', milhoes: 'millions', million: 'millions', millions: 'millions',
  bilhao: 'billions', bilhoes: 'billions', billion: 'billions', billions: 'billions', decada: 'decade', decadas: 'decade',
  decade: 'decade', decades: 'decade', duzia: 'dozen', duzias: 'dozen', dozen: 'dozen',
};

/** Números por extenso (pt/en) de uma lista de palavras já dobradas: "dois mil e dezoito" → 2018. */
function wordedNumbers(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const first = WORD_VALUES[words[i]];
    if (first === undefined || (words[i] === 'cento' && words[i - 1] === 'por')) {
      const q = QUANTIFIERS[words[i]];
      if (q) out.push(`q:${q}`);
      i++;
      continue;
    }
    let total = 0;
    let current = 0;
    let prev = 0;
    const take = (v: number, isMultiplier: boolean) => {
      if (isMultiplier && v === 1000) {
        total += (current || 1) * 1000;
        current = 0;
      } else if (isMultiplier) current = (current || 1) * 100;
      else current += v;
      prev = v;
    };
    const isMult = (w: string) => w === 'hundred' || w === 'thousand' || w === 'mil';
    take(first, isMult(words[i]));
    i++;
    for (;;) {
      let j = i;
      const viaConnector = CONNECTORS.has(words[j] ?? '');
      if (viaConnector) j++;
      const word = words[j] ?? '';
      const v = WORD_VALUES[word] ?? (UNIT_ONE.has(word) ? 1 : undefined);
      if (v === undefined) break;
      const mult = isMult(word);
      // "two hundred", "dois mil": multiplicador maior que o anterior, sem conector.
      // "vinte e cinco", "twenty five", "mil e dezoito": parte menor depois de dezena/centena/milhar.
      const ok = mult ? !viaConnector && v > prev : prev >= 20 && v < prev;
      if (!ok) break;
      take(v, mult);
      i = j + 1;
    }
    out.push(String(total + current));
  }
  return out;
}

export interface NumberScan {
  /** Identidades canônicas, sem repetição. */
  ids: string[];
  /** Trechos `[início, fim)` do texto normalizado ocupados por números (o extrator de termos os pula). */
  spans: [number, number][];
}

/**
 * Identidade de cada número de um texto. O que faz parte da identidade:
 * - o valor, já multiplicado pela magnitude ("3 mil" = "3.000" = "3k" → `3000`; "1,5 milhão" → `1500000`);
 * - `%` (também "por cento"/"percent") e `x` como sufixo (`40%`, `40x` ≠ `40`);
 * - a moeda, por símbolo ou por palavra (`BRL1500000`: "R$ 1,5 milhão" = "1.5 million reais" ≠ "$1.5 million");
 * - uma unidade colada ao número (`24h`, `40km`);
 * - datas numéricas viram `d:AAAA-M` ("2021-03", "03/2021", "15/03/2021");
 * - números por extenso viram o valor ("trinta" → `30`, "dois mil e dezoito" → `2018`); quantidades vagas
 *   ("dezenas", "thousands", "década") viram `q:...`.
 * Ordinais ("1º", "3rd") contam pelo valor. Um número grudado depois de letra ("B2B", "ES6", "v2") não é
 * número: é token técnico, conferido pelo extrator de termos.
 */
export function scanNumbers(text: string): NumberScan {
  const norm = normalizeText(text);
  const ids = new Set<string>();
  const spans: [number, number][] = [];
  let rest = '';
  let last = 0;
  for (const m of norm.matchAll(NUMBER_RE)) {
    const [whole, curBefore, raw, percent, magnitude, attached, curAfter] = m;
    const start = m.index;
    spans.push([start, start + whole.length]);
    rest += `${norm.slice(last, start)} `;
    last = start + whole.length;
    const date = /^(\d{4})-(\d{1,2})/.exec(raw) ?? /^(?:\d{1,2}\/)?(\d{1,2})\/(\d{4})$/.exec(raw);
    if (date) {
      const [year, month] = raw.includes('-') ? [date[1], date[2]] : [date[2], date[1]];
      ids.add(`d:${year}-${Number(month)}`);
      continue;
    }
    const fold = (s: string | undefined) => (s ? foldText(s) : '');
    const currency = CURRENCY[fold(curBefore)] ?? CURRENCY[fold(curAfter)] ?? '';
    let value = canonicalValue(raw);
    let suffix = '';
    if (percent) suffix = '%';
    else if (magnitude) {
      const mag = fold(magnitude);
      if (mag === 'x') suffix = 'x';
      else value = scale(value, MAGNITUDE[mag]);
    } else if (attached && !ORDINAL.has(attached.toLowerCase())) suffix = fold(attached);
    ids.add(`${currency}${value}${suffix}`);
  }
  rest += norm.slice(last);
  for (const id of wordedNumbers(foldText(rest).match(/[a-z]+/g) ?? [])) ids.add(id);
  return { ids: [...ids], spans };
}

export const numberIds = (text: string): string[] => scanNumbers(text).ids;

/** Identidade sem unidade colada e sem mês: a tradução pode escrever "24 hours" por "24h" e "March 2021" por "03/2021". */
export function looseNumberId(id: string): string {
  const date = /^d:(\d{4})-/.exec(id);
  if (date) return date[1];
  if (id.startsWith('q:')) return id;
  return id.replace(/(?<=\d)(?!x$)[a-z]+$/, '');
}

/** Conjunto permitido a partir de textos de origem. Uma data `d:2021-3` também libera o ano `2021`. */
export function allowedNumbers(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const id of numberIds(text)) {
      out.add(id);
      const date = /^d:(\d{4})-/.exec(id);
      if (date) out.add(date[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Termos
// ---------------------------------------------------------------------------------------------

/** Palavras que nunca são "termo novo": meses, dias, países/idiomas de uso neutro, abreviações de prosa. */
const GENERIC = new Set(
  (
    'janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro jan fev mar abr mai jun jul ago ' +
    'set out nov dez january february march april may june july august september october november december feb apr aug sep ' +
    'sept oct dec segunda terca quarta quinta sexta sabado domingo monday tuesday wednesday thursday friday saturday sunday ' +
    'brasil brazil br eua usa us uk eu ue pt en ti it e.g i.e p.ex etc ex vs n/a ok s.a ltda cv pj clt ' +
    'eu i we nos'
  ).split(' '),
);

/** Siglas e nomes equivalentes (inclusive entre português e inglês). Cada linha é um grupo. */
const ALIAS_GROUPS: string[][] = [
  ['js', 'javascript'], ['ts', 'typescript'], ['postgres', 'postgresql'], ['k8s', 'kubernetes'], ['go', 'golang'],
  ['dotnet', '.net', 'net'], ['mongo', 'mongodb'], ['vue', 'vuejs'], ['gcp', 'google cloud'], ['aws', 'amazon web services'],
  ['ia', 'ai', 'inteligencia artificial', 'artificial intelligence'], ['ti', 'it', 'tecnologia da informacao', 'information technology'],
  ['rh', 'hr', 'recursos humanos', 'human resources'], ['ml', 'machine learning', 'aprendizado de maquina'],
  ['pln', 'nlp', 'processamento de linguagem natural', 'natural language processing'], ['ong', 'ngo'], ['pme', 'sme', 'smb'],
  ['qa', 'quality assurance', 'garantia de qualidade'], ['ui', 'user interface', 'interface de usuario'],
  ['ux', 'user experience', 'experiencia do usuario'], ['ci', 'continuous integration', 'integracao continua'],
  ['cd', 'continuous delivery', 'continuous deployment', 'entrega continua'], ['bi', 'business intelligence'],
  ['p&d', 'r&d'],
];
const ALIASES = new Map<string, string[]>();
for (const group of ALIAS_GROUPS) for (const name of group) ALIASES.set(name, [...(ALIASES.get(name) ?? []), ...group.filter((g) => g !== name)]);

/**
 * Nomes conhecidos de tecnologias, empresas e instituições, conferidos em QUALQUER caixa (pega
 * "especialista em kubernetes e aws"). Só entram nomes que não são palavra comum em português ou inglês
 * (por isso "go", "meta", "apple", "rust", "spring", "react" ficam de fora: esses só são pegos com maiúscula).
 */
const NAMED = new Set(
  (
    'kubernetes k8s docker aws azure gcp terraform ansible jenkins python java javascript typescript golang kotlin scala php ' +
    'laravel angular svelte nodejs django graphql postgres postgresql mysql mongodb redis kafka rabbitmq elasticsearch hadoop ' +
    'airflow snowflake databricks tableau powerbi salesforce figma linux github gitlab jira scrum kanban tensorflow pytorch ' +
    'openai flutter android ios sql nosql html css webpack cypress selenium playwright cobol fortran matlab ' +
    'google amazon microsoft facebook netflix tesla ibm nubank itau ifood spotify linkedin harvard stanford mit usp unicamp'
  ).split(' '),
);

/** Palavras que afirmam cargo ou formação: se não estão no perfil, são promoção ou diploma inventado. */
const CLAIMS = new Set(
  (
    'senior sr phd doutor doutora doutorado doctorate mestrado mba bacharel bacharelado bachelor cto ceo cfo coo cio vp ' +
    'fundador fundadora cofundador cofundadora founder cofounder diretor diretora director'
  ).split(' '),
);

/** Palavras sem conteúdo (pt/en): não contam para "o texto tem relação com a origem" nem como palavra-chave da vaga. */
export const STOPWORDS = new Set(
  (
    'a o as os um uma uns umas de da do das dos em no na nos nas por para com sem sob sobre entre ate apos desde e ou mas que ' +
    'se como mais menos muito muita pouco ao aos pela pelo pelas pelos este esta esse essa isso aquilo seu sua seus suas meu ' +
    'minha foi era ser estar tem ter the an and or but of in on at to for with without from by as is are was were be been ' +
    'this that these those it its my our your their more most less very into over under than then also not no yes ' +
    'vaga job work trabalho experiencia experience pessoa pessoas people person time team equipe equipes teams remoto remote ' +
    'hibrido hybrid presencial onsite projeto projetos project projects area areas empresa company software sistemas sistema ' +
    'systems system web digital tecnologia technology solucoes solutions desenvolvimento development produto product produtos ' +
    'products servicos services plataforma platform aplicacoes applications foco focus anos ano years year meses months novo ' +
    'nova new alto alta high grande large junior jr pleno mid level nivel i ii iii iv'
  ).split(' '),
);

/** Radical grosseiro: tira plural e a vogal final ("desenvolvedora"/"desenvolvedores" → "desenvolvedor"). */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 4 && /[aoe]$/.test(w)) w = w.slice(0, -1);
  return w;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.&'-]*/gu;
const trimToken = (t: string) => t.replace(/'s$/i, '').replace(/[.'&-]+$/, '');
const squash = (t: string) => t.replace(/[.'-]/g, '');

export interface TermIndex {
  tokens: Set<string>;
  stems: Set<string>;
  /** Texto dobrado, só com letras/dígitos separados por um espaço, com espaço nas pontas (busca de frases). */
  phrase: string;
}

const phraseOf = (folded: string) => ` ${folded.replace(/[^a-z0-9+#]+/g, ' ').trim()} `;

/** Índice dos termos que existem na origem (perfil), com as variantes que um leitor atento aceitaria. */
export function buildTermIndex(texts: Iterable<string>): TermIndex {
  const tokens = new Set<string>();
  const stems = new Set<string>();
  const folded: string[] = [];
  const add = (t: string) => {
    if (!t) return;
    tokens.add(t);
    if (/^[a-z]+$/.test(t)) stems.add(stem(t));
    if (t.length > 3 && t.endsWith('js')) tokens.add(t.slice(0, -2)); // "nodejs" libera "node"
    if (/^[a-z]{3,}s$/.test(t)) tokens.add(t.slice(0, -1)); // "apis" libera "api"
  };
  for (const text of texts) {
    const f = foldText(text);
    folded.push(f);
    for (const raw of f.match(TOKEN_RE) ?? []) {
      const t = trimToken(raw);
      add(t);
      add(squash(t));
      for (const part of t.split(/[.'&/-]/)) add(part);
    }
  }
  return { tokens, stems, phrase: phraseOf(folded.join(' . ')) };
}

/** O termo (já dobrado) existe na origem? Aceita "Node.js"/"NodeJS"/"Node", plural, gênero e os grupos de siglas. */
export function isKnownTerm(term: string, index: TermIndex): boolean {
  const simple = (t: string): boolean => {
    if (!t) return true;
    if (index.tokens.has(t) || index.tokens.has(squash(t))) return true;
    const s = squash(t);
    if (s.length > 3 && s.endsWith('js') && index.tokens.has(s.slice(0, -2))) return true;
    if (index.tokens.has(`${s}js`)) return true;
    if (/^[a-z]+$/.test(t) && t.length >= 4 && index.stems.has(stem(t))) return true;
    if (/^[a-z]{2,}s$/.test(t) && index.tokens.has(t.slice(0, -1))) return true; // "apis" → "api"
    for (const alias of [...(ALIASES.get(t) ?? []), ...(ALIASES.get(s) ?? [])]) {
      if (alias.includes(' ') ? index.phrase.includes(` ${alias} `) : index.tokens.has(alias)) return true;
    }
    return false;
  };
  if (simple(term)) return true;
  const parts = term.split(/[.'&/-]/).filter(Boolean);
  return parts.length > 1 && parts.every((p) => p.length < 2 || GENERIC.has(p) || STOPWORDS.has(p) || simple(p));
}

type Shape = 'technical' | 'acronym' | 'capitalised' | 'plain';

function shapeOf(token: string): Shape {
  const letters = token.replace(/[^\p{L}]/gu, '');
  if (!letters) return 'plain';
  if (/\p{N}/u.test(token) || /[+#&]/.test(token) || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(token) || /\p{Ll}\p{Lu}/u.test(token)) return 'technical';
  if (letters.length >= 2 && (/^\p{Lu}+$/u.test(letters) || /^\p{Lu}{2,}s$/u.test(letters))) return 'acronym';
  if (/^\p{Lu}/u.test(token)) return 'capitalised';
  return 'plain';
}

export interface TermOptions {
  /**
   * `full` (texto no mesmo idioma da origem): também palavras com inicial maiúscula fora do começo de frase e
   * palavras de cargo/formação. `shapes` (tradução): só tokens técnicos, siglas e nomes conhecidos, porque
   * o título em inglês capitaliza palavras comuns e os nomes de curso e de idioma mudam ao traduzir.
   */
  mode: 'full' | 'shapes';
}

/**
 * Termos do texto que não existem na origem. Candidatos: token técnico (com dígito, `+`, `#`, `&`, ponto
 * interno ou CamelCase), sigla de 2+ maiúsculas, nome conhecido (lista NAMED, em qualquer caixa) e, no
 * modo `full`, palavra com inicial maiúscula que não abre a frase e palavras de cargo/formação (CLAIMS).
 */
export function novelTerms(text: string, index: TermIndex, opts: TermOptions): string[] {
  const norm = normalizeText(text);
  const { spans } = scanNumbers(text);
  const inNumber = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  const out = new Map<string, string>();
  for (const m of norm.matchAll(TOKEN_RE)) {
    if (inNumber(m.index)) continue;
    const whole = trimToken(m[0]);
    if (!whole || /^[\d.,'-]+$/.test(whole)) continue;
    const rawBefore = norm.slice(0, m.index);
    const lineStart = /(^|\n)[ \t"'“”«»([{*_•·–—-]*$/.test(rawBefore);
    const initial = lineStart || /[.!?]$/.test(rawBefore.replace(/[\s"'“”«»([{*_–—-]+$/u, ''));
    if (isKnownTerm(foldText(whole), index)) continue;
    // Token com hífen ou barra que não existe inteiro: cada parte é conferida sozinha.
    const parts = whole.split(/[-/]/).filter(Boolean);
    parts.forEach((part, i) => {
      const folded = foldText(part);
      if (folded.length < 2 || GENERIC.has(folded) || /^\d+$/.test(folded)) return;
      const shape = shapeOf(part);
      const listed = NAMED.has(folded) || NAMED.has(squash(folded)) || (opts.mode === 'full' && (CLAIMS.has(folded) || CLAIMS.has(stem(folded))));
      const candidate =
        shape === 'technical' || shape === 'acronym' || listed ||
        (opts.mode === 'full' && shape === 'capitalised' && !(initial && i === 0));
      if (candidate && !isKnownTerm(folded, index)) out.set(folded, part);
    });
  }
  return [...out.values()];
}

/** Palavras de conteúdo (radicais) de um texto: para saber se dois textos falam da mesma coisa. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of foldText(text).match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) out.add(stem(word));
  }
  return out;
}

/** Sequência de tokens dobrados de um texto, para casar nomes em fronteira de palavra. */
export const foldedWords = (text: string): string[] => foldText(text).match(/[a-z0-9+#]+/g) ?? [];

/** A frase (tokens dobrados) aparece no texto em fronteira de palavra? Devolve os índices onde começa. */
export function findPhrase(words: string[], phrase: string[]): number[] {
  const hits: number[] = [];
  if (phrase.length === 0) return hits;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((p, k) => words[i + k] === p)) hits.push(i);
  }
  return hits;
}

/** O termo (já dobrado) está nas listas internas de nomes conhecidos e de palavras de cargo/formação? */
export function isListedName(folded: string): boolean {
  return NAMED.has(folded) || NAMED.has(squash(folded)) || CLAIMS.has(folded) || CLAIMS.has(stem(folded));
}

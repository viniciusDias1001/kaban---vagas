import { optionKey, type AnswerValue, type CandidateProfile, type Question, type Violation } from '@kv/shared';
import {
  STOPWORDS, allowedNumbers, buildTermIndex, foldText, hasControlChars, isKnownTerm, isListedName, novelTerms, numberIds,
} from './text';
import { numericTexts, profileTexts } from './verify';

/**
 * Últimas barreiras antes de uma resposta escrita pelo modelo ser digitada numa candidatura em nome do dono. Na dúvida
 * as duas recusam: uma resposta recusada volta ao dono como pergunta pendente, e isso é sempre melhor que afirmar
 * mais do que o perfil sustenta.
 */

/** Teto de uma resposta quando o formulário não informa `maxLength`. */
const DEFAULT_MAX_CHARS = 2_000;
/** Ids citados por resposta e teto da descrição da vaga que entra na conferência de termos. */
const MAX_BASIS = 50;
const JOB_TEXT_CHARS = 20_000;
/** Número que acompanha "anos"/"years" e passa disso não é uma quantidade de anos (ex.: um ano-calendário). */
const MAX_YEARS_CLAIM = 60;

const MONTH = /^(\d{4})-(\d{1,2})$/;
const MONTH_SLASH = /^(\d{1,2})\/(\d{4})$/;
const YEAR = /^(\d{4})$/;

/**
 * Índice do mês (ano × 12 + mês) de uma data do perfil. Só o ano nunca soma tempo que não está escrito: um início
 * vale dezembro e um fim vale janeiro desse ano.
 */
function monthIndex(raw: string, role: 'start' | 'end'): number | null {
  const text = raw.trim();
  const ym = MONTH.exec(text);
  const my = MONTH_SLASH.exec(text);
  const parts = ym ? [Number(ym[1]), Number(ym[2])] : my ? [Number(my[2]), Number(my[1])] : null;
  if (parts) return parts[1] >= 1 && parts[1] <= 12 ? parts[0] * 12 + parts[1] - 1 : null;
  const y = YEAR.exec(text);
  return y ? Number(y[1]) * 12 + (role === 'start' ? 11 : 0) : null;
}

const nowIndex = (now: number) => {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * Anos cobertos pela união dos períodos das experiências citadas (fim vazio = `now`), arredondados para BAIXO: 5 anos e
 * 4 meses são 5, nunca 6. Períodos que se sobrepõem contam uma vez; id inexistente, data ilegível, período invertido ou
 * no futuro contam zero.
 */
export function yearsCovered(profile: CandidateProfile, experienceIds: string[], now: number): number {
  const current = nowIndex(now);
  const cited = new Set(experienceIds);
  const spans: [number, number][] = [];
  for (const e of profile.experiences) {
    if (!cited.has(e.id)) continue;
    const start = monthIndex(e.start, 'start');
    const end = e.end.trim() === '' ? current : monthIndex(e.end, 'end');
    if (start === null || end === null) continue;
    const to = Math.min(end, current);
    if (to > start) spans.push([start, to]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let reach = -Infinity;
  for (const [from, to] of spans) {
    months += Math.max(0, to - Math.max(from, reach));
    reach = Math.max(reach, to);
  }
  return Math.floor(months / 12);
}

/** Quantidades de anos que um texto afirma ("5+ anos", "cinco years", "3-5 anos"): todo número do texto, se ele fala de anos. */
function yearClaims(text: string): number[] {
  if (!/\b(anos?|years?|yrs?)\b/i.test(text)) return [];
  return numberIds(text).filter((id) => /^\d+$/.test(id)).map(Number).filter((n) => n <= MAX_YEARS_CLAIM);
}

/** Só pergunta de anos DE EXPERIÊNCIA (ou de trabalho) recebe número: "anos ... experiência" ou "experiência ... anos". */
const YEARS_OF_EXPERIENCE = new RegExp(
  '\\b(anos?|years?|yrs?|tempo|time)\\b[^.?!\\n]{0,40}\\b(experiencia|experience|trabalh\\w*|work\\w*|atuacao|carreira)\\b|' +
    '\\b(experiencia|experience)\\b[^.?!\\n]{0,40}\\b(anos?|years?|yrs?)\\b',
);

// ---------------------------------------------------------------------------------------------
// Vocabulário de `verifyProfileFact`. Listas fixas deste arquivo; o STOPWORDS de text.ts NÃO entra aqui, porque nele há
// palavras que numa pergunta de formulário carregam conteúdo (remoto, presencial, equipe, júnior...).
// ---------------------------------------------------------------------------------------------

/**
 * Palavras funcionais (pt/en, sem acento): artigos, preposições, conjunções, pronomes, verbos auxiliares e de ligação e
 * palavras interrogativas. Ficam DE FORA, de propósito, as que mudam o sentido de uma afirmação: negações (não, sem, nem,
 * not, no em inglês é "no" do português e fica), comparativos (mais, menos, até, acima, more, less, than, over, under).
 */
const FUNCTION_WORDS = new Set(
  (
    'a o as os um uma uns umas de da do das dos em no na nos nas num numa nuns numas por pela pelo pelas pelos para pra pro ' +
    'com sob sobre entre apos desde contra durante perante ao aos ' +
    'e ou mas porem que se como porque pois quando onde ' +
    'eu tu ele ela eles elas vos me te lhe lhes meu minha meus minhas teu tua teus tuas seu sua seus suas nosso nossa nossos ' +
    'nossas dele dela deles delas este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo ' +
    'sou es somos sao era eram foi foram fui sera seria estar estou estao estava estavam ser ha havia haver faz fez ' +
    'qual quais quanto quanta quantos quantas quem cujo cuja ' +
    'an the of in on at to for with from by as into onto about and or but that which what who whom whose when where why how ' +
    'many much is are was were be been being am do does did have has had having will would shall should can could may might ' +
    'must i he she it we they him her us them my his its our their this these those there here if then so'
  ).split(' '),
);

/** Moldura de pergunta: palavras com que o formulário pergunta e que não afirmam nada. */
const SCAFFOLD_WORDS = new Set(
  (
    'possui possuir possuo possua tem ter tenho tens tinha teve tido voce voces vc vcs you your ' +
    'experiencia experiencias experience experiences anos ano years year yrs yr nivel niveis level levels tempo time ' +
    'trabalha trabalham trabalhou trabalho trabalhar trabalhando trabalhado trabalhei work works worked working ' +
    'conhecimento conhecimentos knowledge conhece conhecer'
  ).split(' '),
);

const NEGATION = /\b(nao|not|never|nunca|nenhum|nenhuma|none|without|sem|nem|nor|neither|jamais|nada|nothing)\b|n't\b/;
/** Opção que é exatamente um "não" simples ou zero: é uma negação. */
const NEGATIVE_OPTION = /^(0|nao|no|nenhum|nenhuma|none|never|nunca)$/;
/** Palavra de negação em qualquer lugar de uma opção a torna uma negação ("No experience", "Não tenho"). */
const OPTION_NEGATION = new Set('nao no not nenhum nenhuma none never nunca sem without'.split(' '));
const YES_OPTION = /^(sim|yes)$/;
const COMPLETION = /\b(complet[oa]s?|concluid[oa]s?|formad[oa]s?|complete|completed|concluded|finished|graduated)\b/;
const YEAR_WORD = /\b(anos?|years?|yrs?)\b/;
const NUMBER_WORD = /\b(um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|one|two|three|four|five|six|seven|eight|nine|ten)\b/;
/** Token de número, faixa ou "+": "3", "2+", "3-5". */
const NUMBER_TOKEN = /^\d+(?:-\d+)*\+?$|^\+$/;

/** Plural e gênero dobrados: "remotos"/"remota" → "remot", "inglês"/"inglesa" → "ingl". Token com dígito, + ou # fica como está. */
function foldWord(word: string): string {
  if (/[^a-z]/.test(word)) return word;
  let current = word;
  let previous = '';
  while (current !== previous) {
    previous = current;
    if (current.length > 4 && /oes$|aes$/.test(current)) current = `${current.slice(0, -3)}ao`;
    else if (current.length > 4 && /ais$/.test(current)) current = `${current.slice(0, -3)}al`;
    else if (current.length > 4 && /eis$/.test(current)) current = `${current.slice(0, -3)}el`;
    else if (current.length > 4 && /[rzls]es$/.test(current)) current = current.slice(0, -2);
    else if (current.length > 3 && /[^su]s$/.test(current)) current = current.slice(0, -1);
    else if (current.length > 3 && /[ao]$/.test(current)) current = current.slice(0, -1);
  }
  return current;
}

/** Um token: suas partes já dobradas. Composto com hífen ou barra ("pós-graduação", "ci/cd") é UM token de várias partes. */
type Token = { raw: string; parts: string[] };

function tokenize(text: string): Token[] {
  const folded = foldText(text.replace(/[\u2010-\u2015\u2212]/g, '-')); // travessões e menos viram hífen: "3–5" = "3-5"
  return (folded.match(/[a-z0-9+#]+(?:[-/][a-z0-9+#]+)*/g) ?? []).map((raw) => ({ raw, parts: raw.split(/[-/]/).map(foldWord) }));
}

/** Radicais de conteúdo: tokens sem palavras funcionais e (salvo `keepScaffold`) sem palavras de moldura. */
function contentTokens(text: string, keepScaffold = false): Token[] {
  return tokenize(text).filter((t) => !FUNCTION_WORDS.has(t.raw) && (keepScaffold || !SCAFFOLD_WORDS.has(t.raw)));
}

/** Um item do perfil: o texto que ele afirma (campos separados) e, para formação e experiência, o fim. */
type Item = { id: string; kind: 'experience' | 'achievement' | 'education' | 'other'; texts: string[]; fields: Token[][]; end: string | null };

function profileItems(profile: CandidateProfile): Item[] {
  const item = (id: string, kind: Item['kind'], texts: string[], end: string | null = null): Item =>
    ({ id, kind, texts, fields: texts.map(tokenize), end });
  return [
    ...profile.experiences.flatMap((e) => [
      item(e.id, 'experience', [e.title, e.company, ...e.achievements.map((a) => a.text)], e.end),
      ...e.achievements.map((a) => item(a.id, 'achievement', [a.text])),
    ]),
    ...profile.education.map((e) => item(e.id, 'education', [e.degree, e.institution], e.end)),
    ...profile.skills.map((s) => item(s.id, 'other', [s.name])),
    ...profile.languages.map((l) => item(l.id, 'other', [l.name, l.level])),
    ...profile.certifications.map((c) => item(c.id, 'other', [c.name, c.issuer])),
    // Um link existe no perfil, mas não afirma nada: citá-lo não sustenta resposta.
    ...profile.links.map((l) => item(l.id, 'other', [])),
  ];
}

const sameParts = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * O campo afirma o token, palavra inteira: token simples casa com token simples igual; composto casa com o mesmo composto
 * ou com as mesmas palavras em sequência ("pós graduação" no item sustenta "pós-graduação"). Uma parte de composto não
 * sustenta palavra solta ("pós-venda" não sustenta "pós").
 */
function fieldHas(field: Token[], token: Token): boolean {
  const n = token.parts.length;
  return field.some((t, i) => sameParts(t.parts, token.parts) ||
    (n > 1 && i + n <= field.length && token.parts.every((p, k) => sameParts(field[i + k].parts, [p]))));
}

const itemHasAll = (item: Item, tokens: Token[]) => tokens.every((t) => item.fields.some((f) => fieldHas(f, t)));

type Checked = { ok: true; value: AnswerValue } | { ok: false; why: string };
const fail = (why: string): Checked => ({ ok: false, why });

/**
 * Confere uma resposta factual do modelo, que será enviada sem o dono ver, contra o perfil. Tudo o que estas regras
 * não aceitam é recusado (a pergunta volta ao dono uma vez; o banco de respostas guarda a resposta dele).
 *
 * Vocabulário: radicais de conteúdo = tokens sem palavras funcionais e de moldura (listas deste arquivo), em minúsculas,
 * sem acento, com plural e gênero dobrados; composto com hífen ou barra é um token. Texto de um item: experiência =
 * título, empresa e conquistas; conquista citada = seu texto; formação = curso e instituição; habilidade = nome;
 * idioma = nome e nível; certificação = nome e emissor; link = nada.
 *
 * - Sempre recusa: id de `basis` fora do perfil; pergunta com negação; `multiselect`, `date`, `file`.
 * - Afirmação (`true`; opção que não é um "não" simples): `basis` não vazio; a pergunta tem radicais e não afirma anos;
 *   UM item citado contém todos os radicais da pergunta e da opção (sem números, faixas, "+" e palavras de ano). Opção com
 *   anos: o limite de baixo não passa dos anos da regra de números. "Completo/concluído/formado" só com item de formação
 *   ou experiência terminado (fim legível e passado). Formação não terminada nunca sustenta nada. Opção sem palavra de
 *   conteúdo só passa se, reduzida às palavras, é exatamente "sim"/"yes".
 * - Negação (`false`; opção que, reduzida às palavras, é "0"/"não"/"nenhum"..., ou que tem palavra de negação em
 *   qualquer lugar, ou cujos anos começam em zero; número 0): sempre recusada. Um "não" errado tira o dono de uma vaga
 *   que lhe serve, e nenhuma conferência de palavras o garante: o dono responde uma vez e o banco de respostas guarda.
 * - Número: só pergunta de anos de experiência; inteiro n entre 0 e `yearsCovered` das experiências citadas que contêm
 *   todos os radicais da pergunta (sem radicais, todas as citadas); n = 0 é uma negação.
 * - Texto: `basis` não vazio; UM item citado contém todas as palavras da resposta (só as funcionais saem) e todos os seus
 *   números; cabe em `maxLength`.
 */
export function verifyProfileFact(
  profile: CandidateProfile,
  question: Question,
  fact: { answer: string; basis: string[] },
  now: number = Date.now(),
): Checked {
  const basis = [...new Set(fact.basis)];
  if (basis.length > MAX_BASIS) return fail('itens demais citados');
  const items = profileItems(profile);
  const cited: Item[] = [];
  for (const id of basis) {
    const item = items.find((i) => i.id === id);
    if (!item) return fail(`o item "${id}" não existe no perfil`);
    cited.push(item);
  }
  const questionText = `${question.label}\n${question.help}`;
  const foldedQuestion = foldText(questionText);
  if (NEGATION.test(foldedQuestion)) return fail('pergunta com negação: sim e não ficam ambíguos');
  const subject = contentTokens(questionText);
  const answer = fact.answer.trim();
  /** A pergunta afirma uma quantidade de anos ("5 anos", "cinco years"): um sim a ela não é conferido. */
  const statesYears = YEAR_WORD.test(foldedQuestion) && (/\d/.test(foldedQuestion) || NUMBER_WORD.test(foldedQuestion));

  /** Resposta negativa: nunca enviada sem o dono. */
  const deny = (): Checked =>
    fail('uma resposta negativa precisa do dono: ele responde uma vez e o banco de respostas guarda a resposta');

  /** Anos da regra de números: experiências citadas cujo próprio texto contém todos os radicais da pergunta. */
  const subjectYears = (): number => {
    const counting = cited.filter((i) => i.kind === 'experience' && itemHasAll(i, subject));
    return yearsCovered(profile, counting.map((i) => i.id), now);
  };

  /** Terminado: formação ou experiência com fim legível e não futuro. */
  const finished = (item: Item): boolean => {
    if ((item.kind !== 'education' && item.kind !== 'experience') || item.end === null || item.end.trim() === '') return false;
    const end = monthIndex(item.end, 'end');
    return end !== null && end <= nowIndex(now);
  };
  /** Formação sem fim, com fim no futuro ou ilegível não sustenta nada: o dono ainda não tem esse diploma. */
  const mayVouch = (item: Item): boolean => item.kind !== 'education' || finished(item);

  /** Afirmação: UM item citado contém todos os radicais da pergunta e de `extra`. */
  const affirm = (extra: Token[], completion: boolean): string | null => {
    if (basis.length === 0) return 'afirmar exige citar itens do perfil';
    if (subject.length === 0) return 'a pergunta não diz sobre o que é';
    if (statesYears) return 'a pergunta afirma uma quantidade de anos';
    const need = [...subject, ...extra];
    const support = cited.filter((i) => itemHasAll(i, need) && mayVouch(i) && (!completion || finished(i)));
    if (support.length === 0) {
      return completion
        ? 'nenhum item citado e terminado contém tudo o que a pergunta e a resposta afirmam'
        : 'nenhum item citado contém sozinho tudo o que a pergunta e a resposta afirmam';
    }
    return null;
  };

  switch (question.kind) {
    case 'number': {
      if (!/^\d{1,3}$/.test(answer)) return fail('a resposta não é um número inteiro simples');
      if (!YEARS_OF_EXPERIENCE.test(foldedQuestion)) return fail('só pergunta de anos de experiência recebe número');
      const value = Number(answer);
      if (value === 0) return deny();
      const years = subjectYears();
      return value <= years
        ? { ok: true, value: String(value) }
        : fail(`${value} anos é mais que os ${years} das experiências citadas que tratam do assunto`);
    }
    case 'boolean': {
      const flag = answer.toLowerCase();
      if (flag === 'false') return deny();
      if (flag !== 'true') return fail('a resposta não é true nem false');
      const why = affirm([], COMPLETION.test(foldedQuestion));
      return why === null ? { ok: true, value: true } : fail(why);
    }
    case 'select': {
      const matches = question.options.filter((o) => optionKey(o) === optionKey(answer));
      if (matches.length !== 1) return fail('a resposta não é uma das opções, ou a opção é ambígua');
      const option = matches[0];
      // A opção reduzida às suas palavras: "No." = "no", "(Sim)" = "sim".
      const optionWords = tokenize(option).flatMap((t) => t.raw.split(/[-/]/));
      const key = optionWords.join(' ');
      if (NEGATIVE_OPTION.test(key) || optionWords.some((w) => OPTION_NEGATION.has(w)) || NEGATION.test(foldText(option))) return deny();
      const yes = YES_OPTION.test(key);
      const optionTokens = yes ? [] : contentTokens(option);
      if (!yes && optionTokens.length === 0) return fail('a opção não diz nada que possa ser conferido e não é um "sim"');
      const numbers = optionTokens.filter((t) => NUMBER_TOKEN.test(t.raw));
      const words = optionTokens.filter((t) => !NUMBER_TOKEN.test(t.raw));
      const lowest = Math.min(...numbers.flatMap((t) => t.raw.match(/\d+/g) ?? []).map(Number));
      if (lowest === 0) return deny(); // "0 anos", "0-2 anos": a faixa admite nenhuma experiência
      const why = affirm(words, COMPLETION.test(`${foldedQuestion} ${foldText(option)}`));
      if (why !== null) return fail(why);
      if (numbers.length > 0) {
        // Os números da opção são anos se ela diz "anos", ou se é só número/faixa numa pergunta que diz "anos".
        const optionYears = YEAR_WORD.test(foldText(option)) || (words.length === 0 && YEAR_WORD.test(foldedQuestion));
        if (!optionYears) return fail('a opção traz um número que não é de anos');
        const years = subjectYears();
        if (lowest > years) return fail(`a opção pede ${lowest} anos e as experiências citadas que tratam do assunto cobrem ${years}`);
      }
      return { ok: true, value: option };
    }
    case 'text':
    case 'longtext': {
      if (answer === '') return fail('resposta vazia');
      if (answer.length > (question.maxLength ?? DEFAULT_MAX_CHARS)) return fail('a resposta passa do tamanho permitido');
      if (hasControlChars(answer)) return fail('a resposta tem caractere de controle');
      if (basis.length === 0) return fail('a resposta exige citar itens do perfil');
      // Só as palavras funcionais saem: "anos", "experiência" e "trabalhei" também precisam estar no item.
      const need = contentTokens(answer, true);
      if (need.length === 0) return fail('a resposta não tem conteúdo que possa ser conferido');
      const numbers = numberIds(answer);
      const support = cited.find((i) => {
        if (!itemHasAll(i, need) || !mayVouch(i)) return false;
        const allowed = allowedNumbers(i.texts);
        return numbers.every((id) => allowed.has(id));
      });
      return support ? { ok: true, value: answer } : fail('nenhum item citado contém sozinho tudo o que a resposta diz');
    }
    default:
      return fail(`pergunta do tipo ${question.kind} não é respondida pelo modelo`);
  }
}

/** Início de frase: começo do texto, depois de . ! ? : ou de quebra de linha, pulando marcadores de lista ("-", "•", "*", "1."). */
const SENTENCE_START = /(?:^|[.!?:]\s+|\n)\s*(?:(?:[-•*–—]|\d+[.)])\s*)*["'“«(]*(\p{Lu}[\p{L}\p{N}+#.&'-]*)/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}+#.&'-]*/gu;
const trimWord = (w: string) => w.replace(/'s$/i, '').replace(/[.'&-]+$/, '');

/** Forma de tecnologia ou sigla: dígito, + # &, ponto interno, CamelCase ou 2+ maiúsculas ("Vue.js", "C#", "AWS", "GraphQL"). */
function technicalShape(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  if (/\p{N}/u.test(word) || /[+#&]/.test(word) || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(word) || /\p{Ll}\p{Lu}/u.test(word)) return true;
  return letters.length >= 2 && /^\p{Lu}+s?$/u.test(letters);
}

/** Variantes de grafia de uma palavra dobrada: "vue.js" também vale "vue" e "vuejs". */
const spellings = (folded: string): string[] => [folded, folded.replace(/\.?js$/, ''), folded.replace(/[.'-]/g, '')];

/**
 * As violações de um texto de resposta aberta contra o perfil e a vaga; vazio = pode enviar. A descrição da vaga NÃO
 * abona nada: o que o candidato diz saber vem só do perfil, do nome da empresa e do título da vaga.
 * - `new_number`: número que não está no perfil (nem no nome da empresa ou no título da vaga; os números da descrição NÃO
 *   valem), ou "N anos" acima do que todas as experiências cobrem;
 * - `novel_term`:
 *   1. nome, sigla ou termo técnico no meio de uma frase que o perfil não traz (regra de `novelTerms`);
 *   2. palavra capitalizada que abre frase (inclusive depois de marcador de lista) que o perfil não traz E que consta da
 *      lista de nomes conhecidos, tem forma de tecnologia/sigla ou aparece na descrição da vaga em qualquer grafia;
 *      as demais são prosa ("Gostaria", "Desejo");
 *   3. qualquer palavra, em qualquer posição e caixa, que a descrição da vaga traz como nome conhecido ou com forma de
 *      tecnologia/sigla e que o perfil não traz;
 * - `limit`: texto vazio, acima de `maxLength` ou com caractere de controle.
 * Limites conhecidos: tecnologia em minúsculas que não está em lista nem tem forma técnica; nome próprio simples que abre
 * frase e não está nas listas nem na descrição.
 */
export function verifyOpenAnswer(
  profile: CandidateProfile,
  job: { company: string; title: string; description: string },
  question: Question,
  text: string,
  now: number = Date.now(),
): Violation[] {
  const violations: Violation[] = [];
  const limit = (message: string) => violations.push({ code: 'limit', path: 'text', message });
  const max = question.maxLength ?? DEFAULT_MAX_CHARS;
  if (text.trim() === '') limit('a resposta está vazia');
  if (text.length > max) limit(`o texto tem ${text.length} caracteres (o máximo é ${max})`);
  if (hasControlChars(text.slice(0, max + 1))) limit('o texto contém NUL ou caractere de controle');
  if (violations.length > 0) return violations; // fora do limite o texto nem é lido pelas outras conferências

  const allowed = allowedNumbers([...numericTexts(profile), job.company, job.title]);
  for (const id of numberIds(text)) {
    if (!allowed.has(id)) violations.push({ code: 'new_number', path: 'text', detail: id, message: `o número "${id}" não está no perfil` });
  }
  const claims = yearClaims(text);
  const years = yearsCovered(profile, profile.experiences.map((e) => e.id), now);
  if (claims.length > 0 && Math.max(...claims) > years) {
    violations.push({
      code: 'new_number', path: 'text', detail: `${Math.max(...claims)} anos`,
      message: `o texto fala em ${Math.max(...claims)} anos e as experiências do perfil cobrem ${years}`,
    });
  }

  const index = buildTermIndex([...profileTexts(profile), job.company, job.title]);
  const description = job.description.slice(0, JOB_TEXT_CHARS);
  const reported = new Set<string>();
  const report = (term: string) => {
    const folded = foldText(term);
    if (reported.has(folded)) return;
    reported.add(folded);
    violations.push({ code: 'novel_term', path: 'text', detail: term, message: `o texto cita "${term}", que não está no perfil` });
  };

  // Palavras que a descrição da vaga traz como nome conhecido ou com forma de tecnologia, e todas as suas palavras.
  const jobWords = new Set<string>();
  const jobSpecial = new Set<string>();
  for (const m of description.matchAll(WORD)) {
    const word = trimWord(m[0]);
    const folded = foldText(word);
    if (!folded || /^[\d.,'-]+$/.test(folded)) continue;
    spellings(folded).forEach((s) => jobWords.add(s));
    if (!STOPWORDS.has(folded) && (isListedName(folded) || technicalShape(word))) spellings(folded).forEach((s) => jobSpecial.add(s));
  }

  for (const term of novelTerms(text, index, { mode: 'full' })) report(term);
  for (const m of text.trim().matchAll(SENTENCE_START)) {
    const word = trimWord(m[1]);
    const folded = foldText(word);
    if (folded.length < 2 || STOPWORDS.has(folded) || isKnownTerm(folded, index)) continue;
    if (isListedName(folded) || technicalShape(word) || spellings(folded).some((s) => jobWords.has(s))) report(word);
  }
  for (const m of text.matchAll(WORD)) {
    const word = trimWord(m[0]);
    const folded = foldText(word);
    if (!folded || /^[\d.,'-]+$/.test(folded) || STOPWORDS.has(folded) || isKnownTerm(folded, index)) continue;
    if (spellings(folded).some((s) => jobSpecial.has(s))) report(word);
  }
  return violations;
}

import { optionKey, type AnswerValue, type CandidateProfile, type Question, type Violation } from '@kv/shared';
import {
  STOPWORDS, allowedNumbers, buildTermIndex, foldText, foldedWords, hasControlChars, isKnownTerm, isListedName, novelTerms, numberIds, stem,
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

/** Os textos de um item do perfil de onde um número ou uma palavra de resposta pode vir, ou null se o id não existe. */
function itemTexts(profile: CandidateProfile, id: string): string[] | null {
  for (const e of profile.experiences) {
    if (e.id === id) return [e.company, e.title, e.start, e.end, ...e.achievements.map((a) => a.text)];
    const a = e.achievements.find((x) => x.id === id);
    if (a) return [a.text];
  }
  const education = profile.education.find((e) => e.id === id);
  if (education) return [education.institution, education.degree, education.start, education.end];
  const skill = profile.skills.find((k) => k.id === id);
  if (skill) return [skill.name];
  const language = profile.languages.find((l) => l.id === id);
  if (language) return [language.name, language.level];
  const certification = profile.certifications.find((c) => c.id === id);
  if (certification) return [certification.name, certification.issuer, certification.date];
  const link = profile.links.find((l) => l.id === id);
  return link ? [link.label] : null;
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
const NEGATION = /\b(nao|not|never|nunca|nenhum|nenhuma|none|without|sem)\b/;
/** Opção que é exatamente zero ou um "não" simples: afirma nada, não precisa de item citado. */
const NEGATIVE_OPTION = /^(0|nao|no|nenhum|nenhuma|none|never|nunca)$/;
const YES_OPTION = /^(sim|yes)$/;
const COMPLETION = /\b(complet[oa]s?|concluid[oa]s?|completed?|finished|graduated)\b/;

/**
 * Palavras de moldura de pergunta, que não dizem sobre o que ela é (as de STOPWORDS também ficam de fora). Nenhuma
 * palavra de conteúdo entra aqui, e nenhuma lista diz que um termo "vale" por outro: o item citado precisa conter a palavra.
 */
const SCAFFOLD = new Set(
  (
    'possui possuir tem ter voce vc you qual quais sua seu suas seus nivel level do does did have has having are is be ' +
    'how many quantos quantas ha which what experiencia experience anos ano years year'
  ).split(' '),
);
/** Radicais de conteúdo de um texto: sem stopwords, sem moldura de pergunta, sem número puro. Palavra curta ("go", "c#") conta. */
const contentWords = (text: string): string[] =>
  foldedWords(text).filter((w) => !STOPWORDS.has(w) && !SCAFFOLD.has(w) && !/^\d+$/.test(w)).map(stem);
const allWords = (text: string): Set<string> => new Set(foldedWords(text).map(stem));

type Checked = { ok: true; value: AnswerValue } | { ok: false; why: string };
const fail = (why: string): Checked => ({ ok: false, why });

/**
 * Confere uma resposta factual do modelo contra o perfil. Regras:
 * - todo id de `basis` existe no perfil;
 * - `number`: inteiro simples. Se a pergunta fala de anos, entre 0 e `yearsCovered` (para baixo) das experiências citadas,
 *   com ao menos uma citada; se não, o número tem de aparecer no texto de um item citado;
 * - `boolean`: só `true` ou `false`; `true` exige `basis` e que algum item citado trate do assunto da pergunta;
 * - `select`: a resposta é uma das opções (devolvida como o formulário a escreve). Só uma opção claramente negativa
 *   ("não", "nenhum", "0") passa sem `basis`; "sim" exige item citado sobre o assunto, e qualquer outra opção só passa se
 *   suas palavras estiverem nos itens citados (ou, para faixa de anos, se as experiências cobrirem os anos);
 * - `text`/`longtext`: todo número da resposta aparece em algum item citado, as palavras existem no perfil e o tamanho
 *   cabe em `maxLength`;
 * - afirmar algo sobre um nome que o perfil não traz é recusado, e "N anos" na pergunta ou na opção escolhida exige
 *   experiências citadas que cubram N anos;
 * - pergunta com negação ("não", "not", "never"...) não é respondida: sim e não ficam ambíguos.
 * Outros tipos (data, várias opções, arquivo) são recusados.
 */
export function verifyProfileFact(
  profile: CandidateProfile,
  question: Question,
  fact: { answer: string; basis: string[] },
  now: number = Date.now(),
): Checked {
  const basis = [...new Set(fact.basis)];
  if (basis.length > MAX_BASIS) return fail('itens demais citados');
  const cited: string[][] = [];
  for (const id of basis) {
    const texts = itemTexts(profile, id);
    if (!texts) return fail(`o item "${id}" não existe no perfil`);
    cited.push(texts);
  }
  const experienceIds = basis.filter((id) => profile.experiences.some((e) => e.id === id));
  const index = buildTermIndex(profileTexts(profile));
  const answer = fact.answer.trim();
  const questionText = `${question.label}\n${question.help}`;

  /** Nome que a pergunta cita e o perfil não traz (palavras comuns de rótulo, como "Development", não contam). */
  const unknownSubjectWhy = () => {
    const subject = novelTerms(questionText, index, { mode: 'full' }).find((t) => !STOPWORDS.has(foldText(t)));
    return subject === undefined ? null : fail(`a pergunta cita "${subject}", que não está no perfil`);
  };
  /** "N anos" nos textos além do que as experiências citadas cobrem, ou número da pergunta que o perfil não traz. */
  const unsupportedClaim = (texts: string[]): string | null => {
    const covered = yearsCovered(profile, experienceIds, now);
    const claims = texts.flatMap(yearClaims);
    if (claims.length > 0 && Math.max(...claims) > covered) {
      return `a pergunta pede ${Math.max(...claims)} anos e as experiências citadas cobrem ${covered}`;
    }
    const years = new Set(claims.map(String));
    const known = allowedNumbers(numericTexts(profile));
    const stray = texts.flatMap(numberIds).find((id) => !years.has(id) && !known.has(id));
    return stray === undefined ? null : `o número "${stray}" da pergunta não está no perfil`;
  };
  /** Todo radical de conteúdo de `texts` está nos textos dos itens citados? Sem nenhum radical não há o que conferir: recusa. */
  const covered = (...texts: string[]): boolean => {
    const have = allWords(cited.flat().join(' '));
    const need = texts.flatMap(contentWords);
    return need.length > 0 && need.every((w) => have.has(w));
  };
  /** Item de formação ou experiência sem fim, com fim no futuro ou ilegível: não sustenta "completo". */
  const ongoing = (id: string): boolean => {
    const item = profile.education.find((e) => e.id === id) ?? profile.experiences.find((e) => e.id === id);
    if (!item) return false;
    const end = monthIndex(item.end, 'end');
    return item.end.trim() === '' || end === null || end > nowIndex(now);
  };
  const negated = NEGATION.test(foldText(questionText));

  switch (question.kind) {
    case 'number': {
      if (!/^\d{1,3}$/.test(answer)) return fail('a resposta não é um número inteiro simples');
      const value = Number(answer);
      if (!YEARS_OF_EXPERIENCE.test(foldText(questionText))) return fail('só pergunta de anos de experiência recebe número');
      if (experienceIds.length === 0) return fail('nenhuma experiência foi citada');
      const years = yearsCovered(profile, experienceIds, now);
      if (value > years) return fail(`${value} anos é mais que os ${years} que as experiências citadas cobrem`);
      const subject = value > 0 ? unknownSubjectWhy() : null;
      return subject ?? { ok: true, value: String(value) };
    }
    case 'boolean': {
      if (negated) return fail('pergunta com negação: sim e não ficam ambíguos');
      const flag = answer.toLowerCase();
      if (flag === 'false') return { ok: true, value: false };
      if (flag !== 'true') return fail('a resposta não é true nem false');
      if (basis.length === 0) return fail('afirmar exige citar itens do perfil');
      const subject = unknownSubjectWhy();
      if (subject) return subject;
      const claim = unsupportedClaim([questionText]);
      if (claim !== null) return fail(claim);
      if (COMPLETION.test(foldText(questionText)) && basis.some(ongoing)) return fail('um item em andamento não sustenta "completo"');
      return covered(questionText) ? { ok: true, value: true } : fail('os itens citados não cobrem tudo o que a pergunta afirma');
    }
    case 'select': {
      const matches = question.options.filter((o) => optionKey(o) === optionKey(answer));
      if (matches.length !== 1) return fail('a resposta não é uma das opções, ou a opção é ambígua');
      if (negated) return fail('pergunta com negação: sim e não ficam ambíguos');
      const option = matches[0];
      const key = optionKey(option);
      if (NEGATIVE_OPTION.test(key)) return { ok: true, value: option };
      if (basis.length === 0) return fail('escolher esta opção exige citar itens do perfil');
      const subject = unknownSubjectWhy();
      if (subject) return subject;
      const claim = unsupportedClaim([questionText, option]);
      if (claim !== null) return fail(claim);
      if (COMPLETION.test(foldText(`${questionText} ${option}`)) && basis.some(ongoing)) return fail('um item em andamento não sustenta "completo"');
      // "Sim" e faixa de anos (os anos já foram conferidos acima) não trazem palavra própria: só a pergunta é conferida.
      const needsOptionWords = !YES_OPTION.test(key) && !/\d/.test(option);
      return covered(questionText) && (!needsOptionWords || covered(option))
        ? { ok: true, value: option }
        : fail('os itens citados não cobrem tudo o que a pergunta e a opção afirmam');
    }
    case 'text':
    case 'longtext': {
      if (answer === '') return fail('resposta vazia');
      if (answer.length > (question.maxLength ?? DEFAULT_MAX_CHARS)) return fail('a resposta passa do tamanho permitido');
      if (hasControlChars(answer)) return fail('a resposta tem caractere de controle');
      const allowed = allowedNumbers(cited.flat());
      const stray = numberIds(answer).find((id) => !allowed.has(id));
      if (stray !== undefined) return fail(`o número "${stray}" não está nos itens citados`);
      const term = novelTerms(answer, index, { mode: 'full' })[0];
      if (term !== undefined) return fail(`a resposta cita "${term}", que não está no perfil`);
      return { ok: true, value: answer };
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

import { optionKey, type AnswerValue, type CandidateProfile, type Question, type Violation } from '@kv/shared';
import {
  STOPWORDS, allowedNumbers, buildTermIndex, contentStems, foldText, hasControlChars, isKnownTerm, isListedName, novelTerms, numberIds, stem,
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

const ABOUT_YEARS = /\b(anos?|years?)\b/i;
const NEGATION = /\b(nao|not|never|nunca|nenhum|nenhuma|none|without|sem)\b/;
const NEGATIVE_OPTION = /^(nao|no|nenhum|nenhuma|none|never|nunca|0)(\W|$)/;
const YES_OPTION = /^(sim|yes|true|verdadeiro)(\W|$)/;

/** Palavras de pergunta que não dizem sobre o que é a pergunta (já fora: as de STOPWORDS). */
const GENERIC_STEMS = new Set(['possui', 'conhecimento', 'tempo', 'habilidade', 'skill'].map(stem));
/** O que "graduação", "ensino superior" etc. querem dizer: itens de formação do perfil os sustentam. */
const EDUCATION_WORDS = 'graduacao superior ensino faculdade universidade bacharelado degree bachelor college university graduate';

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
  const hasEducation = basis.some((id) => profile.education.some((e) => e.id === id));
  const citedStems = () => contentStems([...cited.flat(), ...(hasEducation ? [EDUCATION_WORDS] : [])].join(' '));
  const notGeneric = (stems: Iterable<string>) => [...stems].filter((s) => !GENERIC_STEMS.has(s));
  /** Algum item citado trata do assunto da pergunta? Sem palavra de assunto na pergunta não há como saber: recusa. */
  const related = () => {
    const have = citedStems();
    return notGeneric(contentStems(questionText)).some((s) => have.has(s));
  };
  const negated = NEGATION.test(foldText(questionText));

  switch (question.kind) {
    case 'number': {
      if (!/^\d{1,3}$/.test(answer)) return fail('a resposta não é um número inteiro simples');
      const value = Number(answer);
      if (ABOUT_YEARS.test(questionText)) {
        if (experienceIds.length === 0) return fail('nenhuma experiência foi citada');
        const covered = yearsCovered(profile, experienceIds, now);
        if (value > covered) return fail(`${value} anos é mais que os ${covered} que as experiências citadas cobrem`);
      } else {
        if (basis.length === 0) return fail('nenhum item foi citado');
        if (!allowedNumbers(cited.flat()).has(String(value))) return fail(`o número ${value} não está nos itens citados`);
      }
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
      return related() ? { ok: true, value: true } : fail('nenhum item citado trata do assunto da pergunta');
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
      if (YES_OPTION.test(key) || yearClaims(option).length > 0) {
        return related() ? { ok: true, value: option } : fail('nenhum item citado trata do assunto da pergunta');
      }
      const words = notGeneric(contentStems(option));
      const have = citedStems();
      return words.length > 0 && words.every((w) => have.has(w)) ? { ok: true, value: option } : fail('a opção não está nos itens citados');
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

/** Primeiras palavras comuns de frase (pt/en) que não são nome próprio, além dos verbos já reconhecidos pela terminação. */
const OPENERS = new Set(
  (
    'sou tenho tive fui estou quero gosto acredito busco atuo atuei uso utilizo aplico domino conheco construi desenvolvi ' +
    'reduzi lidero minha meu minhas meus me nao sim alem tambem porque pois entao assim hoje atualmente desde durante ' +
    'admiro vejo penso considero obrigado obrigada ola prezados cordialmente atenciosamente i my we our in as at on after ' +
    'during currently also because since this that there however while having being thanks hello dear'
  ).split(' '),
);
/** Terminações de verbo (1ª pessoa do passado, gerúndio...) e advérbio: palavra de frase, não nome. */
const PROSE_ENDING = /(ei|ou|ava|avam|amos|emos|ndo|mente)$/;

/** Palavras que aparecem com inicial minúscula no texto: vocabulário comum, não nome próprio. */
function lowercaseWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\p{Ll}[\p{L}\p{N}]*/gu)) {
    if (m.index > 0 && /[\p{L}\p{N}]/u.test(text[m.index - 1])) continue; // meio de palavra
    out.add(foldText(m[0]));
  }
  return out;
}

/**
 * As violações de um texto de resposta aberta contra o perfil e a vaga; vazio = pode enviar.
 * - `new_number`: número que não está no perfil (nem no nome da empresa ou no título da vaga; os números da descrição NÃO
 *   valem: "mais de 10 anos" da vaga não é um fato do candidato), ou "N anos" acima do que todas as experiências cobrem;
 * - `novel_term`: termo ou nome próprio que não está no perfil, na empresa nem no título da vaga. Da descrição da vaga
 *   só palavra comum capitalizada vale (ela aparece também com minúscula na descrição e não consta das listas de nomes
 *   conhecidos): tecnologia, sigla ou nome que a vaga pede não vira experiência do candidato. Palavra capitalizada que
 *   abre frase também é conferida, salvo palavras de abertura comuns e verbos reconhecidos pela terminação (heurística:
 *   na dúvida recusa);
 * - `limit`: texto vazio, acima de `maxLength` ou com caractere de controle.
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
  const covered = yearsCovered(profile, profile.experiences.map((e) => e.id), now);
  if (claims.length > 0 && Math.max(...claims) > covered) {
    violations.push({
      code: 'new_number', path: 'text', detail: `${Math.max(...claims)} anos`,
      message: `o texto fala em ${Math.max(...claims)} anos e as experiências do perfil cobrem ${covered}`,
    });
  }

  const index = buildTermIndex([...profileTexts(profile), job.company, job.title]);
  const jobWords = lowercaseWords(job.description.slice(0, JOB_TEXT_CHARS));
  const vouchedByJob = (term: string) => {
    const folded = foldText(term);
    return /^\p{Lu}\p{Ll}+$/u.test(term) && !isListedName(folded) && jobWords.has(folded);
  };
  const reported = new Set<string>();
  const report = (term: string) => {
    reported.add(foldText(term));
    violations.push({ code: 'novel_term', path: 'text', detail: term, message: `o texto cita "${term}", que não está no perfil` });
  };
  for (const term of novelTerms(text, index, { mode: 'full' })) if (!vouchedByJob(term)) report(term);
  for (const m of text.trim().matchAll(/(?:^|[.!?]\s+|\n\s*)["'“«(]*(\p{Lu}\p{L}*)/gu)) {
    const term = m[1];
    const folded = foldText(term);
    if (folded.length < 3 || reported.has(folded) || STOPWORDS.has(folded) || OPENERS.has(folded) || PROSE_ENDING.test(folded)) continue;
    if (isKnownTerm(folded, index) || vouchedByJob(term)) continue;
    report(term);
  }
  return violations;
}

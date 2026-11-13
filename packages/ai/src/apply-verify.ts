import { optionKey, type AnswerValue, type CandidateProfile, type Question, type Violation } from '@kv/shared';
import { allowedNumbers, buildTermIndex, hasControlChars, novelTerms, numberIds } from './text';
import { numericTexts, profileTexts } from './verify';

/**
 * Últimas barreiras antes de uma resposta escrita pelo modelo ser digitada numa candidatura em nome do dono. Na dúvida
 * as duas recusam: uma resposta recusada volta ao dono como pergunta pendente, e isso é sempre melhor que afirmar
 * mais do que o perfil sustenta.
 */

/** Teto de uma resposta quando o formulário não informa `maxLength`. */
const DEFAULT_MAX_CHARS = 2_000;
/** Ids citados por resposta e teto da descrição da vaga que entra no índice de termos. */
const MAX_BASIS = 50;
const JOB_TEXT_CHARS = 20_000;
/** Número que acompanha "anos"/"years" e passa disso não é uma quantidade de anos (ex.: um ano-calendário). */
const MAX_YEARS_CLAIM = 60;

const MONTH = /^(\d{4})-(\d{1,2})$/;
const MONTH_SLASH = /^(\d{1,2})\/(\d{4})$/;
const YEAR = /^(\d{4})$/;

/** Índice do mês (ano × 12 + mês) de uma data do perfil. Só o ano vale dezembro: nunca soma tempo que não está escrito. */
function monthIndex(raw: string): number | null {
  const text = raw.trim();
  const ym = MONTH.exec(text) ?? (() => { const m = MONTH_SLASH.exec(text); return m ? [m[0], m[2], m[1]] : null; })();
  if (ym) {
    const month = Number(ym[2]);
    return month >= 1 && month <= 12 ? Number(ym[1]) * 12 + month - 1 : null;
  }
  const y = YEAR.exec(text);
  return y ? Number(y[1]) * 12 + 11 : null;
}

const nowIndex = (now: number) => {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * Anos cobertos pela união dos períodos das experiências citadas (fim vazio = `now`), arredondados para cima.
 * Períodos que se sobrepõem contam uma vez; id inexistente, data ilegível, período invertido ou no futuro contam zero.
 */
export function yearsCovered(profile: CandidateProfile, experienceIds: string[], now: number): number {
  const current = nowIndex(now);
  const cited = new Set(experienceIds);
  const spans: [number, number][] = [];
  for (const e of profile.experiences) {
    if (!cited.has(e.id)) continue;
    const start = monthIndex(e.start);
    const end = e.end.trim() === '' ? current : monthIndex(e.end);
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
  return Math.ceil(months / 12);
}

/** Os textos de um item do perfil de onde um número de resposta pode vir, ou null se o id não existe. */
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

type Checked = { ok: true; value: AnswerValue } | { ok: false; why: string };
const fail = (why: string): Checked => ({ ok: false, why });

/**
 * Confere uma resposta factual do modelo contra o perfil. Regras:
 * - todo id de `basis` existe no perfil;
 * - `number`: inteiro simples entre 0 e `yearsCovered` das experiências citadas, com ao menos uma citada;
 * - `select`: a resposta é uma das opções (devolvida como o formulário a escreve);
 * - `boolean`: só `true` ou `false`, e `true` exige `basis` não vazio;
 * - `text`/`longtext`: todo número da resposta aparece em algum item citado e o tamanho cabe em `maxLength`;
 * - além disso, afirmar (número > 0, `true`, opção de lista, texto) algo com um nome que o perfil não traz é recusado,
 *   e "N anos" na pergunta ou na opção escolhida exige experiências citadas que cubram N anos.
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
  /** O texto da pergunta cita tecnologia, ferramenta ou nome que o perfil não traz: afirmar seria inventar. */
  const unknownSubject = () => novelTerms(questionText, index, { mode: 'full' })[0];
  /** "N anos" em `texts` e número da pergunta que o perfil não traz: o perfil precisa sustentar. */
  const unsupportedClaim = (texts: string[], plainNumbers: boolean): string | null => {
    const covered = yearsCovered(profile, experienceIds, now);
    const claims = texts.flatMap(yearClaims);
    if (claims.length > 0 && Math.max(...claims) > covered) {
      return `a pergunta pede ${Math.max(...claims)} anos e as experiências citadas cobrem ${covered}`;
    }
    if (plainNumbers) {
      const years = new Set(claims.map(String));
      const known = allowedNumbers(numericTexts(profile));
      const stray = texts.flatMap(numberIds).find((id) => !years.has(id) && !known.has(id));
      if (stray !== undefined) return `o número "${stray}" da pergunta não está no perfil`;
    }
    return null;
  };

  switch (question.kind) {
    case 'number': {
      if (!/^\d{1,3}$/.test(answer)) return fail('a resposta não é um número inteiro simples');
      const years = Number(answer);
      if (experienceIds.length === 0) return fail('nenhuma experiência foi citada');
      const covered = yearsCovered(profile, experienceIds, now);
      if (years > covered) return fail(`${years} anos é mais que os ${covered} que as experiências citadas cobrem`);
      const subject = years > 0 ? unknownSubject() : undefined;
      if (subject !== undefined) return fail(`a pergunta cita "${subject}", que não está no perfil`);
      return { ok: true, value: String(years) };
    }
    case 'boolean': {
      const flag = answer.toLowerCase();
      if (flag === 'false') return { ok: true, value: false };
      if (flag !== 'true') return fail('a resposta não é true nem false');
      if (basis.length === 0) return fail('afirmar exige citar itens do perfil');
      const subject = unknownSubject();
      if (subject !== undefined) return fail(`a pergunta cita "${subject}", que não está no perfil`);
      const claim = unsupportedClaim([questionText], true);
      return claim === null ? { ok: true, value: true } : fail(claim);
    }
    case 'select': {
      const matches = question.options.filter((o) => optionKey(o) === optionKey(answer));
      if (matches.length !== 1) return fail('a resposta não é uma das opções, ou a opção é ambígua');
      const subject = unknownSubject();
      if (subject !== undefined) return fail(`a pergunta cita "${subject}", que não está no perfil`);
      const claim = unsupportedClaim([questionText, matches[0]], true);
      return claim === null ? { ok: true, value: matches[0] } : fail(claim);
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

/**
 * As violações de um texto de resposta aberta contra o perfil e a vaga; vazio = pode enviar.
 * - `new_number`: número que não está no perfil (nem no nome da empresa ou no título da vaga; os números da descrição NÃO
 *   valem: "mais de 10 anos" da vaga não é um fato do candidato);
 * - `novel_term`: termo ou nome próprio que não está no perfil, a não ser que seja a empresa, o título ou um termo da
 *   descrição da vaga;
 * - `limit`: texto vazio, acima de `maxLength` ou com caractere de controle.
 */
export function verifyOpenAnswer(
  profile: CandidateProfile,
  job: { company: string; title: string; description: string },
  question: Question,
  text: string,
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
  const index = buildTermIndex([...profileTexts(profile), job.company, job.title, job.description.slice(0, JOB_TEXT_CHARS)]);
  for (const term of novelTerms(text, index, { mode: 'full' })) {
    violations.push({ code: 'novel_term', path: 'text', detail: term, message: `o texto cita "${term}", que não está no perfil nem na vaga` });
  }
  return violations;
}

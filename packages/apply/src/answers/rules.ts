import { normalizeQuestionText, optionKey, type AnswerValue, type CandidateProfile, type Question, type QuestionCategory } from '@kv/shared';
import type { ApplyJob } from '../types';
import { optionFor } from './bank';

/*
 * Todos os padrões rodam sobre `normalizeQuestionText`: minúsculas, sem acento, pontuação virando espaço.
 * Por isso estão escritos sem acento ("pretensao", "nao concorrencia", "e mail").
 */

/** Padrões, em português e inglês, que mandam na categoria seja o que for que o modelo diga. */
export const SENSITIVE_PATTERNS: readonly { category: 'personal' | 'demographic'; pattern: RegExp }[] = [
  // Salário.
  { category: 'personal', pattern: /\bsalar|\bremunera|\bpretens|\bcompensation\b|\bpay\b/ },
  // Visto e autorização de trabalho.
  { category: 'personal', pattern: /\bvistos?\b|\bvisas?\b|\bsponsor|\bautoriza\w*( \w+){0,3} trabalh|\bpermissao de trabalho\b/ },
  { category: 'personal', pattern: /\bauthori[sz]\w*( \w+){0,2} (to )?work\b|\bwork authori[sz]|\bwork permit|\bright to work\b/ },
  // Antecedentes e declarações legais.
  { category: 'personal', pattern: /\bantecedentes\b|\bcriminal|\bbackground check|\bconvicted\b|\bcondenad/ },
  { category: 'personal', pattern: /\bnao concorrencia\b|\bnon ?compete\b|\bemployment agreement|\bacordo de nao/ },
  // Referências.
  { category: 'personal', pattern: /\breferenc/ },
  // Mudança de cidade.
  { category: 'personal', pattern: /\bmudanca\b|\bmudar de (cidade|estado|pais)\b|\brelocat/ },
  // Disponibilidade e início.
  { category: 'personal', pattern: /\bdisponibilidade\b|\baviso previo\b|\bnotice period\b|\bstart date\b|\bdata de inicio\b|\bcan you start\b|\bpode comecar\b/ },
  // Dados demográficos.
  { category: 'demographic', pattern: /\bgenero\b|\bgender\b/ },
  { category: 'demographic', pattern: /\bracas?\b|\betnia|\betnic|\brace\b|\bethnic|\bhispanic|\blatin[oa]\b/ },
  { category: 'demographic', pattern: /\bdeficien|\bpcds?\b|\bdisabilit/ },
  { category: 'demographic', pattern: /\bveteran/ },
  { category: 'demographic', pattern: /\borientacao sexual\b|\bsexual orientation\b/ },
  { category: 'demographic', pattern: /\bidade\b|\bdata de nascimento\b|\bdate of birth\b|\bbirth ?date\b/ },
];

export interface RuleContext {
  profile: CandidateProfile;
  job: ApplyJob;
  /** Nome da fonte da vaga, para "como soube da vaga?". */
  sourceLabel: string;
  resumeFileName: string;
}

/** O texto do rótulo sem cortesia no começo nem "(opcional)" no fim, para os campos de contato. */
function fieldName(label: string): string {
  return normalizeQuestionText(label)
    .replace(/^(please )?(enter |informe |digite )?(your |seu |sua |o seu |a sua )?/, '')
    .replace(/( optional| opcional| required| obrigatorio)+$/, '')
    .trim();
}

type IdentityField = 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'location' | 'country' | 'linkedin' | 'github'
  | 'portfolio' | 'currentCompany' | 'currentTitle';

const IDENTITY_FIELDS: readonly [IdentityField, RegExp][] = [
  ['fullName', /^((full|legal|complete) )?name$|^nome( completo)?$/],
  ['firstName', /^(first|given) name$|^primeiro nome$/],
  ['lastName', /^(last|family) name$|^surname$|^sobrenome$|^ultimo nome$/],
  ['email', /^(endereco de )?e ?mail( address)?$/],
  ['phone', /^((numero de )?(telefone|celular|whatsapp)( celular| para contato| de contato)?|((mobile|cell) )?phone( number)?|mobile( number)?)$/],
  ['location', /^(cidade|city|location|localizacao|localidade|current (city|location)|cidade atual|cidade onde mora|onde (voce )?mora)$/],
  ['country', /^(pais|country|pais de residencia|country of residence)$/],
  ['linkedin', /^(perfil (do |no )?)?linkedin( profile)?( url| link)?$/],
  ['github', /^(perfil (do |no )?)?github( profile)?( url| link)?$/],
  ['portfolio', /^(portfolio|portifolio|website|personal website|site( pessoal)?)( url| link| website)?$/],
  ['currentCompany', /^(empresa atual|current (company|employer)( name)?|empregador atual)$/],
  ['currentTitle', /^(cargo atual|current (job )?(title|role|position)|titulo atual)$/],
];

function identityField(q: Question): IdentityField | null {
  const name = fieldName(q.label);
  return IDENTITY_FIELDS.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

const ORIGIN = /\bcomo (voce )?(soube|ficou sabendo|conheceu|encontrou)\b|\bonde (voce )?(soube|viu|encontrou)\b|\bhow did you (hear|find|learn|come across)\b|\bwhere did you (hear|find|see)\b/;
const CONSENT = /\bi (agree|accept|consent|acknowledge)\b|\bi have read\b|\bconcordo\b|\baceito\b|\bconsinto\b|\bprivacy (policy|notice)\b|\bpolitica de privacidade\b|\btermos de uso\b|\bterms (of|and) (use|service|conditions)\b|\blgpd\b|\bgdpr\b|\btratamento (dos |de )?(meus )?dados\b|\bdata processing\b|\bconsent\b|\bconsentimento\b/;
const RESUME_FILE = /\bresume\b|\bcurriculo\b|\bcurriculum\b|\bcv\b/;
const NOT_RESUME_FILE = /\bcover letter\b|\bcarta\b/;
/** "Já trabalhou nesta empresa?" sem citar o nome: o nome da empresa só se conhece com a vaga (`answerByRule`). */
const GENERIC_EMPLOYER = ['this company', 'our company', 'us', 'nesta empresa', 'esta empresa', 'nossa empresa', 'conosco', 'aqui'];

function workedHerePattern(targets: string[]): RegExp {
  const alt = targets.filter((t) => t !== '').join('|');
  return new RegExp(`\\b(worked|employed)\\b.*\\b(at|for|by|with) (${alt})\\b|\\btrabalh(ou|a|ado)\\b.*\\b(${alt})\\b`);
}
const WORKED_HERE_GENERIC = workedHerePattern(GENERIC_EMPLOYER);

/** A categoria que as regras conhecem, ou null. Os padrões sensíveis são conferidos primeiro, no rótulo, na ajuda e nas opções. */
export function classifyByRule(q: Question): QuestionCategory | null {
  const texts = [q.label, q.help, ...q.options].map(normalizeQuestionText);
  for (const { category, pattern } of SENSITIVE_PATTERNS) if (texts.some((t) => pattern.test(t))) return category;
  if (q.kind === 'file') return 'file';
  const label = normalizeQuestionText(q.label);
  if (ORIGIN.test(label)) return 'origin';
  if (CONSENT.test(label)) return 'consent';
  if (identityField(q)) return 'identity';
  if (WORKED_HERE_GENERIC.test(label)) return 'profile_fact';
  return null;
}

/** Texto para um campo livre; em lista, a única opção com a mesma chave; senão, a regra não sabe. */
function fit(value: string | null | undefined, q: Question): AnswerValue | undefined {
  const v = value?.trim();
  if (!v || q.kind === 'boolean' || q.kind === 'file' || q.kind === 'multiselect') return undefined;
  if (q.options.length === 0) return v;
  return optionFor(v, q.options) ?? undefined;
}

/** Nomes do mesmo país, para casar "Brasil" do perfil com a opção "Brazil". */
const COUNTRIES: readonly string[][] = [
  ['Brasil', 'Brazil'], ['Portugal'], ['Argentina'], ['Chile'], ['Uruguai', 'Uruguay'], ['Colômbia', 'Colombia'], ['México', 'Mexico'],
  ['Estados Unidos', 'United States', 'United States of America', 'USA', 'EUA'], ['Canadá', 'Canada'], ['Reino Unido', 'United Kingdom', 'UK'],
  ['Alemanha', 'Germany'], ['Espanha', 'Spain'], ['França', 'France'], ['Irlanda', 'Ireland'], ['Holanda', 'Países Baixos', 'Netherlands'],
];

function countryAnswer(location: string, q: Question): AnswerValue | undefined {
  const last = location.split(',').at(-1)?.trim() ?? '';
  const names = COUNTRIES.find((group) => group.some((n) => optionKey(n) === optionKey(last)));
  if (!names) return undefined;
  if (q.kind === 'boolean' || q.kind === 'file' || q.kind === 'multiselect') return undefined;
  if (q.options.length === 0) return last;
  const keys = new Set(names.map(optionKey));
  const hits = q.options.filter((o) => keys.has(optionKey(o)));
  return hits.length === 1 ? hits[0] : undefined;
}

function linkFor(profile: CandidateProfile, field: 'linkedin' | 'github' | 'portfolio'): string | null {
  const isLinkedin = (l: { label: string; url: string }) => /linkedin\.com/i.test(l.url) || /linkedin/i.test(l.label);
  const isGithub = (l: { label: string; url: string }) => /github\.com/i.test(l.url) || /github/i.test(l.label);
  const link = profile.links.find((l) => {
    if (field === 'linkedin') return isLinkedin(l);
    if (field === 'github') return isGithub(l);
    return !isLinkedin(l) && !isGithub(l) && /portf|site|blog/i.test(normalizeQuestionText(l.label));
  });
  return link?.url ?? null;
}

function identityAnswer(field: IdentityField, q: Question, profile: CandidateProfile): AnswerValue | undefined {
  const { contact } = profile;
  const names = contact.name.trim().split(/\s+/).filter(Boolean);
  const current = profile.experiences.find((e) => e.end.trim() === '');
  switch (field) {
    case 'fullName': return fit(contact.name, q);
    case 'firstName': return names.length >= 2 ? fit(names[0], q) : undefined;
    case 'lastName': return names.length >= 2 ? fit(names.slice(1).join(' '), q) : undefined;
    case 'email': return fit(contact.email, q);
    case 'phone': return fit(contact.phone, q);
    case 'location': return fit(contact.location, q);
    case 'country': return countryAnswer(contact.location, q);
    case 'linkedin': case 'github': case 'portfolio': return fit(linkFor(profile, field), q);
    case 'currentCompany': return fit(current?.company, q);
    case 'currentTitle': return fit(current?.title, q);
  }
}

const LEGAL_SUFFIX = /( (ltda|s a|sa|inc|llc|ltd|limited|corp|corporation|gmbh|me|eireli|co))+$/;
const companyKey = (name: string) => normalizeQuestionText(name).replace(LEGAL_SUFFIX, '').trim();
/** Mesma empresa: um nome contém o outro, palavra por palavra ("Acme" e "Acme Brasil Ltda"). */
function sameCompany(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (x === '' || y === '') return false;
  return ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

const YES = ['yes', 'sim'];
const NO = ['no', 'nao'];
function yesNo(answer: boolean, q: Question): AnswerValue | undefined {
  if (q.kind === 'boolean') return answer;
  if (q.options.length === 0) return undefined;
  const words = answer ? YES : NO;
  const hits = q.options.filter((o) => words.includes(normalizeQuestionText(o)));
  return hits.length === 1 ? hits[0] : undefined;
}

function workedHereAnswer(q: Question, ctx: RuleContext): AnswerValue | undefined {
  const company = companyKey(ctx.job.company);
  const pattern = workedHerePattern([...GENERIC_EMPLOYER, company]);
  if (company === '' || !pattern.test(normalizeQuestionText(q.label))) return undefined;
  return yesNo(ctx.profile.experiences.some((e) => sameCompany(e.company, ctx.job.company)), q);
}

const AGREE = /^(i agree|agree|i accept|accept|i consent|yes|sim|concordo|aceito|li e concordo|li e aceito)$/;
function consentAnswer(q: Question): AnswerValue | undefined {
  if (!q.required || !CONSENT.test(normalizeQuestionText(q.label))) return undefined;
  if (q.kind === 'boolean') return true;
  if (q.kind !== 'select' || q.options.length === 0) return undefined;
  const hits = q.options.filter((o) => AGREE.test(normalizeQuestionText(o)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Resposta de `identity`, `file`, `origin` e `consent` (e de "já trabalhou nesta empresa?", um `profile_fact`);
 * `undefined` quando a regra não sabe. Só responde o que as próprias regras reconhecem no rótulo: a categoria dada
 * pelo modelo escolhe a regra, nunca basta para responder.
 */
export function answerByRule(q: Question, category: QuestionCategory, ctx: RuleContext): AnswerValue | undefined {
  const label = normalizeQuestionText(q.label);
  switch (category) {
    case 'identity': {
      const field = identityField(q);
      return field ? identityAnswer(field, q, ctx.profile) : undefined;
    }
    case 'file':
      return q.kind === 'file' && RESUME_FILE.test(label) && !NOT_RESUME_FILE.test(label) && ctx.resumeFileName.trim() !== ''
        ? ctx.resumeFileName
        : undefined;
    case 'origin':
      return ORIGIN.test(label) ? fit(ctx.sourceLabel, q) : undefined;
    case 'consent':
      return consentAnswer(q);
    case 'profile_fact':
      return workedHereAnswer(q, ctx);
    default:
      return undefined;
  }
}

const DECLINE = /\bprefiro nao\b|\bprefer not\b|\bdecline\b|\b(do not|don t|dont) wish\b|\bnao (desejo|quero) (informar|responder|declarar|me identificar)\b|\bchoose not\b|\bnao informar\b|\brather not\b/;

/** Em pergunta demográfica obrigatória, a opção de não informar, se existir. */
export function declineOption(options: string[]): string | null {
  return options.find((o) => DECLINE.test(normalizeQuestionText(o))) ?? null;
}

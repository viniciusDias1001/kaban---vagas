import { normalizeQuestionText, optionKey, type AnswerValue, type CandidateProfile, type Question, type QuestionCategory } from '@kv/shared';
import type { ApplyJob } from '../types';
import { optionFor } from './bank';

/*
 * Todos os padrões rodam sobre `normalizeQuestionText`: minúsculas, sem acento, pontuação virando espaço.
 * Por isso estão escritos sem acento ("pretensao", "nao concorrencia", "e mail").
 */

/** Padrões, em português e inglês, que mandam na categoria seja o que for que o modelo diga. */
export const SENSITIVE_PATTERNS: readonly { category: 'personal' | 'demographic'; pattern: RegExp }[] = [
  // Salário e ganhos, em qualquer forma.
  { category: 'personal', pattern: /\bsalar|\bremunera|\bpretens|\bcompensation\b|\bpay\b|\bwages?\b|\bincome\b|\bearn(ing|ings)?\b|\b(hourly|daily|monthly|day|hour|bill|billing|expected|desired|target) rate\b|\brate (expectation|per hour|per day)\b|\bganhar\b|\bganhos?\b|\bganha\b|\brenda\b|\bvalor (hora|por hora|mensal)\b|\bregime (de contratacao|pj|clt)\b|\bpj\b|\bclt\b/ },
  // Visto, autorização e elegibilidade para trabalhar, cidadania e documentos.
  { category: 'personal', pattern: /\bvistos?\b|\bvisas?\b|\bsponsor|\bautoriza\w*( \w+){0,3} trabalh|\bpermissao de trabalho\b/ },
  { category: 'personal', pattern: /\bauthori[sz]\w*( \w+){0,2} (to )?work\b|\bwork authori[sz]|\bwork permit|\bright to work\b|\beligib\w*( \w+){0,2} (to )?work\b|\blegally (able|allowed|eligible|permitted)\b/ },
  { category: 'personal', pattern: /\bcitizen|\bcidada|\bnacionalidade\b|\bnationality\b|\bpassports?\b|\bpassaportes?\b|\bgreen card\b|\bpermanent residen|\bresiden\w* permanente\b/ },
  // Antecedentes, prisões, crimes e declarações legais.
  { category: 'personal', pattern: /\bantecedentes\b|\bcriminal|\bbackground check|\bconvict|\bcondenad|\barrest|\bpres[oa]\b|\bprisao\b|\bcrimes?\b|\bfelon|\bmisdemeanou?r|\bdismissed\b|\bfired\b|\bjusta causa\b/ },
  // Viagens e deslocamento: compromisso do dono.
  { category: 'personal', pattern: /\btravel|\bviaja|\bviagens?\b|\bcommut|\bdeslocamento\b/ },
  { category: 'personal', pattern: /\bnao concorrencia\b|\bnon ?compete\b|\bemployment agreement|\bacordo de nao/ },
  // Referências.
  { category: 'personal', pattern: /\breferenc/ },
  // Mudança de cidade.
  { category: 'personal', pattern: /\bmudanca\b|\bmudar (de|para)\b|\bmudaria\b|\bse mudar\b|\brelocat|\bmov(e|ing) to\b/ },
  // Disponibilidade e início.
  { category: 'personal', pattern: /\bdisponibilidade\b|\bdisponivel\b|\bavailab|\baviso previo\b|\bnotice period\b|\bstart date\b|\bdata de inicio\b|\bcan you start\b|\bpode comecar\b|\bpoderia comecar\b|\bquando (voce )?(pode|poderia) (comecar|iniciar)\b|\bhow soon\b/ },
  // Dados demográficos.
  { category: 'demographic', pattern: /\bgenero\b|\bgender\b|\bsexo\b|\bpronouns?\b|\bpronomes?\b/ },
  { category: 'demographic', pattern: /\bracas?\b|\betnia|\betnic|\brace\b|\bethnic|\bhispanic|\blatin[oa]\b|\bautodeclar|\bnegr[oa]s?\b|\bpard[oa]s?\b|\bindigena|\bcor da pele\b/ },
  { category: 'demographic', pattern: /\bdeficien|\bpcds?\b|\bdisabilit/ },
  { category: 'demographic', pattern: /\bveteran/ },
  { category: 'demographic', pattern: /\borientacao sexual\b|\bsexual orientation\b/ },
  { category: 'demographic', pattern: /\bidade\b|\bdata de nascimento\b|\bano de nascimento\b|\bdate of birth\b|\bbirth ?(date|year)\b|\byear of birth\b|\byears old\b|\bhow old\b|\bmaior de (18|21|idade)\b|\bmenor de idade\b|\b(over|at least) (18|21)\b|\b(18|21) years of age\b/ },
];

export interface RuleContext {
  profile: CandidateProfile;
  job: ApplyJob;
  /** Nome da fonte da vaga, para "como soube da vaga?". */
  sourceLabel: string;
  resumeFileName: string;
  /** A mesma etapa tem um campo de sobrenome: "Nome"/"Name" sozinho é o primeiro nome. `resolveAnswers` preenche. */
  splitName?: boolean;
}

/** O texto do rótulo sem cortesia no começo nem "(opcional)" no fim, para os campos de contato. */
function fieldName(label: string): string {
  return normalizeQuestionText(label)
    .replace(/^(please )?(enter |informe |digite )?(your |seu |sua |o seu |a sua )?/, '')
    .replace(/( optional| opcional| required| obrigatorio)+$/, '')
    .trim();
}

type IdentityField = 'name' | 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'location' | 'country' | 'linkedin' | 'github'
  | 'portfolio' | 'currentCompany' | 'currentTitle';

const IDENTITY_FIELDS: readonly [IdentityField, RegExp][] = [
  ['name', /^(name|nome)$/],
  ['fullName', /^(full|legal|complete) name$|^nome completo$/],
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

/** A etapa pede o sobrenome em campo próprio: um "Nome"/"Name" sozinho nela é o primeiro nome. */
export function hasLastNameField(questions: Question[]): boolean {
  return questions.some((q) => identityField(q) === 'lastName');
}

const ORIGIN = /\bcomo (voce )?(soube|ficou sabendo|conheceu|encontrou)\b|\bonde (voce )?(soube|viu|encontrou)\b|\bhow did you (hear|find|learn|come across)\b|\bwhere did you (hear|find|see)\b/;
/**
 * Os únicos objetos de consentimento que a regra aceita: privacidade, termos e a veracidade da própria candidatura.
 * Concordar, aceitar ou declarar qualquer outra coisa é um compromisso do dono: vai para `personal`.
 */
const CONSENT_OBJECT = new RegExp([
  /\b(politica|aviso|declaracao) de privacidade\b|\bprivacy (policy|notice|statement)\b|\bcandidate privacy\b/.source,
  /\btermos (de (uso|servico)|e condicoes)\b|\bterms (of (use|service)|and conditions)\b/.source,
  /\blgpd\b|\bgdpr\b|\btratamento (de |dos )?(meus )?dados\b|\bdata processing\b|\bprocessing of (my )?personal data\b/.source,
  /\binformac\w*\b.*\bverdadeir|\b(information|answers|details|statements)\b.*\b(true|accurate|complete|correct|truthful)\b|\bcertify\b.*\btrue\b/.source,
].join('|'));
/** Um segundo compromisso emendado ("... privacy policy and to work on-site"): deixa de ser só consentimento. */
const COMPOUND = /\b(and|e) (to|a|o|as|os|em|que|i)\b/;
/** Verbos de concordância, aceite ou declaração, em qualquer pessoa. */
const AGREEMENT = /\b(agree|agrees|accept|accepts|consent|consents|acknowledge|acknowledges|certify|concordo|concorda|concordar|aceito|aceita|aceitar|consinto|declaro|certifico|autorizo|estou ciente)\b|\bi (confirm|declare|understand)\b|\bconfirmo que\b/;
const RESUME_FILE = /\bresume\b|\bcurriculo\b|\bcurriculum\b|\bcv\b/;
const NOT_RESUME_FILE = /\bcover letter\b|\bcarta\b/;

/** Quem a pergunta chama de empregador sem dizer o nome. `aqui` só vale como última palavra. */
const SELF_EN = ['us', 'this company', 'our company'];
const SELF_PT_AFTER_PREP = ['nossa empresa'];
const SELF_PT_ALONE = ['nesta empresa', 'aqui'];

/**
 * Pergunta sobre ter trabalhado NA empregadora: verbo de emprego, preposição de lugar (nunca "with"/"com") e, fechando
 * a frase, o nome da empresa ou uma referência a ela mesma.
 */
function workedHerePattern(companies: string[]): RegExp {
  const names = companies.filter((c) => c !== '');
  const en = [...SELF_EN, ...names].join('|');
  const ptAfterPrep = [...SELF_PT_AFTER_PREP, ...names].join('|');
  const ptAlone = SELF_PT_ALONE.join('|');
  const enRule = `\\b(worked|been employed|employed|consulted)( (previously|before|ever|already|directly))? (at|for|by) (${en})( (before|previously|in the past))?$`;
  const ptVerb = '(trabalhou|prestou servicos?|foi (funcionari[oa]|colaborador[a]?))';
  const ptPrep = '(na|no|para a|para o|pela|pelo|da|do)';
  const ptRule = `\\b${ptVerb}( (anteriormente|antes|alguma vez|ja))? (${ptPrep} (${ptAfterPrep})|${ptAlone})( (antes|anteriormente))?$`;
  return new RegExp(`${enRule}|${ptRule}`);
}
const WORKED_HERE_GENERIC = workedHerePattern([]);

/** Consentimento: um dos objetos permitidos, sem outro compromisso emendado. Recebe o rótulo normalizado. */
function isConsent(label: string): boolean {
  return CONSENT_OBJECT.test(label) && !COMPOUND.test(label);
}

/** A categoria que as regras conhecem, ou null. Os padrões sensíveis são conferidos primeiro, no rótulo, na ajuda e nas opções. */
export function classifyByRule(q: Question): QuestionCategory | null {
  const texts = [q.label, q.help, ...q.options].map(normalizeQuestionText);
  for (const { category, pattern } of SENSITIVE_PATTERNS) if (texts.some((t) => pattern.test(t))) return category;
  if (q.kind === 'file') return 'file';
  const label = normalizeQuestionText(q.label);
  if (isConsent(label)) return 'consent';
  if (AGREEMENT.test(label) || CONSENT_OBJECT.test(label)) return 'personal';
  if (ORIGIN.test(label)) return 'origin';
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

function identityAnswer(field: IdentityField, q: Question, profile: CandidateProfile, splitName: boolean): AnswerValue | undefined {
  const { contact } = profile;
  const names = contact.name.trim().split(/\s+/).filter(Boolean);
  const current = profile.experiences.find((e) => e.end.trim() === '');
  switch (field) {
    case 'name': return splitName ? identityAnswer('firstName', q, profile, splitName) : fit(contact.name, q);
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

/** Palavras que não distinguem uma empresa de outra: forma societária, conectivos e termos genéricos. */
const NOT_SIGNIFICANT = new Set([
  'ltda', 's', 'a', 'sa', 'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'companhia',
  'cia', 'me', 'eireli', 'epp', 'gmbh', 'plc', 'ag', 'bv', 'nv', 'srl', 'spa', 'sas', 'pty', 'group', 'grupo', 'holding',
  'tecnologia', 'tecnologias', 'technology', 'technologies', 'tech', 'brasil', 'brazil', 'do', 'da', 'de', 'dos', 'das', 'e',
  'and', 'the', 'of',
]);
/** Palavras que identificam a empresa: "Acme Tecnologia Ltda" → ["acme"]; "Minsait (Indra)" → ["minsait", "indra"]. */
function significantTokens(name: string): string[] {
  return normalizeQuestionText(name).split(' ').filter((w) => w !== '' && !NOT_SIGNIFICANT.has(w));
}

/** "Não", na forma da pergunta: booleano ou a única opção "No"/"Não"; senão a regra não sabe. */
function plainNo(q: Question): AnswerValue | undefined {
  if (q.kind === 'boolean') return false;
  if (q.options.length === 0) return undefined;
  const hits = q.options.filter((o) => ['no', 'nao'].includes(normalizeQuestionText(o)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * "Já trabalhou nesta empresa?". Responde só "não", e só quando a empresa da vaga não divide nenhuma palavra
 * significativa com nenhuma empresa do perfil: uma diferença de nome nunca nega um ex-empregador. Qualquer
 * palavra em comum vai ao dono; "sim" nunca é automático (costuma abrir outras perguntas).
 */
function workedHereAnswer(q: Question, ctx: RuleContext): AnswerValue | undefined {
  const jobTokens = significantTokens(ctx.job.company);
  if (jobTokens.length === 0 || !isWorkedHereQuestion(q, ctx)) return undefined;
  const shared = ctx.profile.experiences.some((e) => significantTokens(e.company).some((t) => jobTokens.includes(t)));
  return shared ? undefined : plainNo(q);
}

/**
 * A pergunta é "já trabalhou na empresa desta vaga?". Quando é, só a regra responde (um "não" seguro) e, se ela
 * não souber, a pergunta vai direto ao dono: nem resposta salva, nem proposta, nem modelo.
 */
export function isWorkedHereQuestion(q: Question, ctx: RuleContext): boolean {
  const company = normalizeQuestionText(ctx.job.company);
  const core = significantTokens(ctx.job.company).join(' ');
  return workedHerePattern([company, core]).test(normalizeQuestionText(q.label));
}

const AGREE = /^(i agree|agree|i accept|accept|i consent|yes|sim|concordo|aceito|li e concordo|li e aceito)$/;
function consentAnswer(q: Question): AnswerValue | undefined {
  if (!q.required || !isConsent(normalizeQuestionText(q.label))) return undefined;
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
      return field ? identityAnswer(field, q, ctx.profile, ctx.splitName === true) : undefined;
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

const DECLINE = /\bprefiro nao\b|\bprefer not\b|\bdecline\b|\b(do not|don t|dont) (wish|want)\b|\bnao (desejo|quero) (informar|responder|declarar|me identificar)\b|\bchoose not\b|\bnao informar\b|\brather not\b/;

/** Em pergunta demográfica obrigatória, a opção de não informar, se existir. */
export function declineOption(options: string[]): string | null {
  return options.find((o) => DECLINE.test(normalizeQuestionText(o))) ?? null;
}

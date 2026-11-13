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
  { category: 'personal', pattern: /\b(expected|desired|annual|total|salary|compensation|remuneration|pay) package\b|\bquanto\b.*\breceber\b|\breceber (por|ao) (mes|hora|ano|dia)\b/ },
  // Visto, autorização e elegibilidade para trabalhar, cidadania e documentos.
  { category: 'personal', pattern: /\bvistos?\b|\bvisas?\b|\bsponsor|\bautoriza\w*( \w+){0,3} trabalh|\bpermissao de trabalho\b|\bemployer support\b|\bsupport to work\b|\bimmigration\b|\bimigra/ },
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
  { category: 'personal', pattern: /\bem quanto tempo\b|\bassumir (a vaga|o cargo|a posicao|a funcao)\b|\b(weeks?|days?|months?|semanas|dias|meses) (of )?notice\b|\bgive notice\b|\bnotice (to give|do you need)\b/ },
  // Dados demográficos.
  { category: 'demographic', pattern: /\bgenero\b|\bgender\b|\bsexo\b|\bpronouns?\b|\bpronomes?\b/ },
  { category: 'demographic', pattern: /\bracas?\b|\betnia|\betnic|\brace\b|\bethnic|\bhispanic|\blatin[oa]\b|\bautodeclar|\bnegr[oa]s?\b|\bpard[oa]s?\b|\bindigena|\bcor\b/ },
  { category: 'demographic', pattern: /\bdeficien|\bpcds?\b|\bdisabilit/ },
  { category: 'demographic', pattern: /\bveteran|\bforcas armadas\b|\barmed forces\b|\bmilitar(es)?\b|\bmilitary\b|\bserved in the (army|navy|air force)\b|\breservista/ },
  { category: 'demographic', pattern: /\borientacao sexual\b|\bsexual orientation\b/ },
  { category: 'demographic', pattern: /\bidade\b|\bdata de nascimento\b|\bano de nascimento\b|\bdate of birth\b|\bbirth ?(date|year)\b|\byear of birth\b|\byears old\b|\bhow old\b|\bmaior de (18|21|idade)\b|\bmenor de idade\b|\b(over|at least) (18|21)\b|\b(18|21) years of age\b|\bage\b|\bquantos anos (voce )?tem\b(?! (de|em|com) )|\b(mais|menos) de (18|21) anos\b|\b(18|21) (or|ou) (older|over|more|mais)\b|\b(18|21) anos ou mais\b/ },
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
/*
 * Consentimento por resto. Um rótulo é consentimento só quando, tirando dele as expressões de concordância, os objetos
 * permitidos (privacidade, termos, tratamento dos dados para a candidatura, veracidade da candidatura), o nome inteiro
 * da empresa da vaga e uma lista fixa de palavras de ligação, não sobra nada. Qualquer palavra que sobre diz algo mais,
 * e esse algo mais seria um compromisso em nome do dono. O teste marca o que é permitido e recusa o resto: a pontuação
 * vira fronteira (R1), palavras que apontam nunca saem (R2), demonstrativos só antes de objeto ou da candidatura (R3),
 * "that"/"que" só abrindo oração (R4), a empresa só pelo nome inteiro (R6), "all"/"todas" só na veracidade (R7).
 */

/** Concordância, aceite, ciência ou declaração, sobre o rótulo normalizado. */
const AGREEMENT_SOURCE = [
  'i (have |ve )?read', 'have read', 'i give (my )?consent', 'dou (o )?meu consentimento',
  'agree', 'agrees', 'agreed', 'agreeing', 'accept', 'accepts', 'accepted', 'accepting', 'consent', 'consents', 'consented',
  'consenting', 'acknowledge', 'acknowledges', 'acknowledged', 'acknowledging', 'certify', 'certifies', 'attest', 'affirm',
  'understood', 'i (confirm|declare|understand)',
  // "eu" só como sujeito da concordância: solto, sobraria (e "EU" pode ser a União Europeia).
  '(eu )?(li|concordo|aceito|consinto|declaro|confirmo|certifico|atesto|autorizo)', 'ter lido', 'lido', 'concorda', 'concordamos', 'concordar',
  'aceita', 'aceitar', 'aceite', '(eu )?(estou |esta |fico |estamos )?cientes?', '(eu )?(estou|esta|fico|estamos) de acordo', 'compreendi',
  'compreendo', 'entendi',
].map((x) => `\\b${x}\\b`).join('|');
const AGREEMENT = new RegExp(AGREEMENT_SOURCE);

/** Sufixo que faz LGPD/GDPR contar: só junto de uma frase de tratamento de dados. */
const UNDER_LAW = '( (under|in accordance with|according to|as per|per|pursuant to|in line with) (the )?(gdpr|lgpd)'
  + '| (conforme|de acordo com|nos termos da|segundo|em conformidade com) (a )?(lgpd|lei geral de protecao de dados( pessoais)?))?';
/** Objetos que a regra aceita, sem a veracidade (que é tratada à parte). Na ordem em que são tirados do rótulo. */
const CONSENT_OBJECTS: readonly RegExp[] = [
  // Tratamento dos dados para a candidatura; LGPD e GDPR só dentro dessa frase ou junto de "consent"/"consentimento".
  new RegExp(`\\b((the )?processing (of )?(my )?(personal )?data|(personal )?data processing|tratamento (de |dos |da |das )?(meus |minhas )?(dados|informacoes)( pessoais)?)${UNDER_LAW}`, 'g'),
  /\b(gdpr|lgpd) consent\b|\bconsent (under|per) (the )?(gdpr|lgpd)\b|\bconsentimento (lgpd|gdpr)\b|\bconsentimento (de acordo com|conforme) (a )?lgpd\b/g,
  // Privacidade.
  /\b((politicas?|avisos?|declaracao|termos?) de privacidade|(politica|aviso) de protecao de dados( pessoais)?|((candidate|applicant) )?privacy (policy|policies|notice|statement)|data protection (policy|notice)|candidate privacy)\b/g,
  // Termos de uso ou serviço; "termos e condições" só quando não seguidos "de trabalho", "do contrato", "of employment"...
  /\b(termos de (uso|servico|utilizacao)|terms of (use|service))\b/g,
  /\b(termos (e )?condicoes( de uso)?|terms (and )?conditions( of (use|service))?)\b(?! (of|for|de|do|da|dos|das|para)\b)/g,
];
/** Veracidade: o que foi informado (substantivo) seguido de "verdadeiro", "correto"... dentro de um mesmo trecho. */
const INFO_NOUN = '(information|informacoes|informacao|answers|respostas|details|statements|declaracoes|dados|data)';
const TRUTH_NOUN = `(${INFO_NOUN.slice(1, -1)}|application|candidatura)`;
const TRUTH_ADJ = '(true|accurate|complete|correct|truthful|verdadeir[ao]s?|veridic[ao]s?|corret[ao]s?|complet[ao]s?|exat[ao]s?)';
const TRUTH = new RegExp(`\\b${TRUTH_NOUN}\\b.*\\b${TRUTH_ADJ}\\b`);
const TRUTH_WORDS = new RegExp(`\\b(${TRUTH_NOUN}|${TRUTH_ADJ})\\b`, 'g');
const TRUTH_ADJ_ONLY = new RegExp(`^${TRUTH_ADJ}$`);
/**
 * R7: "all"/"todas" só logo antes do substantivo da própria frase de veracidade ("all (of) (the) information ... true",
 * "todas as informações ... verdadeiras"): nenhum outro substantivo de informação entre ele e o adjetivo.
 */
const ALL_INFO = new RegExp(`\\b(all|todas|todos)( of)?( the| my| as| os| minhas| meus)? ${INFO_NOUN}\\b`
  + `(?!.*\\b${INFO_NOUN}\\b.*\\b${TRUTH_ADJ}\\b)(?=.*\\b${TRUTH_ADJ}\\b)`, 'g');
/** "provided"/"prestadas" só dentro de uma frase de veracidade (fora dela apontam para um conteúdo não dito). */
const TRUTH_PROVIDED = /\b((i )?(have )?provided|fornecid[ao]s?|prestad[ao]s?)\b/g;

/**
 * R3: as frases da candidatura que um demonstrativo pode determinar. "process", "processo", "selection", "seleção" e
 * "hiring" sozinhos não estão aqui (continuam palavras de ligação, mas um demonstrativo antes deles sobra).
 */
const APPLICATION_PHRASE = new RegExp('\\b(job application|application|candidatura|recruitment process|selection process|hiring process'
  + '|recruitment|recrutamento|processo seletivo|processo de recrutamento|processo de selecao|formulario|form)\\b', 'g');
/** R3: os demonstrativos aceitos, e só logo antes de um objeto (`#`) ou de uma frase da candidatura (`&`). */
const DEMONSTRATIVE = '(this|these|este|esta|estes|estas|esse|essa|esses|essas|deste|desta|destes|destas|desse|dessa|desses|dessas'
  + '|neste|nesta|nestes|nestas|nesse|nessa)';

/**
 * R2: palavras que apontam para um conteúdo que o rótulo não diz. Nunca são ligação e nenhuma frase aceita as contém,
 * então sempre sobram. "a seguir" sobra por "seguir"; "o mesmo" por "mesmo".
 */
const POINTING = new Set([
  'above', 'below', 'following', 'foregoing', 'aforementioned', 'aforesaid', 'herein', 'hereto', 'hereunder', 'here', 'there', 'linked',
  'attached', 'enclosed', 'same', 'such', 'said', 'it', 'them', 'those', 'acima', 'abaixo', 'seguir', 'seguinte', 'seguintes',
  'anexo', 'anexa', 'anexos', 'anexas', 'mesmo', 'mesma', 'mesmos', 'mesmas', 'tal', 'tais', 'referido', 'referida', 'referidos',
  'referidas', 'supracitado', 'supracitada', 'supracitados', 'supracitadas', 'isso', 'isto', 'aquilo', 'aqui', 'ali', 'disso', 'disto',
  'nisso', 'nisto', 'daquilo', 'naquilo', 'aquele', 'aquela', 'aqueles', 'aquelas',
]);

/**
 * Palavras de ligação que podem sobrar num consentimento com expressão de concordância. Lista fechada. Ficam de fora,
 * de propósito, as que têm outro sentido: "no" (negação em inglês), "us" (EUA) e "eu" (União Europeia); as que apontam
 * (R2); os demonstrativos (R3); e "all"/"any"/"todos"/"qualquer" (R7).
 */
const CONSENT_FILLER = new Set([
  // Artigos, preposições, conjunções.
  'the', 'a', 'an', 'o', 'os', 'as', 'um', 'uma', 'of', 'to', 'in', 'on', 'at', 'with', 'by', 'for', 'from', 'de', 'da', 'do',
  'das', 'dos', 'em', 'na', 'nos', 'nas', 'ao', 'aos', 'com', 'por', 'pelo', 'pela', 'para', 'and', 'e', 'or', 'ou',
  // Pronomes, "s" do possessivo ("Acme's" vira "acme s"). "that"/"que" são tratados à parte (R10).
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'its', 'meu', 'meus', 'minha', 'minhas', 'voce', 'seu', 'sua',
  'seus', 'suas', 'nosso', 'nossa', 's',
  // Cópulas da veracidade; "hereby" aponta para o próprio ato, não para um conteúdo.
  'is', 'are', 'sao', 'estao', 'hereby',
  // O resto da lista do controlador. Fora (fix round 5): verbos de ação (R9, só nas frases de ato), have/has/been/ter
  // (afirmariam um fato), provided/prestadas (só na veracidade), information/data/personal (sozinhos dizem "e os
  // dados"), accordance/according/conforme (só antes de um objeto).
  'please', 'understand', 'application', 'candidatura', 'form', 'formulario', 'recruitment', 'recrutamento', 'selection', 'selecao',
  'seletivo', 'hiring', 'process', 'processo', 'candidate', 'candidato', 'candidata', 'applicant', 'required', 'obrigatorio',
  'obrigatoria',
]);
/** Sem expressão de concordância, só o nome do objeto: "Privacy Policy", "Termos de uso e política de privacidade". */
const BARE_FILLER = new Set(['the', 'a', 'o', 'os', 'as', 'of', 'de', 'da', 'do', 'das', 'dos', 'and', 'e', 'or', 'ou', 's',
  'required', 'obrigatorio', 'obrigatoria']);

/** "purposes"/"fins" só dentro da frase da candidatura; "por meio desta" aponta para o ato. */
const PURPOSE_OR_ACT = new RegExp([
  `\\bfor (the )?purposes? of (this |the |my )?(application|recruitment|selection|hiring)( process)?\\b`,
  `\\bfor (this |the |my )?(application|recruitment|selection|hiring)( process)? purposes?\\b`,
  `\\bpara (os )?fins (de|do|da) (candidatura|recrutamento|selecao|processo seletivo)\\b`,
  `\\bpor meio (deste|desta)\\b`,
].join('|'), 'g');
/**
 * R9: os verbos de ação só valem dentro destas frases de ato, inteiras e sem fronteira. "please read"/"leia" só logo
 * antes de um objeto (com seu artigo). Também "in accordance with"/"conforme" só logo antes de um objeto.
 */
const ACT_PHRASES: readonly RegExp[] = [
  /\bby submitting( this| my| the)? (job application|application|form)\b/g,
  /\bao enviar( esta| minha| a)? (candidatura|inscricao)\b/g,
  /\bao enviar( este| meu| o)? formulario\b/g,
  /\bao me candidatar\b/g,
  /\b(please (read|review)|(por favor )?leia)( the| our| a| o| os| as| nossa| nosso| nossos| nossas)? (?=#( |$))/g,
  // ... ou logo antes de "and"/"e" mais uma expressão de concordância: "please review and acknowledge …", "leia e aceite …".
  new RegExp(`\\b(please (read|review)|(por favor )?leia) (and|e) (?=(?:${AGREEMENT_SOURCE}))`, 'g'),
  /\b(in accordance with|according to|conforme)( the| our| a| o| os| as)? (?=#( |$))/g,
];
/** R10: "that"/"que" abrem oração só antes destas palavras ou do começo de uma expressão de concordância. */
const CLAUSE_START = new Set(['the', 'a', 'an', 'my', 'i', 'all', 'any', 'this', 'these', 'o', 'os', 'as', 'meu', 'minha', 'meus',
  'minhas', 'eu', 'todas', 'todos', 'este', 'esta', 'estes', 'estas', 'li', 'estou']);
const AGREEMENT_AT_START = new RegExp(`^(?:${AGREEMENT_SOURCE})`);
const NOT_A_CLAUSE = new Set(['and', 'or', 'e', 'ou']);
/** R6: formas societárias que podem vir no fim do nome da empresa, no rótulo ou no cadastro da vaga. */
const LEGAL_SUFFIX = ['inc', 'llc', 'ltd', 'ltda', 's a', 'sa', 'gmbh', 'corp', 'corporation', 'co', 'plc', 'eireli', 'me'];

/*
 * Marcadores. Nenhum deles sobrevive a `consentTokens` vindo do texto (viram fronteira ou espaço), então só as
 * regras abaixo os põem: `#` objeto permitido, `&` frase da candidatura, `%` nome da empresa (R6b decide), `~` trecho
 * aceito (concordância, empresa na posição aceita, finalidade, demonstrativo consumido), `|` fronteira (R1).
 */
const OBJ = '#';
const APP = '&';
const USED = '~';
const BOUNDARY = '|';
/** R6b: o nome inteiro da empresa, ainda por decidir; sobra se não estiver numa das duas posições aceitas. */
const COMPANY = '%';
/** R6b: as preposições depois das quais o nome da empresa sai ("of (the)", "by (the)", "da", "pela"...). */
const COMPANY_PREPOSITION = ['of', 'by', 'from', 'with', 'at', 'de', 'da', 'do', 'pela', 'pelo', 'com', 'na', 'no'];

/**
 * R1: a normalização do teste de consentimento. Como `normalizeQuestionText`, mas a pontuação e a quebra de linha entre
 * palavras viram a fronteira `|`. Hífen e apóstrofo dentro da palavra ("on-site", "Acme's", "I've") viram espaço; "&" e
 * "+" viram "and" (R8). Qualquer outro sinal, "*" incluído, é fronteira.
 */
function consentTokens(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])['’‘-](?=[\p{L}\p{N}])/gu, ' ')
    .replace(/[&+]/g, ' and ')
    .replace(/[^\p{L}\p{N} \t]+/gu, ` ${BOUNDARY} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/** R6: o nome inteiro da empresa, em ordem e sem fronteira, com forma societária e "s" do possessivo opcionais. */
function companyPattern(company: string): RegExp | null {
  const tokens = normalizeQuestionText(company).split(' ').filter((w) => w !== '');
  for (;;) {
    const tail = tokens.slice(-2).join(' ');
    if (tokens.length > 2 && tail === 's a') tokens.splice(-2);
    else if (tokens.length > 1 && LEGAL_SUFFIX.includes(tokens.at(-1)!)) tokens.pop();
    else break;
  }
  if (tokens.length === 0 || (tokens.length === 1 && LEGAL_SUFFIX.includes(tokens[0]!))) return null;
  return new RegExp(`\\b${tokens.join(' ')}( (${LEGAL_SUFFIX.join('|')}))*( s)?\\b`, 'g');
}

/** Veracidade, trecho a trecho: um trecho com substantivo e adjetivo, e os trechos seguintes que só somam adjetivos. */
function markTruth(text: string): string {
  let open = false;
  return text.split(BOUNDARY).map((segment) => {
    if (TRUTH.test(segment)) {
      open = true;
      return segment.replace(ALL_INFO, ` ${OBJ} `).replace(TRUTH_PROVIDED, ` ${OBJ} `).replace(TRUTH_WORDS, ` ${OBJ} `);
    }
    const words = segment.split(' ').filter((w) => w !== '');
    if (open && words.length > 0 && words.every((w) => TRUTH_ADJ_ONLY.test(w) || NOT_A_CLAUSE.has(w)))
      return segment.replace(TRUTH_WORDS, ` ${OBJ} `);
    open = false;
    return segment;
  }).join(BOUNDARY);
}

/**
 * O que sobra do texto depois de marcar o que é permitido. Marca, em ordem: o nome da empresa, as finalidades aceitas,
 * os objetos, a veracidade, as frases da candidatura, os demonstrativos logo antes de objeto ou de frase da candidatura e
 * as expressões de concordância. Depois sobra toda palavra que não seja marcador, fronteira ou ligação; uma palavra que
 * aponta sobra sempre. Nenhuma frase casa através de uma fronteira: todas são escritas com espaço entre as palavras.
 */
function remainder(text: string, company: string, filler: ReadonlySet<string>): { object: boolean; left: string[] } {
  const pattern = companyPattern(company);
  const withAgreement = filler !== BARE_FILLER;
  let rest = consentTokens(text);
  // R10: decidido no texto ainda sem marcas; um "that"/"que" que não abre oração fica e sobra no fim.
  if (withAgreement) {
    rest = rest.replace(/\b(that|que)(?= )/g, (match: string, _w: string, offset: number, all: string) => {
      const after = all.slice(offset + match.length + 1);
      return CLAUSE_START.has(after.split(' ')[0]!) || AGREEMENT_AT_START.test(after) ? USED : match;
    });
  }
  if (pattern) rest = rest.replace(pattern, ` ${COMPANY} `);
  rest = rest.replace(PURPOSE_OR_ACT, ` ${USED} `);
  for (const object of CONSENT_OBJECTS) rest = rest.replace(object, ` ${OBJ} `);
  rest = markTruth(rest).replace(/\s+/g, ' ');
  const object = rest.includes(OBJ);
  // R6b: a empresa sai só logo antes de um objeto ou logo depois de uma preposição; em outro lugar, `%` sobra.
  rest = rest.replace(new RegExp(`${COMPANY} (?=${OBJ}( |$))`, 'g'), `${USED} `);
  rest = rest.replace(new RegExp(`\\b(${COMPANY_PREPOSITION.join('|')})( the)? ${COMPANY}(?= |$)`, 'g'), `$1$2 ${USED}`);
  for (const act of ACT_PHRASES) rest = rest.replace(act, ` ${USED} `);
  rest = rest.replace(APPLICATION_PHRASE, ` ${APP} `).replace(/\s+/g, ' ');
  rest = rest.replace(new RegExp(`\\b${DEMONSTRATIVE} (?=[${OBJ}${APP}]( |$))`, 'g'), `${USED} `);
  rest = rest.replace(new RegExp(AGREEMENT_SOURCE, 'g'), ` ${USED} `);
  const words = rest.split(/\s+/).filter((w) => w !== '');
  const left = words.filter((w) => {
    if (w === OBJ || w === USED || w === BOUNDARY) return false;
    // Sem concordância, "Privacy Policy - Application form" não é só o nome do objeto.
    if (w === APP) return !withAgreement;
    if (POINTING.has(w)) return true;
    return !filler.has(w);
  });
  return { object, left };
}

/**
 * `consent`: tirados concordância, objetos, nome da empresa e palavras de ligação, nada sobra (ou é só o nome do objeto),
 * nem no rótulo nem no texto de ajuda (que não precisa de concordância nem de objeto próprios).
 * `agreement`: tem expressão de concordância, ou passaria mas a ajuda diz algo mais; é compromisso do dono (`personal`).
 * `none`: nem uma coisa nem outra; as outras regras ou o modelo decidem.
 * É o único teste de consentimento: `classifyByRule` e `answerByRule` usam este.
 */
function consentVerdict(q: Question, company: string): 'consent' | 'agreement' | 'none' {
  const agreement = AGREEMENT.test(consentTokens(q.label));
  const { object, left } = remainder(q.label, company, agreement ? CONSENT_FILLER : BARE_FILLER);
  if (!object || left.length > 0) return agreement ? 'agreement' : 'none';
  if (q.help.trim() !== '' && remainder(q.help, company, CONSENT_FILLER).left.length > 0) return 'agreement';
  return 'consent';
}
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

/**
 * A categoria que as regras conhecem, ou null. Os padrões sensíveis são conferidos primeiro, no rótulo, na ajuda e nas opções.
 * `company` é a empresa da vaga: o nome dela pode aparecer num consentimento sem que isso seja "algo mais".
 */
export function classifyByRule(q: Question, company = ''): QuestionCategory | null {
  const texts = [q.label, q.help, ...q.options].map(normalizeQuestionText);
  for (const { category, pattern } of SENSITIVE_PATTERNS) if (texts.some((t) => pattern.test(t))) return category;
  if (q.kind === 'file') return 'file';
  const label = normalizeQuestionText(q.label);
  const consent = consentVerdict(q, company);
  if (consent === 'consent') return 'consent';
  if (consent === 'agreement') return 'personal';
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
/**
 * Só para o que `classifyByRule` chama de `consent`, com a mesma empresa: o mesmo `consentVerdict`, e antes dele os
 * padrões sensíveis ("the privacy policy available here" é `personal` por "availab").
 */
function consentAnswer(q: Question, company: string): AnswerValue | undefined {
  if (!q.required || classifyByRule(q, company) !== 'consent') return undefined;
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
      return consentAnswer(q, ctx.job.company);
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

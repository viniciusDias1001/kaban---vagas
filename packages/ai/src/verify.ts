import { LIMITS, type CandidateProfile, type ResumeLang, type TailoredDraft, type TailoredResume, type Violation, type ViolationCode } from '@kv/shared';
import {
  STOPWORDS, allowedNumbers, buildTermIndex, contentStems, findPhrase, foldText, foldedWords, hasControlChars, isKnownTerm,
  normalizeText, novelTerms, numberIds, stem, type TermIndex,
} from './text';

/**
 * Números citados em um texto, em forma canônica simples: "1.000" e "1,000" viram "1000"; "1,5" vira "1.5";
 * "40%" vira "40". Dígitos de outras escritas (largura total, arábico-índicos) são lidos como ASCII.
 * Mantida por compatibilidade: o verificador usa `numberIds` (text.ts), que inclui magnitude, unidade,
 * moeda, datas e números por extenso na identidade.
 */
export function numbersIn(text: string): string[] {
  return (normalizeText(text).match(/\d+(?:[.,]\d+)*/g) ?? []).map((raw) =>
    /^\d{1,3}([.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.'),
  );
}

export interface ResolveOptions {
  /** Nome da empresa da vaga: não pode aparecer nos textos reescritos se não for uma empresa do perfil. */
  jobCompany?: string;
  /** Título da vaga: cada palavra dele que aparecer no texto gerado tem de existir no perfil. */
  jobTitle?: string;
  /**
   * Palavras-chave da vaga (ex.: `keywordsMissing` e `keywordsPresent` da camada 2). Uma palavra-chave que
   * aparece no texto gerado e não existe no perfil é o jeito mais provável de um modelo "rechear" o currículo.
   */
  jobKeywords?: readonly string[];
}

export interface Resolved {
  /** O currículo com empresa, cargo, datas, formação, habilidades etc. COPIADOS do perfil. */
  resume: TailoredResume;
  /** Vazio = aprovado. Para saída de modelo, qualquer item bloqueia o resultado. */
  violations: Violation[];
}

/** Sufixos societários que não fazem parte do nome pelo qual a empresa é citada. */
const LEGAL_SUFFIXES = new Set([
  'ltda', 'sa', 'inc', 'incorporated', 'llc', 'llp', 'gmbh', 'corp', 'corporation', 'co', 'company', 'me', 'eireli', 'epp',
  'ltd', 'limited', 'plc', 'ag', 'bv', 'nv', 'srl', 'spa', 'sas', 'pty', 'cia',
]);

/** Núcleo do nome de uma empresa, em tokens dobrados: "Acme Fictícia Ltda." → ["acme", "ficticia"]. */
export function companyCore(name: string): string[] {
  const words = foldedWords(name);
  let end = words.length;
  while (end > 1) {
    if (LEGAL_SUFFIXES.has(words[end - 1])) end -= 1;
    else if (end > 2 && words[end - 1] === 'a' && words[end - 2] === 's') end -= 2; // "S.A.", "S/A"
    else break;
  }
  return words.slice(0, end);
}

/** Todos os textos do perfil, menos os ids: onde um termo pode "existir". */
export function profileTexts(p: CandidateProfile): string[] {
  return [
    p.contact.name, p.contact.email, p.contact.phone, p.contact.location, p.summary,
    ...p.experiences.flatMap((e) => [e.company, e.title, e.start, e.end, e.location, ...e.achievements.map((a) => a.text)]),
    ...p.education.flatMap((e) => [e.institution, e.degree, e.start, e.end]),
    ...p.skills.map((k) => k.name),
    ...p.languages.flatMap((l) => [l.name, l.level]),
    ...p.certifications.flatMap((c) => [c.name, c.issuer, c.date]),
    ...p.links.flatMap((l) => [l.label, l.url]),
  ];
}

/**
 * Textos do perfil de onde um número do resumo pode vir. Ficam de FORA ids, telefone, e-mail, URLs e
 * rótulos de link: os dígitos deles não são fatos do currículo.
 */
export function numericTexts(p: CandidateProfile): string[] {
  return [
    p.summary,
    ...p.experiences.flatMap((e) => [e.company, e.title, e.start, e.end, ...e.achievements.map((a) => a.text)]),
    ...p.education.flatMap((e) => [e.institution, e.degree, e.start, e.end]),
    ...p.skills.map((k) => k.name),
    ...p.languages.flatMap((l) => [l.name, l.level]),
    ...p.certifications.flatMap((c) => [c.name, c.issuer, c.date]),
  ];
}

/** Palavras do título e palavras-chave da vaga que NÃO existem no perfil, como sequências de tokens dobrados. */
function foreignJobTerms(opts: ResolveOptions, index: TermIndex): { phrase: string[]; label: string }[] {
  const out = new Map<string, { phrase: string[]; label: string }>();
  const significant = (w: string) => !STOPWORDS.has(w) && (w.length >= 3 || /[0-9+#]/.test(w) || w.length === 2);
  const add = (label: string) => {
    const phrase = foldedWords(label);
    if (phrase.length === 0 || phrase.length > 6 || !phrase.some((w) => significant(w) && !/^\d+$/.test(w))) return;
    if (phrase.length === 1 && phrase[0].length < 2) return;
    const known = phrase.length === 1
      ? isKnownTerm(phrase[0], index)
      : index.phrase.includes(` ${phrase.join(' ')} `) || phrase.every((w) => STOPWORDS.has(w) || isKnownTerm(w, index));
    if (!known) out.set(phrase.join(' '), { phrase, label: label.trim() });
  };
  for (const word of normalizeText(opts.jobTitle ?? '').split(/[^\p{L}\p{N}+#.]+/u)) {
    const w = word.replace(/^\.+|\.+$/g, '');
    if (w && !STOPWORDS.has(foldText(w))) add(w);
  }
  for (const keyword of opts.jobKeywords ?? []) add(keyword.slice(0, 200));
  return [...out.values()];
}

/**
 * Verificador de não invenção. Recebe o rascunho (referências + textos livres) e o perfil, e:
 *
 * 1. exige que todo id exista no perfil e apareça uma vez só (`unknown_id`, `duplicate_id`); a
 *    realização referenciada tem de pertencer à experiência em que foi posta;
 * 2. monta o currículo copiando do perfil tudo que não é texto livre: o modelo não tem como alterar
 *    empresa, cargo, data, formação, certificação, idioma ou habilidade;
 * 3. aplica aos textos e listas os mesmos limites da edição manual (`limit`): tamanho, quantidade, sem NUL
 *    nem caracteres de controle;
 * 4. exige que todo número de uma realização reescrita exista na realização original, e que todo número
 *    do resumo exista em um campo de conteúdo do perfil (`new_number`). A identidade do número inclui
 *    magnitude, `%`/`x`, moeda e unidade colada; números por extenso simples também são lidos;
 * 5. recusa, no resumo e nas realizações, nome próprio, sigla, termo técnico, palavra de cargo/formação e
 *    palavra do título ou das palavras-chave da vaga que não exista em lugar nenhum do perfil
 *    (`novel_term`), e a realização cujo texto não compartilha nenhuma palavra de conteúdo com a original
 *    (`unrelated_text`);
 * 6. recusa o nome da empresa da vaga dentro dos textos, se ela não é uma empresa do perfil (`foreign_company`).
 *
 * Itens com id inválido ficam fora do currículo devolvido, que só deve ser usado se `violations` estiver
 * vazio (saída de modelo) ou só tiver avisos aceitos por quem chama (edição do usuário).
 *
 * O que NÃO é detectado: ver LIMITE CONHECIDO no fim deste arquivo.
 */
export function resolveTailored(
  draft: TailoredDraft,
  profile: CandidateProfile,
  lang: ResumeLang,
  opts: ResolveOptions = {},
): Resolved {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const limit = (path: string, message: string) => violations.push({ code: 'limit', path, message });

  function capped<T>(items: T[], max: number, path: string, what: string): T[] {
    if (items.length <= max) return items;
    limit(path, `${what}: ${items.length} itens (o máximo é ${max})`);
    return items.slice(0, max);
  }
  const idOk = (id: string, path: string): boolean => {
    if (typeof id === 'string' && id.length <= LIMITS.profileShort && !hasControlChars(id)) return true;
    limit(path, 'identificador longo demais ou com caractere de controle');
    return false;
  };

  function pick<T extends { id: string }>(items: T[], ids: string[], field: string, what: string): T[] {
    const out: T[] = [];
    capped(ids, LIMITS.profileItems, field, what).forEach((id, i) => {
      const path = `${field}[${i}]`;
      if (!idOk(id, path)) return;
      const found = items.find((item) => item.id === id);
      if (!found) violations.push({ code: 'unknown_id', path, message: `${what} "${id}" não existe no perfil` });
      else if (seen.has(id)) violations.push({ code: 'duplicate_id', path, message: `${what} "${id}" aparece mais de uma vez` });
      else {
        seen.add(id);
        out.push(found);
      }
    });
    return out;
  }

  const index = buildTermIndex(profileTexts(profile));
  const profileNumbers = allowedNumbers(numericTexts(profile));
  const jobTerms = foreignJobTerms(opts, index);

  const company = opts.jobCompany ? companyCore(opts.jobCompany) : [];
  const companyCased = /\p{Lu}/u.test(normalizeText(opts.jobCompany ?? ''));
  const companyChecked = company.length > 0 && company.join('').length >= 2;
  const companyIsForeign =
    companyChecked && !profile.experiences.some((e) => findPhrase(foldedWords(e.company), company).length > 0);

  /** Limites primeiro: texto fora do limite não passa pelas outras conferências (tempo limitado). */
  function textOk(text: string, path: string): boolean {
    let ok = true;
    if (text.length > LIMITS.profileLong) {
      limit(path, `texto com ${text.length} caracteres (o máximo é ${LIMITS.profileLong})`);
      ok = false;
    }
    if (hasControlChars(text.length > LIMITS.profileLong ? text.slice(0, LIMITS.profileLong) : text)) {
      limit(path, 'o texto contém NUL ou caractere de controle');
      ok = false;
    }
    return ok;
  }

  function checkText(text: string, allowed: Set<string>, path: string, where: string) {
    for (const n of numberIds(text)) {
      if (allowed.has(n)) continue;
      violations.push({ code: 'new_number', path, detail: n, message: `o número "${displayNumber(n)}" não está ${where}` });
    }
    for (const term of novelTerms(text, index, { mode: 'full' })) {
      // O nome da empresa da vaga já sai como `foreign_company`: não repetir como termo novo.
      if (companyIsForeign && company.includes(foldText(term))) continue;
      violations.push({ code: 'novel_term', path, detail: term, message: `o texto cita "${term}", que não está no perfil` });
    }
    const words = foldedWords(text);
    const stems = words.map(stem);
    for (const { phrase, label } of jobTerms) {
      const hit = findPhrase(words, phrase).length > 0 || (phrase.length === 1 && phrase[0].length >= 4 && stems.includes(stem(phrase[0])));
      if (hit && !violations.some((v) => v.path === path && v.code === 'novel_term' && foldText(v.detail ?? '') === phrase.join(' '))) {
        violations.push({ code: 'novel_term', path, detail: label, message: `o texto cita "${label}", que vem da vaga e não está no perfil` });
      }
    }
    if (companyIsForeign) {
      // Nome de uma palavra só e escrito com maiúscula ("Meta", "Node"): só conta a ocorrência com maiúscula,
      // para "bati a meta" não virar citação da empresa.
      const cased = company.length === 1 && companyCased ? casedWords(text) : null;
      const hits = findPhrase(words, company);
      if (hits.some((i) => cased === null || cased[i])) {
        violations.push({
          code: 'foreign_company', path, detail: opts.jobCompany,
          message: `o texto cita "${opts.jobCompany}", que não é uma empresa do perfil`,
        });
      }
    }
  }

  if (textOk(draft.summary, 'summary')) checkText(draft.summary, profileNumbers, 'summary', 'no perfil');

  const experiences: TailoredResume['experiences'] = [];
  capped(draft.experiences, LIMITS.profileItems, 'experiences', 'experiências').forEach((item, i) => {
    const path = `experiences[${i}]`;
    if (!idOk(item.id, path)) return;
    const source = profile.experiences.find((e) => e.id === item.id);
    if (!source) {
      violations.push({ code: 'unknown_id', path, message: `experiência "${item.id}" não existe no perfil` });
      return;
    }
    if (seen.has(source.id)) {
      violations.push({ code: 'duplicate_id', path, message: `experiência "${item.id}" aparece mais de uma vez` });
      return;
    }
    seen.add(source.id);
    const achievements: { sourceId: string; text: string }[] = [];
    capped(item.achievements, LIMITS.achievements, `${path}.achievements`, 'realizações').forEach((a, j) => {
      const aPath = `${path}.achievements[${j}]`;
      if (!idOk(a.sourceId, aPath)) return;
      const original = source.achievements.find((s) => s.id === a.sourceId);
      if (!original) {
        violations.push({ code: 'unknown_id', path: aPath, message: `realização "${a.sourceId}" não pertence a esta experiência` });
        return;
      }
      if (seen.has(original.id)) {
        violations.push({ code: 'duplicate_id', path: aPath, message: `realização "${a.sourceId}" aparece mais de uma vez` });
        return;
      }
      seen.add(original.id);
      if (textOk(a.text, `${aPath}.text`)) {
        checkText(a.text, allowedNumbers([original.text]), `${aPath}.text`, 'na realização original');
        if (!related(a.text, original.text)) {
          violations.push({
            code: 'unrelated_text', path: `${aPath}.text`,
            message: a.text.trim() ? 'o texto não tem relação com a realização original' : 'a realização ficou sem texto',
          });
        }
      }
      achievements.push({ sourceId: original.id, text: a.text });
    });
    // Empresa, cargo, datas e local vêm do perfil, nunca do rascunho.
    const { achievements: _original, ...copied } = source;
    experiences.push({ ...copied, achievements });
  });

  const resume: TailoredResume = {
    lang,
    contact: profile.contact,
    summary: draft.summary,
    experiences,
    education: pick(profile.education, draft.educationIds, 'educationIds', 'formação'),
    skills: pick(profile.skills, draft.skillIds, 'skillIds', 'habilidade'),
    languages: pick(profile.languages, draft.languageIds, 'languageIds', 'idioma'),
    certifications: pick(profile.certifications, draft.certificationIds, 'certificationIds', 'certificação'),
    links: pick(profile.links, draft.linkIds, 'linkIds', 'link'),
  };
  return { resume, violations };
}

/** Para cada palavra de `foldedWords(text)`: a ocorrência original tem letra maiúscula? */
function casedWords(text: string): boolean[] {
  const out: boolean[] = [];
  const norm = normalizeText(text);
  // Mesmo corte de `foldedWords`, feito sobre o texto ainda com caixa (dobrar não muda as fronteiras ASCII).
  for (const m of norm.normalize('NFD').replace(/\p{M}/gu, '').matchAll(/[\p{L}\p{N}+#]+/gu)) {
    const folded = foldText(m[0]).match(/[a-z0-9+#]+/g) ?? [];
    for (let k = 0; k < folded.length; k++) out.push(/\p{Lu}/u.test(m[0]));
  }
  return out;
}

/** A realização reescrita compartilha ao menos uma palavra de conteúdo (ou um número) com a original? */
function related(text: string, original: string): boolean {
  if (!text.trim()) return false;
  const source = contentStems(original);
  if (source.size === 0) return true; // original sem palavra de conteúdo: nada a comparar
  for (const s of contentStems(text)) if (source.has(s)) return true;
  const numbers = new Set(numberIds(original));
  return numberIds(text).some((n) => numbers.has(n));
}

/** Identidade de número em forma legível para a mensagem ("d:2018-3" → "03/2018", "q:tens" → "dezenas"). */
function displayNumber(id: string): string {
  const date = /^d:(\d{4})-(\d+)$/.exec(id);
  if (date) return `${date[2].padStart(2, '0')}/${date[1]}`;
  return id.startsWith('q:') ? `quantidade vaga (${id.slice(2)})` : id;
}

/** Texto curto para `ai_tasks.error` e para a interface: o que divergiu. */
export function describeViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.path}: ${v.message}`).join('; ');
}

/** Violações de estrutura: bloqueiam também a edição manual. As demais viram aviso para o usuário. */
export const isStructural = (v: Violation) => v.code === 'unknown_id' || v.code === 'duplicate_id';

/** Os códigos presentes em uma lista de violações, sem repetição (para quem chama distinguir os casos). */
export const violationCodes = (violations: readonly Violation[]): ViolationCode[] => [...new Set(violations.map((v) => v.code))];

/**
 * LIMITE CONHECIDO do verificador (o que ainda pode passar em texto livre):
 * - uma palavra comum, em minúsculas, que afirme algo que o perfil não diz ("especialista", "fluente",
 *   "premiada"), e qualquer afirmação feita só com palavras que já existem no perfil combinadas de outro jeito
 *   (ex.: atribuir a uma experiência uma tecnologia que o perfil lista em outra);
 * - um nome próprio desconhecido escrito todo em minúsculas, ou como primeira palavra de uma frase, quando
 *   ele não está na lista interna de nomes conhecidos nem nas palavras da vaga passadas em `jobTitle`/`jobKeywords`;
 * - números e datas por extenso fora do que o leitor simples entende (ele lê cardinais de 2 a 999.999 em
 *   português e inglês e "dezenas/centenas/milhares/décadas"): ordinais, frações, "meia dúzia", "o dobro",
 *   meses por extenso, algarismos romanos, e o reaproveitamento de um número do perfil com outro sentido no
 *   resumo ("40%" do perfil citado como "40%" de outra coisa);
 * - nomes de uma letra só ("C", "R") e sósias de letras fora do conjunto cirílico/grego listado em text.ts.
 */

import { withProfileDefaults, type CandidateProfile, type ProfileWire, type Violation } from '@kv/shared';
import { AiError, type AiErrorExtra } from './errors';
import { buildTermIndex, foldedWords, hasControlChars, looseNumberId, novelTerms, numberIds } from './text';
import { describeViolations, profileTexts } from './verify';

/** A tradução do perfil foi recusada pela conferência de não invenção. `violations` diz onde e por quê. */
export class ProfileTranslationError extends AiError {
  override name = 'ProfileTranslationError';
  constructor(
    readonly violations: Violation[],
    extra: AiErrorExtra = {},
  ) {
    super('invalid_output', `a tradução mudou fatos do perfil: ${describeViolations(violations.slice(0, 5))}`.slice(0, 1_000), undefined, extra);
  }
}

/** Palavras de nível de cargo e de grau de formação, agrupadas por sentido (português e inglês). */
const RANK_GROUPS: string[][] = [
  ['senior', 'sr'], ['junior', 'jr'], ['pleno', 'mid', 'midlevel'], ['lead', 'lider', 'leader'], ['manager', 'gerente'],
  ['director', 'diretor', 'diretora'], ['head'], ['chief', 'chefe', 'cto', 'ceo', 'cfo', 'coo', 'cio'], ['vp', 'vice'],
  ['founder', 'cofounder', 'fundador', 'fundadora', 'cofundador', 'cofundadora'], ['principal'], ['staff'],
  ['coordinator', 'coordenador', 'coordenadora'], ['specialist', 'especialista', 'expert'], ['supervisor', 'supervisora'],
  ['intern', 'internship', 'estagiario', 'estagiaria', 'estagio', 'trainee'], ['architect', 'arquiteto', 'arquiteta'],
  ['bachelor', 'bachelors', 'bacharel', 'bacharelado', 'bsc', 'ba', 'graduacao', 'undergraduate'],
  ['master', 'masters', 'mestrado', 'mestre', 'msc'], ['phd', 'doutorado', 'doutor', 'doutora', 'doctorate', 'doctoral'],
  ['mba'], ['postgraduate', 'pos', 'posgraduacao', 'especializacao', 'specialization', 'graduate'],
  ['technologist', 'tecnologo', 'tecnologa', 'associate'], ['technician', 'technical', 'tecnico', 'tecnica'],
];
const RANK_OF = new Map<string, number>();
RANK_GROUPS.forEach((group, i) => group.forEach((word) => RANK_OF.set(word, i)));
const ranksIn = (text: string) => new Set(foldedWords(text).map((w) => RANK_OF.get(w)).filter((g) => g !== undefined));

const splitCurrency = (id: string) => /^(BRL|USD|EUR|GBP)?(.*)$/.exec(id)!.slice(1) as [string | undefined, string];

/**
 * Os números da tradução são os mesmos da origem? Compara o conjunto de identidades (text.ts), sem a
 * unidade colada e sem o mês ("24h" = "24 hours", "03/2021" = "March 2021"). A moeda pode sumir ou mudar de
 * símbolo para palavra, mas não pode virar OUTRA moeda. Devolve as identidades que sobram ou faltam.
 */
export function numberMismatch(source: string, translated: string): string[] {
  const parse = (text: string) => numberIds(text).map((id) => {
    const [currency, value] = splitCurrency(looseNumberId(id));
    return { id, currency: currency ?? '', value };
  });
  const src = parse(source);
  const out = parse(translated);
  const same = (a: (typeof src)[number], b: (typeof src)[number]) =>
    a.value === b.value && (a.currency === b.currency || !a.currency || !b.currency);
  return [
    ...out.filter((t) => !src.some((s) => same(s, t))).map((t) => t.id),
    ...src.filter((s) => !out.some((t) => same(s, t))).map((s) => `-${s.id}`),
  ];
}

type FieldKind = 'prose' | 'label' | 'rank';
const EMPTY_INDEX = buildTermIndex([]);

/**
 * Junta a tradução ao perfil de origem, campo a campo:
 * - nome, e-mail, telefone, empresa, instituição, emissor, datas e URLs são COPIADOS da origem (o que o
 *   modelo devolveu nesses campos é ignorado);
 * - nomes de habilidade e de certificação só aceitam a tradução quando ela não muda nada verificável
 *   (números, termos técnicos, siglas, quantidade de itens); senão, vale o texto de origem, sem erro;
 * - resumo, realizações, cargos, cursos, idiomas, níveis, locais e rótulos vêm do modelo, e cada um é
 *   conferido contra o campo de origem: mesmos números, nenhum termo técnico/sigla/nome conhecido que não
 *   exista no perfil de origem, nenhum nível de cargo ou grau de formação novo, tamanho proporcional, sem
 *   caractere de controle. Campo traduzido vazio volta para o texto de origem.
 */
export function mergeTranslation(stored: CandidateProfile, translated: ProfileWire): { merged: ProfileWire; violations: Violation[] } {
  const source = withProfileDefaults(stored);
  const violations: Violation[] = [];
  const index = buildTermIndex(profileTexts(source));
  const pick = <T extends { id: string }>(items: T[], id: string, where: string): T => {
    const found = items.find((item) => item.id === id);
    if (!found) throw new AiError('invalid_output', `a tradução não devolveu o item ${id.slice(0, 40)} (${where})`);
    return found;
  };

  function problems(src: string, out: string, kind: FieldKind): Omit<Violation, 'path'>[] {
    const found: Omit<Violation, 'path'>[] = [];
    if (hasControlChars(out)) found.push({ code: 'limit', message: 'a tradução contém caractere de controle' });
    const maxLength = kind === 'prose' ? src.length * 2.5 + 80 : src.length * 3 + 40;
    if (out.length > maxLength) {
      found.push({ code: 'limit', message: `a tradução tem ${out.length} caracteres para ${src.length} de origem` });
      return found; // texto desproporcional não passa pelas outras conferências
    }
    for (const n of numberMismatch(src, out)) {
      found.push(n.startsWith('-')
        ? { code: 'new_number', detail: n.slice(1), message: `o número "${n.slice(1)}" da origem sumiu ou mudou na tradução` }
        : { code: 'new_number', detail: n, message: `o número "${n}" não está no texto de origem` });
    }
    for (const term of novelTerms(out, index, { mode: 'shapes' })) {
      found.push({ code: 'novel_term', detail: term, message: `a tradução cita "${term}", que não está no perfil de origem` });
    }
    if (kind === 'rank') {
      const before = ranksIn(src);
      const added = foldedWords(out).filter((w) => RANK_OF.has(w) && !before.has(RANK_OF.get(w)!));
      for (const word of new Set(added)) {
        found.push({ code: 'novel_term', detail: word, message: `a tradução acrescenta "${word}", que não está no texto de origem` });
      }
    }
    return found;
  }

  /** Campo traduzível: vazio volta para a origem; divergência vira violação (e a tradução inteira falha). */
  function field(src: string, out: string, kind: FieldKind, path: string): string {
    if (!src.trim() || !out.trim()) return src;
    for (const p of problems(src, out, kind)) violations.push({ ...p, path });
    return out;
  }

  const items = (text: string) => text.split(/[,;|/]|\s(?:e|and|&)\s/).length;
  /** Nome (habilidade, certificação): a tradução só vale se nada verificável mudou; senão fica o original. */
  function name(src: string, out: string): string {
    if (!src.trim() || !out.trim() || out.trim() === src.trim()) return src;
    // Nome próprio: tem token técnico, sigla ou nome conhecido, ou todas as palavras têm inicial maiúscula
    // ("React", "React Native", "Scrum Master"). Esses nunca são traduzidos ("Go" não vira "Ir").
    const words = src.trim().split(/\s+/).filter((w) => w.length > 3);
    const isProperName =
      novelTerms(src, EMPTY_INDEX, { mode: 'shapes' }).length > 0 || words.every((w) => /^[\p{Lu}\p{N}]/u.test(w));
    if (isProperName || items(out) > items(src) || problems(src, out, 'label').length > 0) return src;
    return out;
  }

  const merged: ProfileWire = {
    contact: { ...source.contact, location: field(source.contact.location, translated.contact.location, 'label', 'contact.location') },
    headline: source.headline,
    summary: field(source.summary, translated.summary, 'prose', 'summary'),
    experiences: source.experiences.map((e, i) => {
      const t = pick(translated.experiences, e.id, 'experiences');
      return {
        ...e,
        section: e.section,
        note: e.note,
        title: field(e.title, t.title, 'rank', `experiences[${i}].title`),
        location: field(e.location, t.location, 'label', `experiences[${i}].location`),
        achievements: e.achievements.map((a, j) => ({
          id: a.id,
          text: field(a.text, pick(t.achievements, a.id, 'achievements').text, 'prose', `experiences[${i}].achievements[${j}].text`),
        })),
      };
    }),
    education: source.education.map((e, i) => ({
      ...e, degree: field(e.degree, pick(translated.education, e.id, 'education').degree, 'rank', `education[${i}].degree`),
    })),
    skills: source.skills.map((k) => ({ ...k, group: k.group, name: name(k.name, pick(translated.skills, k.id, 'skills').name) })),
    languages: source.languages.map((l, i) => {
      const t = pick(translated.languages, l.id, 'languages');
      return { ...l, name: field(l.name, t.name, 'label', `languages[${i}].name`), level: field(l.level, t.level, 'label', `languages[${i}].level`) };
    }),
    certifications: source.certifications.map((c) => ({ ...c, name: name(c.name, pick(translated.certifications, c.id, 'certifications').name) })),
    links: source.links.map((l, i) => ({ ...l, label: field(l.label, pick(translated.links, l.id, 'links').label, 'label', `links[${i}].label`) })),
  };
  return { merged, violations };
}

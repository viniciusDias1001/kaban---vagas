import { withProfileDefaults, type ResumeLang, type TailoredResume } from '@kv/shared';

/** O texto de cada linha do currículo, sem fonte nem posição: quem desenha é o renderer. */

export type SectionKey = 'summary' | 'skills' | 'experience' | 'additional' | 'education' | 'languages' | 'certifications';
/** A ordem do modelo. */
export const SECTION_ORDER: readonly SectionKey[] = ['summary', 'skills', 'experience', 'additional', 'education', 'languages', 'certifications'];

export const SECTION_TITLES: Record<ResumeLang, Record<SectionKey, string>> = {
  'pt-BR': {
    summary: 'Resumo profissional',
    skills: 'Competências técnicas',
    experience: 'Experiência profissional',
    additional: 'Experiências complementares',
    education: 'Formação acadêmica',
    languages: 'Idiomas',
    certifications: 'Certificações',
  },
  en: {
    summary: 'Professional summary',
    skills: 'Technical skills',
    experience: 'Professional experience',
    additional: 'Additional experience',
    education: 'Education',
    languages: 'Languages',
    certifications: 'Certifications',
  },
};

export type ContentSection =
  | { key: 'summary'; title: string; text: string }
  | { key: 'skills'; title: string; groups: { label: string; items: string }[] }
  | { key: 'experience' | 'additional'; title: string; items: { role: string; meta: string; achievements: string[] }[] }
  | { key: 'education' | 'certifications'; title: string; lines: string[] }
  | { key: 'languages'; title: string; line: string };

export interface ResumeContent {
  name: string;
  headline: string;
  contact: string[];
  footerName: string;
  sections: ContentSection[];
}

const MONTHS: Record<ResumeLang, readonly string[]> = {
  'pt-BR': ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const PRESENT: Record<ResumeLang, string> = { 'pt-BR': 'Atual', en: 'Present' };
const LOWERCASE_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

const joinParts = (parts: string[], separator: string): string =>
  parts.map((p) => p.trim()).filter(Boolean).join(separator);
/** Texto de uma linha só: quebras viram espaço, sem espaço nas pontas. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ').trim();

export function formatResumeDate(value: string, lang: ResumeLang): string {
  const text = value.trim();
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text);
  return match ? `${MONTHS[lang][Number(match[2]) - 1]} ${match[1]}` : text;
}

export function formatPeriod(start: string, end: string, lang: ResumeLang): string {
  const from = formatResumeDate(start, lang);
  const to = formatResumeDate(end, lang);
  if (!from && !to) return '';
  if (!from) return to;
  return `${from} - ${to || PRESENT[lang]}`;
}

export function footerName(name: string): string {
  const line = oneLine(name);
  if (!/\p{L}/u.test(line) || line !== line.toUpperCase()) return line;
  let index = 0;
  return line.replace(/[^ -]+/g, (word) => {
    const lower = word.toLowerCase();
    const first = index++ === 0;
    if (!first && LOWERCASE_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

export function bareUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export function resumeContent(resume: TailoredResume): ResumeContent {
  const r = withProfileDefaults(resume);
  const { lang } = r;
  const titles = SECTION_TITLES[lang];
  const title = (key: SectionKey) => titles[key].toUpperCase();

  const skillGroups = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const skill of r.skills) {
    const name = skill.name.trim();
    if (!name) continue;
    const label = skill.group.trim();
    if (!label) { ungrouped.push(name); continue; }
    skillGroups.set(label, [...(skillGroups.get(label) ?? []), name]);
  }
  const groups = [
    ...[...skillGroups].map(([label, names]) => ({ label: `${label}:`, items: names.join(', ') })),
    ...(ungrouped.length ? [{ label: '', items: ungrouped.join(', ') }] : []),
  ];

  const experienceItems = (section: 'principal' | 'complementar') =>
    r.experiences
      .filter((e) => (e.section === 'complementar') === (section === 'complementar'))
      .map((e) => ({
        role: joinParts([e.title, e.company], ' - '),
        meta: joinParts([joinParts([formatPeriod(e.start, e.end, lang), e.location], ' | '), e.note], ' · '),
        achievements: e.achievements.map((a) => a.text),
      }));
  const main = experienceItems('principal');
  const additional = experienceItems('complementar');

  const education = r.education.map((e) =>
    joinParts([joinParts([e.degree, e.institution], ' - '), formatPeriod(e.start, e.end, lang)], ' | '));
  const languages = joinParts(
    r.languages.filter((l) => l.name.trim()).map((l) => (l.level.trim() ? `${l.name.trim()}: ${l.level.trim()}` : l.name.trim())),
    ' | ',
  );
  const certifications = r.certifications.map((c) =>
    joinParts([joinParts([c.name, c.issuer], ' - '), formatResumeDate(c.date, lang)], ' | '));

  const candidates: (ContentSection | null)[] = [
    r.summary.trim() ? { key: 'summary', title: title('summary'), text: r.summary } : null,
    groups.length ? { key: 'skills', title: title('skills'), groups } : null,
    main.length ? { key: 'experience', title: title('experience'), items: main } : null,
    additional.length ? { key: 'additional', title: title('additional'), items: additional } : null,
    education.length ? { key: 'education', title: title('education'), lines: education } : null,
    languages ? { key: 'languages', title: title('languages'), line: languages } : null,
    certifications.length ? { key: 'certifications', title: title('certifications'), lines: certifications } : null,
  ];
  const sections = SECTION_ORDER.flatMap((key) => candidates.filter((s): s is ContentSection => s !== null && s.key === key));

  return {
    name: oneLine(r.contact.name).toUpperCase(),
    headline: oneLine(r.headline).toUpperCase(),
    contact: [r.contact.location, r.contact.phone, r.contact.email, ...r.links.map((l) => bareUrl(l.url))].map((p) => p.trim()).filter(Boolean),
    footerName: footerName(r.contact.name),
    sections,
  };
}

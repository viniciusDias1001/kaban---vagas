import { z } from 'zod';
import {
  EXPERIENCE_SECTIONS, RESUME_LANGS, itemIdPattern, randomItemId, type ExperienceSection, type ItemKind, type WithLayout,
} from './ai-constants';
import { LIMITS, hasNul } from './constants';

/** Schemas Zod da IA de perfil. O navegador não importa este arquivo (só os tipos, por `@kv/shared/client`). */

export const ResumeLangSchema = z.enum(RESUME_LANGS);

const NO_NUL = 'não pode conter o caractere NUL';
const short = z.string().max(LIMITS.profileShort).refine((s) => !hasNul(s), NO_NUL);
const long = z.string().max(LIMITS.profileLong).refine((s) => !hasNul(s), NO_NUL);
const id = (kind: ItemKind) => z.string().regex(itemIdPattern(kind));
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIMITS.profileItems);

const ContactSchema = z.object({ name: short, email: short, phone: short, location: short });
const AchievementSchema = z.object({ id: id('achievement'), text: long });
const ExperienceSchema = z.object({
  id: id('experience'),
  company: short,
  title: short,
  /** Texto livre curto, como no currículo ("2021-03", "mar/2021"). */
  start: short,
  /** Vazio = emprego atual. */
  end: short,
  location: short,
  achievements: z.array(AchievementSchema).max(LIMITS.achievements),
  /** Ausente em perfil gravado antes do modelo de currículo: vale `principal`. */
  section: z.enum(EXPERIENCE_SECTIONS).optional(),
  /** Linha curta sob o cargo no currículo ("Antes: Estagiária"). Ausente = vazio. */
  note: short.optional(),
});
const EducationSchema = z.object({ id: id('education'), institution: short, degree: short, start: short, end: short });
const SkillSchema = z.object({ id: id('skill'), name: short, /** Rótulo do grupo no currículo; ausente = vazio. */ group: short.optional() });
const LanguageSchema = z.object({ id: id('language'), name: short, level: short });
const CertificationSchema = z.object({ id: id('certification'), name: short, issuer: short, date: short });
const LinkSchema = z.object({
  id: id('link'),
  label: short,
  url: short.refine((u) => /^https?:\/\//i.test(u), 'a URL precisa ser http ou https'),
});

/** O perfil estruturado gravado no banco: a fonte da verdade de tudo que a IA escreve. */
export const CandidateProfileSchema = z.object({
  contact: ContactSchema,
  /** Título profissional sob o nome; ausente = vazio. */
  headline: short.optional(),
  summary: long,
  experiences: list(ExperienceSchema),
  education: list(EducationSchema),
  skills: list(SkillSchema),
  languages: list(LanguageSchema),
  certifications: list(CertificationSchema),
  links: list(LinkSchema),
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

// ---------------------------------------------------------------------------------------------
// Schemas "de fio": o que o modelo devolve. Regra para os três provedores aceitarem o mesmo schema
// em saída estruturada: só objetos com TODOS os campos obrigatórios, strings, inteiros, booleanos e
// listas. Nada de .optional(), .default(), .max(), .regex() ou .refine() aqui; limite e formato são
// conferidos em código depois (normalizeProfile, verificador).
// ---------------------------------------------------------------------------------------------

const s = z.string();
const strings = z.array(z.string());

/** Mesmo desenho do perfil, sem restrições. Na extração o modelo devolve `id: ""`; na tradução, repete os ids. */
export const ProfileWireSchema = z.object({
  contact: z.object({ name: s, email: s, phone: s, location: s }),
  headline: s,
  summary: s,
  experiences: z.array(
    z.object({
      id: s, company: s, title: s, start: s, end: s, location: s, section: s, note: s,
      achievements: z.array(z.object({ id: s, text: s })),
    }),
  ),
  education: z.array(z.object({ id: s, institution: s, degree: s, start: s, end: s })),
  skills: z.array(z.object({ id: s, name: s, group: s })),
  languages: z.array(z.object({ id: s, name: s, level: s })),
  certifications: z.array(z.object({ id: s, name: s, issuer: s, date: s })),
  links: z.array(z.object({ id: s, label: s, url: s })),
});
export type ProfileWire = z.infer<typeof ProfileWireSchema>;

export interface NormalizeOptions {
  /** true (saída de modelo): corta textos e listas nos limites. false (edição do usuário): não corta; a validação recusa. */
  clamp: boolean;
  newId?: (kind: ItemKind) => string;
}

/**
 * Transforma um perfil "de fio" em perfil gravável: mantém o id que já é válido e ainda não apareceu,
 * cria um novo para os demais (ids estáveis entre edições), completa `https://` em links sem esquema e
 * descarta links que nem assim viram URL http(s). Quem chama valida o resultado com CandidateProfileSchema.
 */
export function normalizeProfile(wire: ProfileWire, opts: NormalizeOptions): WithLayout<CandidateProfile> {
  const newId = opts.newId ?? randomItemId;
  const seen = new Set<string>();
  const keepId = (kind: ItemKind, candidate: string): string => {
    const ok = itemIdPattern(kind).test(candidate) && !seen.has(candidate);
    const value = ok ? candidate : newId(kind);
    seen.add(value);
    return value;
  };
  const cut = (text: string, max: number) => (opts.clamp ? text.replaceAll('\u0000', '').trim().slice(0, max) : text);
  const sh = (text: string) => cut(text, LIMITS.profileShort);
  const lg = (text: string) => cut(text, LIMITS.profileLong);
  const cap = <T>(items: T[], max: number = LIMITS.profileItems) => (opts.clamp ? items.slice(0, max) : items);
  const section = (raw: string): ExperienceSection => {
    const v = raw.trim().toLowerCase();
    return EXPERIENCE_SECTIONS.find((x) => x === v) ?? 'principal';
  };
  const url = (raw: string) => (/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  const isUrl = (u: string) => {
    try {
      return new URL(u).hostname.includes('.');
    } catch {
      return false;
    }
  };

  return {
    contact: {
      name: sh(wire.contact.name), email: sh(wire.contact.email), phone: sh(wire.contact.phone),
      location: sh(wire.contact.location),
    },
    headline: sh(wire.headline),
    summary: lg(wire.summary),
    experiences: cap(wire.experiences).map((e) => ({
      id: keepId('experience', e.id),
      company: sh(e.company), title: sh(e.title), start: sh(e.start), end: sh(e.end), location: sh(e.location),
      section: section(e.section), note: sh(e.note),
      achievements: cap(e.achievements, LIMITS.achievements).map((a) => ({ id: keepId('achievement', a.id), text: lg(a.text) })),
    })),
    education: cap(wire.education).map((e) => ({
      id: keepId('education', e.id), institution: sh(e.institution), degree: sh(e.degree), start: sh(e.start), end: sh(e.end),
    })),
    skills: cap(wire.skills).map((k) => ({ id: keepId('skill', k.id), name: sh(k.name), group: sh(k.group) })),
    languages: cap(wire.languages).map((l) => ({ id: keepId('language', l.id), name: sh(l.name), level: sh(l.level) })),
    certifications: cap(wire.certifications).map((c) => ({
      id: keepId('certification', c.id), name: sh(c.name), issuer: sh(c.issuer), date: sh(c.date),
    })),
    links: cap(wire.links)
      .map((l) => ({ id: l.id, label: sh(l.label), url: sh(url(l.url)) }))
      .filter((l) => !opts.clamp || isUrl(l.url))
      .map((l) => ({ ...l, id: keepId('link', l.id) })),
  };
}

// --- Camada 1: nota e título, em lote -----------------------------------------------------------

export const Tier1BatchSchema = z.object({
  results: z.array(
    z.object({
      jobId: z.number().int(),
      /** Código ISO 639-1 em minúsculas: "pt", "en", "es"... */
      language: s,
      /** Título em pt-BR (igual ao original quando a vaga já está em português). */
      titlePt: s,
      /** 0 a 100. */
      score: z.number().int(),
      reason: s,
    }),
  ),
});
export type Tier1Result = z.infer<typeof Tier1BatchSchema>['results'][number];

// --- Camada 2: análise e tradução ---------------------------------------------------------------

export const JobAnalysisSchema = z.object({
  strengths: strings,
  gaps: strings,
  keywordsPresent: strings,
  keywordsMissing: strings,
  interviewTopics: strings,
  likelyQuestions: strings,
});
export type JobAnalysis = z.infer<typeof JobAnalysisSchema>;

export const Tier2OutputSchema = z.object({
  language: s,
  /** Descrição inteira em pt-BR; string vazia quando a vaga já está em português ou não tem descrição. */
  descriptionPt: s,
  analysis: JobAnalysisSchema,
});
export type Tier2Output = z.infer<typeof Tier2OutputSchema>;

// --- Camada 3: currículo adaptado ---------------------------------------------------------------

/**
 * O que o modelo devolve na camada 3: só REFERÊNCIAS a itens do perfil e os dois textos livres
 * (resumo e realizações). Objetos estritos: um campo a mais (ex.: "company") invalida a saída.
 */
export const TailoredDraftSchema = z.strictObject({
  summary: s,
  experiences: z.array(
    z.strictObject({
      id: s,
      achievements: z.array(z.strictObject({ sourceId: s, text: s })),
    }),
  ),
  educationIds: strings,
  skillIds: strings,
  languageIds: strings,
  certificationIds: strings,
  linkIds: strings,
});
export type TailoredDraft = z.infer<typeof TailoredDraftSchema>;

/** Corpo do PUT de edição: o mesmo desenho do rascunho, com os limites de texto do perfil. */
export const TailoredEditSchema = z.strictObject({
  summary: long,
  experiences: z
    .array(
      z.strictObject({
        id: short,
        achievements: z.array(z.strictObject({ sourceId: short, text: long })).max(LIMITS.achievements),
      }),
    )
    .max(LIMITS.profileItems),
  educationIds: list(short),
  skillIds: list(short),
  languageIds: list(short),
  certificationIds: list(short),
  linkIds: list(short),
});

import { z } from 'zod';
import { COLUMNS, LEVELS, LIMITS, MAX_AGES, REGIONS, hasNul } from './constants';

export const ColumnSchema = z.enum(COLUMNS);
export const LevelSchema = z.enum(LEVELS);
export const RegionSchema = z.enum(REGIONS);
export const MaxAgeSchema = z.literal(MAX_AGES);

export const SearchFiltersSchema = z.object({
  stacks: z.array(z.string().min(1)),
  levels: z.array(LevelSchema),
  maxAgeDays: MaxAgeSchema,
  regions: z.array(RegionSchema),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

const NO_NUL = 'não pode conter o caractere NUL';

/** Campos do perfil que vêm de digitação livre, com limite de tamanho. */
const profileText = {
  name: z.string().min(1).max(LIMITS.profileName).refine((s) => !hasNul(s), NO_NUL),
  stacks: z
    .array(z.string().min(1).max(LIMITS.stackLength).refine((s) => !hasNul(s), NO_NUL))
    .max(LIMITS.stacks),
  sources: z
    .array(z.string().min(1).max(LIMITS.sourceIdLength).refine((s) => !hasNul(s), NO_NUL))
    .min(1)
    .max(LIMITS.sources),
};

export const ProfileInputSchema = SearchFiltersSchema.extend({
  ...profileText,
  active: z.boolean().default(true),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/** Para PATCH: todos os campos opcionais e sem default em `active`. */
export const ProfilePatchSchema = SearchFiltersSchema.extend({
  ...profileText,
  active: z.boolean(),
}).partial();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export const NormalizedJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  /** Só http(s): a URL vira link clicável no quadro, e `javascript:`/`data:` executariam código. */
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'a URL precisa ser http ou https'),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string(),
  country: z.enum(['BR', 'INT']),
  remote: z.boolean(),
  stacks: z.array(z.string()),
  description: z.string(),
  postedAt: z.number().nullable(),
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

export const JobPatchSchema = z.object({
  column: ColumnSchema.optional(),
  position: z.number().optional(),
  notes: z.string().max(LIMITS.notes).refine((s) => !hasNul(s), NO_NUL).optional(),
});
export type JobPatch = z.infer<typeof JobPatchSchema>;

export const RunRequestSchema = z.object({ profileId: z.number().int().positive() });

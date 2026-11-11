import { LIMITS, type Level, type MaxAge, type ProfileDto, type ProfileInput, type Region } from '@kv/shared/client';

/** O que o formulário de perfil guarda: os campos do perfil mais o texto ainda não confirmado das stacks. */
export interface ProfileForm {
  name: string;
  stacks: string[];
  /** Digitado no campo de stacks e ainda não transformado em tag; conta junto ao salvar. */
  stacksDraft: string;
  levels: Level[];
  regions: Region[];
  maxAgeDays: MaxAge;
  sources: string[];
}

export const EMPTY_FORM: ProfileForm = {
  name: '', stacks: [], stacksDraft: '', levels: [], regions: [], maxAgeDays: 7, sources: [],
};

/** Formulário preenchido com um perfil salvo (modo edição). */
export function formFromProfile(profile: ProfileDto): ProfileForm {
  return {
    name: profile.name,
    stacks: [...profile.stacks],
    stacksDraft: '',
    levels: [...profile.levels],
    regions: [...profile.regions],
    maxAgeDays: profile.maxAgeDays,
    sources: [...profile.sources],
  };
}

/** Tags confirmadas + o que ainda estiver digitado, em minúsculas, sem vazias nem repetidas, na ordem. */
export function collectStacks(form: Pick<ProfileForm, 'stacks' | 'stacksDraft'>): string[] {
  const all = [...form.stacks, ...form.stacksDraft.split(',')].map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}

/**
 * Fontes marcadas no formulário que não existem mais em `/sources` (conector removido, ou `fake` fora do
 * modo de teste). `known` null = a lista de fontes ainda não carregou: nada é considerado indisponível.
 */
export function unavailableSources(form: Pick<ProfileForm, 'sources'>, known: readonly string[] | null): string[] {
  return known ? form.sources.filter((s) => !known.includes(s)) : [];
}

const availableSources = (form: Pick<ProfileForm, 'sources'>, known: readonly string[] | null) =>
  known ? form.sources.filter((s) => known.includes(s)) : form.sources;

export interface FormErrors {
  name?: string;
  stacks?: string;
  sources?: string;
}

/** Os mesmos limites que a API valida (`LIMITS`), para avisar antes de enviar. */
export function validateForm(form: ProfileForm, known: readonly string[] | null = null): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (name.length > LIMITS.profileName) errors.name = `O nome pode ter até ${LIMITS.profileName} caracteres (tem ${name.length}).`;

  const stacks = collectStacks(form);
  const tooLong = stacks.find((s) => s.length > LIMITS.stackLength);
  if (stacks.length > LIMITS.stacks) {
    errors.stacks = `No máximo ${LIMITS.stacks} stacks (há ${stacks.length}). Remova ${stacks.length - LIMITS.stacks}.`;
  } else if (tooLong) {
    errors.stacks = `Cada stack pode ter até ${LIMITS.stackLength} caracteres: "${tooLong.slice(0, 16)}…" tem ${tooLong.length}.`;
  }

  if (form.sources.length > 0 && availableSources(form, known).length === 0) {
    errors.sources = 'As fontes deste perfil não estão mais disponíveis. Marque ao menos uma das fontes abaixo.';
  } else if (form.sources.length > LIMITS.sources) {
    errors.sources = `No máximo ${LIMITS.sources} fontes.`;
  }
  return errors;
}

export const hasErrors = (errors: FormErrors) => Object.keys(errors).length > 0;

/** Pronto para enviar: tem nome, ao menos uma fonte disponível e nenhum limite estourado. */
export function canSubmit(form: ProfileForm, known: readonly string[] | null = null): boolean {
  return form.name.trim() !== '' && availableSources(form, known).length > 0 && !hasErrors(validateForm(form, known));
}

/** Corpo do `POST /profiles` (perfil novo, sempre ativo). */
export function toInput(form: ProfileForm, known: readonly string[] | null = null): ProfileInput {
  return {
    name: form.name.trim(),
    stacks: collectStacks(form),
    levels: form.levels,
    regions: form.regions,
    maxAgeDays: form.maxAgeDays,
    sources: availableSources(form, known),
    active: true,
  };
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Corpo do `PATCH /profiles/:id`: só os campos que mudaram em relação ao perfil salvo. `active` nunca
 * entra (editar não liga nem desliga o perfil). Fontes indisponíveis saem da lista ao salvar. A ordem das
 * stacks conta (as três primeiras viram termos de busca); a de níveis, regiões e fontes, não.
 */
export function toPatch(original: ProfileDto, form: ProfileForm, known: readonly string[] | null = null): Partial<ProfileInput> {
  const next = toInput(form, known);
  const patch: Partial<ProfileInput> = {};
  if (next.name !== original.name) patch.name = next.name;
  if (!sameList(next.stacks, original.stacks)) patch.stacks = next.stacks;
  if (!sameSet(next.levels, original.levels)) patch.levels = next.levels;
  if (!sameSet(next.regions, original.regions)) patch.regions = next.regions;
  if (next.maxAgeDays !== original.maxAgeDays) patch.maxAgeDays = next.maxAgeDays;
  if (!sameSet(next.sources, original.sources)) patch.sources = next.sources;
  return patch;
}

/**
 * O usuário mexeu em algo que se perderia ao descartar o formulário? Em edição compara com o perfil salvo
 * (sem contar a limpeza automática de fontes indisponíveis); em criação, com o formulário vazio.
 */
export function isDirty(original: ProfileDto | null, form: ProfileForm): boolean {
  if (original) return Object.keys(toPatch(original, form, null)).length > 0 || form.name !== original.name;
  return (
    form.name.trim() !== '' || collectStacks(form).length > 0 || form.levels.length > 0 || form.regions.length > 0 ||
    form.sources.length > 0 || form.maxAgeDays !== EMPTY_FORM.maxAgeDays
  );
}

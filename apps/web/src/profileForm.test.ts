import { describe, expect, it } from 'vitest';
import { LIMITS, ProfileInputSchema, ProfilePatchSchema, type ProfileDto } from '@kv/shared';
import {
  EMPTY_FORM, canSubmit, collectStacks, formFromProfile, isDirty, toInput, toPatch, unavailableSources, validateForm,
} from './profileForm';

const saved: ProfileDto = {
  id: 3, name: 'React Pleno', stacks: ['react', 'node'], levels: ['pleno'], maxAgeDays: 7, regions: ['remoto', 'brasil'],
  sources: ['gupy', 'remotive'], active: false, createdAt: 1,
};
const KNOWN = ['gupy', 'remotive', 'linkedin'];

describe('formFromProfile', () => {
  it('fills every field from the saved profile, without sharing arrays', () => {
    const form = formFromProfile(saved);
    expect(form).toEqual({
      name: 'React Pleno', stacks: ['react', 'node'], stacksDraft: '', levels: ['pleno'], regions: ['remoto', 'brasil'],
      maxAgeDays: 7, sources: ['gupy', 'remotive'],
    });
    expect(form.stacks).not.toBe(saved.stacks);
    expect(form.sources).not.toBe(saved.sources);
  });
});

describe('collectStacks', () => {
  it('joins tags and the pending draft, lower-cased, without blanks or repeats', () => {
    expect(collectStacks({ stacks: ['react'], stacksDraft: ' Node , ,REACT, aws' })).toEqual(['react', 'node', 'aws']);
  });
});

describe('toInput', () => {
  it('builds a body the API schema accepts', () => {
    const input = toInput({ ...EMPTY_FORM, name: '  E2E ', stacksDraft: 'react', sources: ['gupy'] });
    expect(input).toEqual({ name: 'E2E', stacks: ['react'], levels: [], regions: [], maxAgeDays: 7, sources: ['gupy'], active: true });
    expect(ProfileInputSchema.safeParse(input).success).toBe(true);
  });
});

describe('toPatch', () => {
  it('is empty when nothing changed, whatever the order of levels, regions and sources', () => {
    const form = { ...formFromProfile(saved), regions: ['brasil', 'remoto'] as const, sources: ['remotive', 'gupy'] };
    expect(toPatch(saved, { ...form, regions: [...form.regions] }, KNOWN)).toEqual({});
  });
  it('carries only the changed fields and never `active`', () => {
    const form = { ...formFromProfile(saved), name: 'React Sênior', maxAgeDays: 30 as const };
    const patch = toPatch(saved, form, KNOWN);
    expect(patch).toEqual({ name: 'React Sênior', maxAgeDays: 30 });
    expect(patch).not.toHaveProperty('active');
    expect(ProfilePatchSchema.safeParse(patch).success).toBe(true);
  });
  it('treats a different stack order as a change (the first three are the search terms)', () => {
    expect(toPatch(saved, { ...formFromProfile(saved), stacks: ['node', 'react'] }, KNOWN)).toEqual({ stacks: ['node', 'react'] });
  });
  it('includes the stack still being typed', () => {
    expect(toPatch(saved, { ...formFromProfile(saved), stacksDraft: 'AWS' }, KNOWN)).toEqual({ stacks: ['react', 'node', 'aws'] });
  });
  it('can clear lists (empty = qualquer)', () => {
    expect(toPatch(saved, { ...formFromProfile(saved), stacks: [], levels: [], regions: [] }, KNOWN)).toEqual({
      stacks: [], levels: [], regions: [],
    });
  });
  it('drops sources that no longer exist when saving', () => {
    const old = { ...saved, sources: ['gupy', 'fake'] };
    const form = { ...formFromProfile(old), name: 'Novo nome' };
    expect(unavailableSources(form, KNOWN)).toEqual(['fake']);
    expect(toPatch(old, form, KNOWN)).toEqual({ name: 'Novo nome', sources: ['gupy'] });
  });
  it('does not drop anything while the list of sources has not loaded', () => {
    const old = { ...saved, sources: ['gupy', 'fake'] };
    expect(unavailableSources(formFromProfile(old), null)).toEqual([]);
    expect(toPatch(old, formFromProfile(old), null)).toEqual({});
  });
});

describe('isDirty', () => {
  it('is false for an untouched create form and true once something is typed or marked', () => {
    expect(isDirty(null, EMPTY_FORM)).toBe(false);
    expect(isDirty(null, { ...EMPTY_FORM, name: '  ' })).toBe(false);
    expect(isDirty(null, { ...EMPTY_FORM, name: 'x' })).toBe(true);
    expect(isDirty(null, { ...EMPTY_FORM, stacksDraft: 'react' })).toBe(true);
    expect(isDirty(null, { ...EMPTY_FORM, sources: ['gupy'] })).toBe(true);
    expect(isDirty(null, { ...EMPTY_FORM, maxAgeDays: 30 })).toBe(true);
  });
  it('compares an edit with the saved profile', () => {
    expect(isDirty(saved, formFromProfile(saved))).toBe(false);
    expect(isDirty(saved, { ...formFromProfile(saved), name: 'React Pleno ' })).toBe(true);
    expect(isDirty(saved, { ...formFromProfile(saved), levels: [] })).toBe(true);
  });
  it('does not count the automatic clean-up of unavailable sources as a user change', () => {
    const old = { ...saved, sources: ['gupy', 'fake'] };
    expect(isDirty(old, formFromProfile(old))).toBe(false);
  });
});

describe('validateForm / canSubmit', () => {
  const ok = { ...EMPTY_FORM, name: 'Perfil', sources: ['gupy'] };
  it('accepts values at the limits', () => {
    const form = {
      ...ok, name: 'n'.repeat(LIMITS.profileName),
      stacks: Array.from({ length: LIMITS.stacks }, (_, i) => `s${i}`.padEnd(LIMITS.stackLength, 'x')),
    };
    expect(validateForm(form, KNOWN)).toEqual({});
    expect(canSubmit(form, KNOWN)).toBe(true);
    expect(ProfileInputSchema.safeParse(toInput(form, KNOWN)).success).toBe(true);
  });
  it('reports a name, a stack or a stack count above the limits, as the API would', () => {
    const longName = { ...ok, name: 'n'.repeat(LIMITS.profileName + 1) };
    expect(validateForm(longName).name).toContain(String(LIMITS.profileName));
    expect(ProfileInputSchema.safeParse(toInput(longName)).success).toBe(false);

    const longStack = { ...ok, stacksDraft: 'x'.repeat(LIMITS.stackLength + 1) };
    expect(validateForm(longStack).stacks).toContain(`até ${LIMITS.stackLength} caracteres`);
    expect(canSubmit(longStack)).toBe(false);

    const many = { ...ok, stacks: Array.from({ length: LIMITS.stacks }, (_, i) => `s${i}`), stacksDraft: 'mais-uma' };
    expect(validateForm(many).stacks).toContain(`No máximo ${LIMITS.stacks} stacks`);
    expect(canSubmit(many)).toBe(false);
  });
  it('needs a name and at least one available source', () => {
    expect(canSubmit({ ...ok, name: '   ' })).toBe(false);
    expect(canSubmit({ ...ok, sources: [] })).toBe(false);
    expect(canSubmit(ok, KNOWN)).toBe(true);
    const onlyGone = { ...ok, sources: ['fake'] };
    expect(canSubmit(onlyGone, KNOWN)).toBe(false);
    expect(validateForm(onlyGone, KNOWN).sources).toBeDefined();
    expect(canSubmit(onlyGone, null)).toBe(true);
  });
});

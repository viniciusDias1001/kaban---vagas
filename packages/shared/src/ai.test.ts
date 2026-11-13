import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CandidateProfileSchema, ProfileWireSchema, TailoredDraftSchema, Tier1BatchSchema, Tier2OutputSchema, draftOf,
  itemIdPattern, normalizeProfile, randomItemId, withProfileDefaults, type CandidateProfile, type ItemKind, type ProfileWire, type TailoredResume,
} from './index';
import { LIMITS } from './constants';

/** Gerador determinístico: exp_00000001, ach_00000002, ... */
export function counterIds() {
  let n = 0;
  const prefix = { experience: 'exp', achievement: 'ach', education: 'edu', skill: 'skill', language: 'lang', certification: 'cert', link: 'link' };
  return (kind: ItemKind) => `${prefix[kind]}_${String(++n).padStart(8, '0')}`;
}

const wire: ProfileWire = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' },
  summary: 'Desenvolvedora front-end (pessoa fictícia).',
  experiences: [
    {
      id: '', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end', start: '2021-03', end: '2024-06',
      location: 'Remoto',
      achievements: [{ id: '', text: 'Reduzi o tempo de build em 40%' }, { id: '', text: 'Liderei 3 pessoas' }],
    },
  ],
  education: [{ id: '', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' }],
  skills: [{ id: '', name: 'React' }, { id: '', name: 'TypeScript' }],
  languages: [{ id: '', name: 'Inglês', level: 'avançado' }],
  certifications: [],
  links: [{ id: '', label: 'Portfólio', url: 'exemplo.test/maria' }, { id: '', label: 'lixo', url: 'não é url' }],
};

describe('randomItemId', () => {
  it('matches the pattern of its kind and does not repeat', () => {
    const ids = Array.from({ length: 50 }, () => randomItemId('experience'));
    expect(ids.every((i) => itemIdPattern('experience').test(i))).toBe(true);
    expect(new Set(ids).size).toBe(50);
    expect(itemIdPattern('skill').test(ids[0])).toBe(false);
  });
});

describe('normalizeProfile', () => {
  it('assigns an id to every item, fixes links without scheme and drops links that are not urls', () => {
    const profile = normalizeProfile(wire, { clamp: true, newId: counterIds() });
    expect(CandidateProfileSchema.safeParse(profile).success).toBe(true);
    expect(profile.experiences[0].id).toBe('exp_00000001');
    expect(profile.experiences[0].achievements.map((a) => a.id)).toEqual(['ach_00000002', 'ach_00000003']);
    expect(profile.links).toEqual([{ id: expect.stringMatching(/^link_/), label: 'Portfólio', url: 'https://exemplo.test/maria' }]);
  });

  it('keeps valid ids (stable across edits) and replaces duplicated or malformed ones', () => {
    const first = normalizeProfile(wire, { clamp: true, newId: counterIds() });
    const edited: ProfileWire = {
      ...first,
      skills: [...first.skills, { id: first.skills[0].id, name: 'Duplicada' }, { id: 'skill_x', name: 'Nova' }],
    };
    const second = normalizeProfile(edited, { clamp: false });
    expect(second.experiences[0].id).toBe(first.experiences[0].id);
    expect(second.skills[0].id).toBe(first.skills[0].id);
    expect(second.skills[2].id).not.toBe(first.skills[0].id);
    expect(new Set(second.skills.map((k) => k.id)).size).toBe(4);
    expect(second.skills.every((k) => itemIdPattern('skill').test(k.id))).toBe(true);
  });

  it('clamps model output to the limits, and leaves user input alone so validation can refuse it', () => {
    const huge: ProfileWire = { ...wire, summary: 'x'.repeat(LIMITS.profileLong + 10) };
    expect(normalizeProfile(huge, { clamp: true }).summary).toHaveLength(LIMITS.profileLong);
    const untouched = normalizeProfile(huge, { clamp: false });
    expect(CandidateProfileSchema.safeParse(untouched).success).toBe(false);
  });
});

describe('wire schemas are accepted by the three providers', () => {
  /** Todo objeto precisa listar todas as propriedades em `required` e fechar `additionalProperties`. */
  function problems(node: unknown, path = '$'): string[] {
    if (Array.isArray(node)) return node.flatMap((n, i) => problems(n, `${path}[${i}]`));
    if (typeof node !== 'object' || node === null) return [];
    const obj = node as Record<string, unknown>;
    const out: string[] = [];
    if (obj.type === 'object') {
      const props = Object.keys((obj.properties as object | undefined) ?? {});
      const required = (obj.required as string[] | undefined) ?? [];
      if (props.some((p) => !required.includes(p))) out.push(`${path}: campo opcional`);
      if (obj.additionalProperties !== false) out.push(`${path}: additionalProperties`);
    }
    for (const key of ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'default']) {
      // `minimum`/`maximum` de inteiro seguro são gerados pelo próprio Zod para z.number().int(); os SDKs os removem.
      if (key in obj && !(obj.type === 'integer' && (key === 'minimum' || key === 'maximum'))) out.push(`${path}: ${key}`);
    }
    return [...out, ...Object.entries(obj).flatMap(([k, v]) => problems(v, `${path}.${k}`))];
  }

  it.each([
    ['ProfileWireSchema', ProfileWireSchema],
    ['Tier1BatchSchema', Tier1BatchSchema],
    ['Tier2OutputSchema', Tier2OutputSchema],
    ['TailoredDraftSchema', TailoredDraftSchema],
  ])('%s has only required fields, closed objects and no constraints', (_name, schema) => {
    expect(problems(z.toJSONSchema(schema))).toEqual([]);
  });
});

describe('TailoredDraftSchema', () => {
  const draft = {
    summary: 's', experiences: [{ id: 'exp_00000001', achievements: [{ sourceId: 'ach_00000002', text: 't' }] }],
    educationIds: [], skillIds: [], languageIds: [], certificationIds: [], linkIds: [],
  };
  it('rejects any extra field, at any level', () => {
    expect(TailoredDraftSchema.safeParse(draft).success).toBe(true);
    expect(TailoredDraftSchema.safeParse({ ...draft, company: 'Inventada' }).success).toBe(false);
    const withCompany = { ...draft, experiences: [{ ...draft.experiences[0], company: 'Inventada' }] };
    expect(TailoredDraftSchema.safeParse(withCompany).success).toBe(false);
  });

  it('draftOf turns a resolved resume back into references and free text', () => {
    const profile = normalizeProfile(wire, { clamp: true, newId: counterIds() });
    const resume: TailoredResume = {
      lang: 'pt-BR', contact: profile.contact, summary: 'Resumo', education: profile.education, skills: profile.skills,
      languages: profile.languages, certifications: [], links: profile.links,
      experiences: profile.experiences.map((e) => ({
        ...e, achievements: e.achievements.map((a) => ({ sourceId: a.id, text: a.text })),
      })),
    };
    const back = draftOf(resume);
    expect(TailoredDraftSchema.safeParse(back).success).toBe(true);
    expect(back.experiences[0].achievements[0]).toEqual({ sourceId: 'ach_00000002', text: 'Reduzi o tempo de build em 40%' });
    expect(back.skillIds).toEqual(profile.skills.map((k) => k.id));
  });
});

describe('layout fields on the stored profile', () => {
  /** Como um perfil gravado antes desta mudança. */
  const legacy: CandidateProfile = {
    contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' }, summary: 'Pessoa fictícia.',
    experiences: [{ id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora', start: '2021-03', end: '', location: '', achievements: [] }],
    education: [], skills: [{ id: 'skill_aaaaaaa1', name: 'React' }], languages: [], certifications: [], links: [],
  };
  it('keeps a profile stored before the change valid and stores the four fields', () => {
    expect(CandidateProfileSchema.safeParse(legacy).success).toBe(true);
    const full = { ...legacy, headline: 'Desenvolvedora Front-end', skills: [{ ...legacy.skills[0], group: 'Front-end' }],
      experiences: [{ ...legacy.experiences[0], section: 'complementar', note: 'Antes: Estagiária' }] };
    expect(CandidateProfileSchema.parse(full)).toEqual(full); // nada é descartado
    expect(CandidateProfileSchema.safeParse({ ...full, experiences: [{ ...full.experiences[0], section: 'outra' }] }).success).toBe(false);
  });
  it('withProfileDefaults fills what is missing, keeps what is there and leaves its input alone', () => {
    const before = structuredClone(legacy);
    const filled = withProfileDefaults(legacy);
    expect(filled).toMatchObject({ headline: '', skills: [{ group: '' }], experiences: [{ section: 'principal', note: '' }] });
    expect(legacy).toEqual(before);
    expect(withProfileDefaults({ ...filled, headline: 'Tech Lead' })).toEqual({ ...filled, headline: 'Tech Lead' });
    const oldResume: TailoredResume = { ...legacy, lang: 'pt-BR', experiences: [] }; // currículo adaptado gravado antes da mudança
    expect(withProfileDefaults(oldResume)).toMatchObject({ lang: 'pt-BR', headline: '', skills: [{ group: '' }] });
  });
});

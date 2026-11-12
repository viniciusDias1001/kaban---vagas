import { describe, expect, it } from 'vitest';
import { CandidateProfileSchema, Tier1BatchSchema, type ProfileWire } from '@kv/shared';
import { createFakeProvider } from './fake';
import { readBlock } from './prompts';
import { createProvider } from './provider';
import {
  TIER1_EXCERPT_CHARS, TIER2_DESCRIPTION_CHARS, analyzeJob, extractProfile, scoreJobs, tailoredLangFor, testConnection, translateProfile,
} from './tasks';
import { SAMPLE_JOB, SAMPLE_PROFILE, SAMPLE_RESUME_TEXT } from './testing';
import type { AiProvider, AiRequest } from './types';

const fake = createFakeProvider();

/** Provedor que guarda a requisição e devolve o que o teste mandar (validado pelo schema da requisição). */
function scripted(reply: (req: AiRequest<unknown>) => unknown) {
  const requests: AiRequest<unknown>[] = [];
  const provider: AiProvider = {
    id: 'fake',
    async generate(req) {
      requests.push(req as AiRequest<unknown>);
      return { data: req.schema.parse(reply(req as AiRequest<unknown>)), usage: { inputTokens: 100, outputTokens: 20 }, model: 'scripted' };
    },
  };
  return { provider, requests };
}

describe('createProvider', () => {
  it('builds the provider named in the configuration', () => {
    const base = { apiKey: 'k', models: { fast: 'a', strong: 'b' }, dailyBudgetUsd: 1, budgetTimeZone: 'UTC' };
    for (const provider of ['anthropic', 'openai', 'gemini', 'fake'] as const) {
      expect(createProvider({ ...base, provider }).id).toBe(provider);
    }
  });
});

describe('testConnection', () => {
  it('makes one tiny call on the fast tier with a fixed prompt', async () => {
    const { provider, requests } = scripted(() => ({ ok: true }));
    expect((await testConnection(provider)).data).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tier: 'fast', maxOutputTokens: 16 });
    expect(requests[0].prompt).toMatch(/^Teste de conexão/);
    expect(await testConnection(fake)).toMatchObject({ data: { ok: true }, model: 'fake-fast' });
  });
});

describe('extractProfile', () => {
  it('returns a valid profile with stable ids, using the strong tier', async () => {
    const { data, usage, model } = await extractProfile(fake, SAMPLE_RESUME_TEXT);
    expect(CandidateProfileSchema.safeParse(data).success).toBe(true);
    expect(data.experiences[0].id).toMatch(/^exp_[a-z0-9]{8}$/);
    expect(model).toBe('fake-strong');
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('rejects an empty profile', async () => {
    await expect(extractProfile(fake, '')).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('translateProfile', () => {
  it('keeps ids and copies names, companies, dates and urls from the source', async () => {
    const { data } = await translateProfile(fake, SAMPLE_PROFILE, 'en');
    expect(data.summary).toBe(`[en] ${SAMPLE_PROFILE.summary}`);
    expect(data.experiences[0]).toMatchObject({
      id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', start: '2021-03', title: '[en] Desenvolvedora Front-end',
    });
    expect(data.experiences[0].achievements.map((a) => a.id)).toEqual(['ach_aaaaaaa1', 'ach_aaaaaaa2']);
    expect(data.contact).toEqual(SAMPLE_PROFILE.contact);
    expect(data.links).toEqual(SAMPLE_PROFILE.links);
  });

  it('ignores a company or date changed by the model and fails when an item is missing', async () => {
    const tampered = scripted((req) => {
      const { profile } = readBlock<{ profile: ProfileWire }>(req.prompt, 'dados')!;
      return { ...profile, experiences: profile.experiences.map((e) => ({ ...e, company: 'Google', start: '2010' })) };
    });
    const { data } = await translateProfile(tampered.provider, SAMPLE_PROFILE, 'en');
    expect(data.experiences[0]).toMatchObject({ company: 'Empresa Fictícia Ltda', start: '2021-03' });

    const dropped = scripted((req) => ({ ...readBlock<{ profile: ProfileWire }>(req.prompt, 'dados')!.profile, skills: [] }));
    await expect(translateProfile(dropped.provider, SAMPLE_PROFILE, 'en')).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('scoreJobs (tier 1)', () => {
  const jobs = [
    { ...SAMPLE_JOB, id: 1, description: 'x'.repeat(5_000) },
    { id: 2, title: 'Vaga sem descrição', company: 'LinkedIn Co', location: 'SP', description: '' },
  ];

  it('sends only title, company, location and an excerpt, plus the condensed profile, on the fast tier', async () => {
    const { provider, requests } = scripted(() => ({ results: [] }));
    await scoreJobs(provider, SAMPLE_PROFILE, jobs);
    const req = requests[0];
    expect(req.tier).toBe('fast');
    expect(req.schema).toBe(Tier1BatchSchema);
    const data = readBlock<{ jobs: Record<string, unknown>[] }>(req.prompt, 'dados')!;
    expect(data.jobs.map((j) => Object.keys(j))).toEqual([
      ['jobId', 'title', 'company', 'location', 'excerpt'], ['jobId', 'title', 'company', 'location', 'excerpt'],
    ]);
    expect((data.jobs[0].excerpt as string).length).toBe(TIER1_EXCERPT_CHARS);
    expect(data.jobs[1].excerpt).toBe('');
    const profile = readBlock<Record<string, unknown>>(req.system, 'perfil')!;
    expect(profile.skills).toEqual(['React', 'TypeScript', 'Node']);
    expect(JSON.stringify(profile)).not.toContain('Reduzi o tempo de build');
    expect(req.system).not.toContain('maria@exemplo.test');
  });

  it('scores a job with an empty description from its title', async () => {
    const { data } = await scoreJobs(fake, SAMPLE_PROFILE, jobs);
    expect(data.map((r) => r.jobId)).toEqual([1, 2]);
    expect(data[1]).toMatchObject({ jobId: 2, score: 40, language: 'pt', titlePt: 'Vaga sem descrição' });
  });

  it('drops results for unknown jobs, repeated jobs and scores out of range', async () => {
    const result = (jobId: number, score: number) => ({ jobId, language: 'EN', titlePt: '', score, reason: 'r' });
    const { provider } = scripted(() => ({ results: [result(1, 70), result(1, 10), result(99, 50), result(2, 101)] }));
    const { data } = await scoreJobs(provider, SAMPLE_PROFILE, jobs);
    expect(data).toEqual([{ jobId: 1, language: 'en', titlePt: SAMPLE_JOB.title, score: 70, reason: 'r' }]);
  });
});

describe('analyzeJob (tier 2)', () => {
  it('sends the full profile and the description capped, on the strong tier', async () => {
    const { provider, requests } = scripted(() => ({
      language: 'en', descriptionPt: 'tradução',
      analysis: { strengths: Array(30).fill('s'), gaps: [' '], keywordsPresent: [], keywordsMissing: [], interviewTopics: [], likelyQuestions: [] },
    }));
    const { data } = await analyzeJob(provider, SAMPLE_PROFILE, { ...SAMPLE_JOB, description: 'y'.repeat(TIER2_DESCRIPTION_CHARS + 500) });
    expect(requests[0].tier).toBe('strong');
    expect(readBlock<{ job: { description: string } }>(requests[0].prompt, 'dados')!.job.description).toHaveLength(TIER2_DESCRIPTION_CHARS);
    expect(readBlock<{ experiences: unknown[] }>(requests[0].system, 'perfil')!.experiences).toHaveLength(1);
    expect(data.analysis.strengths).toHaveLength(12);
    expect(data.analysis.gaps).toEqual([]);
  });

  it('translates an english job and leaves a portuguese one alone', async () => {
    expect((await analyzeJob(fake, SAMPLE_PROFILE, SAMPLE_JOB)).data).toMatchObject({ language: 'en', descriptionPt: expect.stringMatching(/^\[pt\] /) });
    const pt = await analyzeJob(fake, SAMPLE_PROFILE, { ...SAMPLE_JOB, title: 'Vaga para pessoa desenvolvedora', description: 'Vaga com React.' });
    expect(pt.data).toMatchObject({ language: 'pt', descriptionPt: '' });
    expect(pt.data.analysis.keywordsPresent).toEqual(['React']);
  });
});

describe('tailoredLangFor', () => {
  it('uses pt-BR for portuguese jobs and english for everything else', () => {
    expect(['pt', 'pt-BR', 'PT', 'en', 'es', 'de', '', null, undefined].map((language) => tailoredLangFor(language))).toEqual([
      'pt-BR', 'pt-BR', 'pt-BR', 'en', 'en', 'en', 'en', 'en', 'en',
    ]);
    // Sem idioma detectado, vale o país da vaga.
    expect([tailoredLangFor(null, 'BR'), tailoredLangFor('', 'INT'), tailoredLangFor('en', 'BR')]).toEqual(['pt-BR', 'en', 'en']);
  });
});

import { describe, expect, it } from 'vitest';
import type { CandidateProfile, ProfileWire } from '@kv/shared';
import { AiError } from './errors';
import { readBlock } from './prompts';
import {
  InputTooLargeError, JOB_FIELD_CHARS, PROFILE_JSON_MAX_CHARS, PROFILE_OUTPUT_TOKENS, RESUME_TEXT_MAX_CHARS, TIER1_EXCERPT_CHARS,
  TIER2_DESCRIPTION_CHARS, TIER2_OUTPUT_TOKENS, TIER3_DESCRIPTION_CHARS, analyzeJob, draftTailored, estimateInterruptedUsage, extractProfile,
  scoreJobs, testConnection, translateProfile,
} from './tasks';
import { CALL_TIMEOUT_MS, estimateAbortedUsage, outputAllowance } from './limits';
import { REALISTIC_PROFILE, SAMPLE_JOB, SAMPLE_PROFILE, SAMPLE_RESUME_TEXT } from './testing';
import { ProfileTranslationError, numberMismatch } from './translation';
import type { AiProvider, AiRequest } from './types';

const USAGE = { inputTokens: 100, outputTokens: 20 };

/** Provedor que guarda a requisição e devolve o que o teste mandar (validado pelo schema da requisição). */
function scripted(reply: (req: AiRequest<unknown>) => unknown) {
  const requests: AiRequest<unknown>[] = [];
  const provider: AiProvider = {
    id: 'fake',
    async generate(req) {
      requests.push(req as AiRequest<unknown>);
      return { data: req.schema.parse(reply(req as AiRequest<unknown>)), usage: USAGE, model: 'scripted' };
    },
  };
  return { provider, requests };
}

const sourceOf = (req: AiRequest<unknown>) => structuredClone(readBlock<{ profile: ProfileWire }>(req.prompt, 'dados')!.profile);

/** Traduz `REALISTIC_PROFILE` aplicando `mutate` ao que o "modelo" devolve. */
const translate = (mutate: (p: ProfileWire) => void, source: CandidateProfile = REALISTIC_PROFILE) => {
  const { provider } = scripted((req) => {
    const p = sourceOf(req);
    mutate(p);
    return p;
  });
  return translateProfile(provider, source, 'en');
};
const violationsOf = async (mutate: (p: ProfileWire) => void) => {
  const error = await translate(mutate).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProfileTranslationError);
  return (error as ProfileTranslationError).violations.map((v) => `${v.code}@${v.path}:${v.detail ?? ''}`);
};

/** Uma tradução honesta do perfil realista para o inglês. */
const honestEnglish = (p: ProfileWire) => {
  p.contact.location = 'São Paulo, Brazil';
  p.summary = 'Fictional person for tests: front-end developer focused on React.';
  p.experiences[0].title = 'Front-end Developer';
  p.experiences[0].location = 'Remote';
  p.experiences[0].achievements[0].text = 'Cut build time by 40% by migrating to Vite';
  p.experiences[0].achievements[1].text = 'Led three people in the checkout redesign';
  p.experiences[0].achievements[2].text = 'Maintained the payments API in Node.js, with BRL 1.5 million processed per month';
  p.experiences[1].title = 'Intern';
  p.experiences[1].achievements[0].text = 'Supported 40 internal clients';
  p.education[0].degree = 'Computer Science';
  p.languages[0] = { ...p.languages[0], name: 'English', level: 'advanced' };
  p.links[0].label = 'Portfolio';
};

describe('A2: profile translation is checked field by field', () => {
  it('accepts an honest translation and copies names, companies, dates, e-mail, phone and urls from the source', async () => {
    const { data, usage, model } = await translate((p) => {
      honestEnglish(p);
      // O que o modelo devolver nos campos copiados é ignorado.
      p.contact = { ...p.contact, name: 'Mary Example', email: 'outra@exemplo.test', phone: '+1 555' };
      p.experiences[0] = { ...p.experiences[0], company: 'Google', start: '2010-01', end: '' };
      p.education[0] = { ...p.education[0], institution: 'MIT', end: '2001' };
      p.links[0].url = 'https://outro.exemplo.test';
    });
    expect({ usage, model }).toEqual({ usage: USAGE, model: 'scripted' });
    expect(data.contact).toEqual({ ...REALISTIC_PROFILE.contact, location: 'São Paulo, Brazil' });
    expect(data.experiences[0]).toMatchObject({ company: 'Empresa Fictícia Ltda', start: '2021-03', end: '2024-06', title: 'Front-end Developer' });
    expect(data.experiences[0].achievements[2].text).toContain('BRL 1.5 million');
    expect(data.education[0]).toMatchObject({ institution: 'Universidade Exemplo', degree: 'Computer Science', end: '2019' });
    expect(data.links[0]).toMatchObject({ url: REALISTIC_PROFILE.links[0].url, label: 'Portfolio' });
    expect(data.languages[0]).toMatchObject({ name: 'English', level: 'advanced' });
  });

  it('fails with a typed error that carries the violations, the usage and the model', async () => {
    const error = await translate((p) => {
      honestEnglish(p);
      p.summary = 'Front-end developer with 10 years at Google.';
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProfileTranslationError);
    expect(error).toMatchObject({ name: 'ProfileTranslationError', kind: 'invalid_output', usage: USAGE, model: 'scripted' });
    expect((error as ProfileTranslationError).violations.map((v) => `${v.code}@${v.path}:${v.detail}`)).toEqual([
      'new_number@summary:10', 'novel_term@summary:Google',
    ]);
    expect((error as Error).message).toContain('summary');
  });

  it('blocks a changed number, magnitude or currency in a translated achievement', async () => {
    const path = 'experiences[0].achievements[2].text';
    const withText = (text: string) => violationsOf((p) => { honestEnglish(p); p.experiences[0].achievements[2].text = text; });
    expect(await withText('Maintained the payments API in Node.js, with $15 million processed per month')).toEqual([
      `new_number@${path}:USD15000000`, `new_number@${path}:BRL1500000`,
    ]);
    expect(await withText('Maintained the payments API in Node.js, with $1.5 million processed per month')).toEqual([
      `new_number@${path}:USD1500000`, `new_number@${path}:BRL1500000`,
    ]);
    expect(await withText('Maintained the payments API in Node.js, with R$ 1.5 billion processed per month')).toHaveLength(2);
    expect(await withText('Maintained the payments API in Node.js')).toEqual([`new_number@${path}:BRL1500000`]);
    expect(await violationsOf((p) => { honestEnglish(p); p.experiences[0].achievements[0].text = 'Cut build time by 60% by migrating to Vite'; }))
      .toEqual(['new_number@experiences[0].achievements[0].text:60%', 'new_number@experiences[0].achievements[0].text:40%']);
  });

  it('accepts equivalent spellings of the same number', () => {
    expect(numberMismatch('R$ 1,5 milhão processado', 'BRL 1.5 million processed')).toEqual([]);
    expect(numberMismatch('R$ 1,5 milhão processado', '1.5 million reais processed')).toEqual([]);
    expect(numberMismatch('R$ 1,5 milhão processado', 'R$1,500,000 processed')).toEqual([]);
    expect(numberMismatch('Atendi 1.200 clientes em 24h desde 03/2021', 'Served 1,200 clients in 24 hours since March 2021')).toEqual([]);
    expect(numberMismatch('Liderei 3 pessoas', 'Led three people')).toEqual([]);
    expect(numberMismatch('40 por cento', '40%')).toEqual([]);
    expect(numberMismatch('dezenas de clientes em uma década', 'dozens of clients in a decade')).toEqual([]);
    expect(numberMismatch('R$ 1,5 milhão', '$15 million')).toEqual(['USD15000000', '-BRL1500000']);
  });

  it('blocks an invented technology, acronym, seniority or degree', async () => {
    expect(await violationsOf((p) => { honestEnglish(p); p.summary += ' Experienced with Kubernetes, AWS and GraphQL.'; }))
      .toEqual(['novel_term@summary:Kubernetes', 'novel_term@summary:AWS', 'novel_term@summary:GraphQL']);
    expect(await violationsOf((p) => { honestEnglish(p); p.experiences[0].title = 'Senior Front-end Developer'; }))
      .toEqual(['novel_term@experiences[0].title:senior']);
    expect(await violationsOf((p) => { honestEnglish(p); p.experiences[1].title = 'CTO'; })).toContain('novel_term@experiences[1].title:CTO');
    expect(await violationsOf((p) => { honestEnglish(p); p.education[0].degree = 'PhD in Computer Science'; }))
      .toEqual(['novel_term@education[0].degree:PhD', 'novel_term@education[0].degree:phd']);
    expect(await violationsOf((p) => { honestEnglish(p); p.experiences[0].achievements[1].text = `Led three people. ${'I also founded several startups. '.repeat(20)}`; }))
      .toEqual(['limit@experiences[0].achievements[1].text:']);
  });

  it('never takes technology and certification names from the model: the source value is kept, without failing', async () => {
    const source = structuredClone(REALISTIC_PROFILE);
    source.skills.push({ id: 'skill_cccccccc', name: 'Gestão de projetos' }, { id: 'skill_dddddddd', name: 'Go' });
    source.certifications = [{ id: 'cert_eeeeeeee', name: 'AWS Certified Developer', issuer: 'Amazon', date: '2023' }];
    const { data } = await translate((p) => {
      honestEnglish(p);
      p.skills[0].name = 'React, Kubernetes'; // item a mais
      p.skills[1].name = 'TypeScript 5'; // número novo
      p.skills[2].name = 'Deno'; // troca de tecnologia
      p.skills[4].name = 'Project management'; // rótulo genuinamente traduzível
      p.skills[5].name = 'Ir'; // "tradução" de nome próprio
      p.certifications[0] = { ...p.certifications[0], name: 'AWS Certified Solutions Architect', issuer: 'Google', date: '2025' };
    }, source);
    expect(data.skills.map((k) => k.name)).toEqual(['React', 'TypeScript', 'Node.js', 'Java', 'Project management', 'Go']);
    expect(data.certifications[0]).toEqual(source.certifications[0]);
  });

  it('falls back to the source when a translated field is empty or whitespace', async () => {
    const { data } = await translate((p) => {
      honestEnglish(p);
      p.summary = '   ';
      p.experiences[0].title = '';
      p.experiences[0].achievements[0].text = '';
      p.education[0].degree = '';
      p.languages[0] = { ...p.languages[0], name: '', level: ' ' };
      p.links[0].label = '';
      p.skills[0].name = '';
    });
    expect(data.summary).toBe(REALISTIC_PROFILE.summary);
    expect(data.experiences[0].title).toBe('Desenvolvedora Front-end');
    expect(data.experiences[0].achievements[0].text).toBe(REALISTIC_PROFILE.experiences[0].achievements[0].text);
    expect(data.education[0].degree).toBe('Ciência da Computação');
    expect(data.languages[0]).toMatchObject({ name: 'Inglês', level: 'avançado' });
    expect(data.links[0].label).toBe('Portfólio');
    expect(data.skills[0].name).toBe('React');
  });

  it('does not let the model fill a field that is empty in the source', async () => {
    const { data } = await translate((p) => { honestEnglish(p); p.experiences[1].location = 'Googleplex'; });
    expect(data.experiences[1].location).toBe('');
  });

  it('carries the usage when the model drops an item', async () => {
    const { provider } = scripted((req) => ({ ...sourceOf(req), skills: [] }));
    await expect(translateProfile(provider, SAMPLE_PROFILE, 'en')).rejects.toMatchObject({ kind: 'invalid_output', usage: USAGE, model: 'scripted' });
  });
});

describe('A1: inputs are bounded before the call and failures after it carry the usage', () => {
  it('relates the résumé cap to the output cap', () => {
    expect(PROFILE_OUTPUT_TOKENS).toBe(8_000);
    expect(PROFILE_JSON_MAX_CHARS).toBe(24_000);
    expect(RESUME_TEXT_MAX_CHARS).toBe(19_200);
  });

  it('rejects an over-long résumé with a typed, non-retryable error and without calling the model', async () => {
    const { provider, requests } = scripted(() => ({}));
    const long = `${SAMPLE_RESUME_TEXT}\n${'Linha de experiência muito detalhada. '.repeat(600)}`;
    const error = await extractProfile(provider, long).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect(error).toMatchObject({ kind: 'input', what: 'resume', maxChars: RESUME_TEXT_MAX_CHARS });
    expect((error as AiError).usage).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('does not count runs of spaces and blank lines against the résumé cap', async () => {
    const padded = SAMPLE_RESUME_TEXT.split('\n').join(`${' '.repeat(400)}\n\n\n\n`) + ' '.repeat(30_000);
    expect(padded.length).toBeGreaterThan(RESUME_TEXT_MAX_CHARS);
    const { provider, requests } = scripted(() => ({
      contact: { name: 'Maria', email: '', phone: '', location: '' }, summary: '', experiences: [], education: [], skills: [],
      languages: [], certifications: [], links: [],
    }));
    await extractProfile(provider, padded);
    const sent = readBlock<{ text: string }>(requests[0].prompt, 'dados')!.text;
    expect(sent.length).toBeLessThan(SAMPLE_RESUME_TEXT.length + 40);
    expect(sent).toContain('Maria Exemplo da Silva\n');
  });

  it('rejects a profile too large to translate in one call, before calling the model', async () => {
    const big = structuredClone(REALISTIC_PROFILE);
    big.experiences[0].achievements = Array.from({ length: 20 }, (_, i) => ({ id: `ach_${String(i).padStart(8, 'x')}`, text: 'Realização longa. '.repeat(100) }));
    const { provider, requests } = scripted(() => ({}));
    await expect(translateProfile(provider, big, 'en')).rejects.toMatchObject({ name: 'InputTooLargeError', kind: 'input', what: 'profile' });
    expect(requests).toHaveLength(0);
  });

  it('carries the usage when the extracted profile is empty or invalid', async () => {
    const { provider } = scripted(() => ({
      contact: { name: '', email: '', phone: '', location: '' }, summary: 'x', experiences: [], education: [], skills: [],
      languages: [], certifications: [], links: [],
    }));
    await expect(extractProfile(provider, 'texto')).rejects.toMatchObject({ kind: 'invalid_output', usage: USAGE, model: 'scripted' });
  });

  it('clips job title, company and location and the description in every tier', async () => {
    const job = { id: 7, title: 't'.repeat(5_000), company: 'c'.repeat(5_000), location: 'l'.repeat(5_000), description: 'd'.repeat(100_000) };
    const t1 = scripted(() => ({ results: [] }));
    await scoreJobs(t1.provider, SAMPLE_PROFILE, [job]);
    const [sent1] = readBlock<{ jobs: Record<string, string>[] }>(t1.requests[0].prompt, 'dados')!.jobs;
    expect([sent1.title.length, sent1.company.length, sent1.location.length, sent1.excerpt.length]).toEqual([
      JOB_FIELD_CHARS, JOB_FIELD_CHARS, JOB_FIELD_CHARS, TIER1_EXCERPT_CHARS,
    ]);
    const analysis = { strengths: [], gaps: [], keywordsPresent: [], keywordsMissing: [], interviewTopics: [], likelyQuestions: [] };
    const t2 = scripted(() => ({ language: 'en', descriptionPt: '', analysis }));
    await analyzeJob(t2.provider, SAMPLE_PROFILE, job);
    const t3 = scripted(() => ({ summary: '', experiences: [], educationIds: [], skillIds: [], languageIds: [], certificationIds: [], linkIds: [] }));
    await draftTailored(t3.provider, SAMPLE_PROFILE, job, 'en');
    // A camada 2 traduz a descrição inteira, então lê menos que a camada 3 (que só a consulta).
    for (const [{ requests }, descriptionChars] of [[t2, TIER2_DESCRIPTION_CHARS], [t3, TIER3_DESCRIPTION_CHARS]] as const) {
      const sent = readBlock<{ job: Record<string, string> }>(requests[0].prompt, 'dados')!.job;
      expect([sent.title.length, sent.company.length, sent.location.length, sent.description.length]).toEqual([
        JOB_FIELD_CHARS, JOB_FIELD_CHARS, JOB_FIELD_CHARS, descriptionChars,
      ]);
    }
  });

  it('the tier-2 description bound leaves room for the whole translation and the lists inside the output cap', () => {
    // 3 caracteres por token (conservador), tradução para o português até 20% maior que o original.
    const translationTokens = Math.ceil((TIER2_DESCRIPTION_CHARS * 1.2) / 3);
    // Seis listas de até 8 itens (o que o prompt pede) com ~150 caracteres cada.
    const listTokens = Math.ceil((6 * 8 * 150) / 3);
    expect(TIER2_DESCRIPTION_CHARS).toBe(12_000);
    expect(translationTokens + listTokens).toBeLessThanOrEqual(TIER2_OUTPUT_TOKENS);
    expect(TIER2_DESCRIPTION_CHARS).toBeLessThan(TIER3_DESCRIPTION_CHARS);
  });

  it('estimates the usage of an aborted or interrupted call on the safe side: prompt size in, output cap out', () => {
    expect(estimateAbortedUsage({ tier: 'strong', system: 'a'.repeat(3_000), prompt: 'b'.repeat(601), maxOutputTokens: 8_000 })).toEqual({
      inputTokens: 1_201, outputTokens: 16_000,
    });
    expect(outputAllowance('fast', 1_800)).toBe(3_800);
    expect(estimateInterruptedUsage('tier2')).toEqual({ inputTokens: 13_300, outputTokens: 16_000 });
    expect(estimateInterruptedUsage('tier3')).toEqual({ inputTokens: 15_967, outputTokens: 14_000 });
    expect(estimateInterruptedUsage('profile_translate')).toEqual({ inputTokens: 9_000, outputTokens: 16_000 });
    expect(estimateInterruptedUsage('tier1')).toEqual({ inputTokens: 800, outputTokens: 380 });
    // O tempo limite do SDK comporta o teto de saída do nível a 40 tokens por segundo.
    expect(CALL_TIMEOUT_MS.strong / 1000).toBeGreaterThanOrEqual(outputAllowance('strong', TIER2_OUTPUT_TOKENS) / 40);
    expect(CALL_TIMEOUT_MS.fast / 1000).toBeGreaterThanOrEqual(outputAllowance('fast', 1_800) / 40);
  });

  it('testConnection keeps reporting a cut answer as invalid_output (key and model work), with the usage', async () => {
    const provider: AiProvider = {
      id: 'fake',
      async generate() {
        throw new AiError('truncated', 'resposta cortada pelo limite de tokens', undefined, { usage: USAGE, model: 'm' });
      },
    };
    await expect(testConnection(provider)).rejects.toMatchObject({ kind: 'invalid_output', usage: USAGE, model: 'm' });
  });

  it('the fake provider reports usage on an invalid output, like the real ones', async () => {
    const { createFakeProvider } = await import('./fake');
    const error = await draftTailored(createFakeProvider(), SAMPLE_PROFILE, { ...SAMPLE_JOB, description: 'FAKE_AI_EXTRA_FIELD' }, 'pt-BR').catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'invalid_output', model: 'fake-strong' });
    expect((error as AiError).usage?.inputTokens).toBeGreaterThan(0);
  });
});

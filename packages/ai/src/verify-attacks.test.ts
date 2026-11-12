import { describe, expect, it } from 'vitest';
import { LIMITS, type TailoredDraft } from '@kv/shared';
import { REALISTIC_PROFILE } from './testing';
import { companyCore, resolveTailored, violationCodes, type ResolveOptions } from './verify';

const ch = (code: number) => String.fromCodePoint(code);
const ZWSP = ch(0x200b);
const NBSP = ch(0xa0);

/** Rascunho honesto sobre o perfil realista (ids com dígitos, telefone, datas com mês). */
const honest = (): TailoredDraft => ({
  summary: 'Desenvolvedora front-end com foco em React e TypeScript.',
  experiences: [
    {
      id: 'exp_k3j9x0aq',
      achievements: [
        { sourceId: 'ach_10ab7cde', text: 'Migrei o build para Vite e cortei 40% do tempo' },
        { sourceId: 'ach_zz15yy20', text: 'Liderei 3 pessoas no redesenho do checkout' },
      ],
    },
  ],
  educationIds: ['edu_4f5g6h7j'],
  skillIds: ['skill_1a2b3c4d'],
  languageIds: ['lang_3m4n5o6p'],
  certificationIds: [],
  linkIds: [],
});

const JOB: ResolveOptions = {
  jobCompany: 'Acme Fictícia Ltda',
  jobTitle: 'Senior React Engineer (Kubernetes)',
  jobKeywords: ['Kubernetes', 'React', 'TypeScript', 'design system', 'testes automatizados', 'GraphQL'],
};

const check = (mutate: (d: TailoredDraft) => void, opts: ResolveOptions = JOB) => {
  const draft = honest();
  mutate(draft);
  return resolveTailored(draft, REALISTIC_PROFILE, 'pt-BR', opts).violations;
};
const summary = (text: string, opts?: ResolveOptions) => check((d) => { d.summary = text; }, opts);
const ach = (i: number, text: string, opts?: ResolveOptions) => check((d) => { d.experiences[0].achievements[i].text = text; }, opts);
const codes = (vs: { code: string }[]) => [...new Set(vs.map((v) => v.code))].sort();

describe('V1: the summary number allow-list comes from content fields only', () => {
  it.each([
    ['Mais de 9 anos de experiência.'],
    ['Mais de 10 anos de experiência.'],
    ['Liderei 15 squads e 20 projetos.'],
    ['Gerenciei 55 pessoas e 5678 deploys.'],
    ['Entreguei 99 projetos em 2024 dias.'],
  ])('blocks %s (digits that only exist in ids, phone, e-mail or URL)', (text) => {
    expect(codes(summary(text, {}))).toContain('new_number');
  });

  it('accepts numbers and dates that are facts of the profile', () => {
    expect(summary('Reduzi builds em 40% e liderei 3 pessoas.')).toEqual([]);
    expect(summary('Atuo com front-end desde 2021, formada em 2019.')).toEqual([]);
    expect(summary('Na função desde 03/2021.')).toEqual([]);
  });

  it('does not take the month of a date as a free number', () => {
    // "2019-10" e "2021-03" estão no perfil; "10" e "03" sozinhos não são fatos.
    expect(codes(summary('Liderei 10 pessoas.'))).toEqual(['new_number']);
    expect(codes(summary('Na função desde 09/2021.'))).toEqual(['new_number']);
  });
});

describe('V2: magnitude, unit and non-ASCII digits are part of the number', () => {
  it.each([
    ['mil', 1, 'Liderei 3 mil pessoas no redesenho do checkout'],
    ['k', 0, 'Cortei 40k horas de build com Vite'],
    ['milhões + moeda', 0, 'Economizei R$ 40 milhões com a migração para Vite'],
    ['% → x', 0, 'Deixei o build 40x mais rápido com Vite'],
    ['% dropped', 0, 'Cortei 40 horas do tempo de build'],
    ['full-width digits', 0, `Cortei ${ch(0xff19)}${ch(0xff10)}% do tempo de build`],
    ['Arabic-Indic digits', 0, `Cortei ${ch(0x669)}${ch(0x660)}% do tempo de build`],
    ['superscript', 1, `Liderei 3${ch(0xb2)} pessoas no redesenho do checkout`],
    ['zero-width inside the number', 0, `Cortei 4${ZWSP}0${ZWSP}0% do tempo de build`],
    ['number in words', 1, 'Liderei trinta pessoas no redesenho do checkout'],
    ['year in words', 1, 'Liderei 3 pessoas no redesenho do checkout desde dois mil e dezoito'],
    ['vague quantity', 1, 'Liderei dezenas de pessoas no redesenho do checkout'],
  ])('blocks %s', (_name, i, text) => {
    expect(codes(ach(i, text))).toContain('new_number');
  });

  it('keeps separators and equivalent spellings equal', () => {
    const profile = structuredClone(REALISTIC_PROFILE);
    profile.experiences[0].achievements[0].text = 'Atendi 1.200 clientes e movimentei R$ 2 milhões em 24h';
    const run = (text: string) => {
      const d = honest();
      d.experiences[0].achievements[0].text = text;
      return resolveTailored(d, profile, 'pt-BR').violations;
    };
    expect(run('Atendi 1,200 clientes')).toEqual([]);
    expect(run('Atendi 1200 clientes')).toEqual([]);
    expect(run('Movimentei 2 milhões de reais atendendo clientes')).toEqual([]);
    expect(run('Movimentei R$ 2.000.000 atendendo clientes')).toEqual([]);
    expect(run('Atendi clientes em 24h')).toEqual([]);
    expect(codes(run('Movimentei US$ 2 milhões atendendo clientes'))).toEqual(['new_number']);
    expect(codes(run('Movimentei R$ 2 bilhões atendendo clientes'))).toEqual(['new_number']);
    expect(codes(run('Atendi 1.200 mil clientes'))).toEqual(['new_number']);
  });

  it('accepts a profile number written in words', () => {
    expect(ach(1, 'Liderei três pessoas no redesenho do checkout')).toEqual([]);
  });
});

describe('V3: novel terms in free text', () => {
  it.each([
    ['employers', 'Ex-engenheira sênior do Google e da Amazon, com foco em React.', ['Google', 'Amazon']],
    ['titles', 'CTO e Staff Engineer com foco em React.', ['CTO', 'Staff', 'Engineer']],
    ['degrees', 'Doutora em IA pelo MIT, com MBA em Harvard.', ['Doutora', 'IA', 'MIT', 'MBA', 'Harvard']],
    ['skills', 'Especialista em Kubernetes, AWS, Go e Rust.', ['Kubernetes', 'AWS', 'Go', 'Rust']],
    ['lowercase known names', 'especialista em kubernetes, docker e aws.', ['kubernetes', 'docker', 'aws']],
    ['technical tokens', 'Experiência com C#, ASP.NET, OAuth2 e GraphQL.', ['C#', 'ASP.NET', 'OAuth2', 'GraphQL']],
    ['look-alike letters', `Trabalhei no G${ch(0x43e)}${ch(0x43e)}gle com React.`, [`G${ch(0x43e)}${ch(0x43e)}gle`]],
    ['seniority inflation', 'Desenvolvedora front-end sênior com foco em React.', ['sênior']],
  ])('flags invented %s in the summary', (_name, text, terms) => {
    const found = summary(text, {}).filter((v) => v.code === 'novel_term').map((v) => v.detail);
    for (const term of terms) expect(found).toContain(term);
  });

  it('flags an invented skill or employer inside a rewritten achievement, against the whole profile', () => {
    expect(ach(0, 'Migrei o build para Vite com Kubernetes e Terraform e cortei 40% do tempo', {}).map((v) => v.detail)).toEqual(['Kubernetes', 'Terraform']);
    expect(ach(1, 'Liderei 3 pessoas no redesenho do checkout da Microsoft', {}).map((v) => v.detail)).toEqual(['Microsoft']);
    // "Node.js" e "TypeScript" estão em outro lugar do perfil: aceitos (ver LIMITE CONHECIDO).
    expect(ach(1, 'Liderei 3 pessoas no redesenho do checkout em Node e TypeScript', {})).toEqual([]);
  });

  it('flags an achievement with a real sourceId and unrelated text', () => {
    const vs = ach(1, 'Fundei a OpenAI e fui CEO da Tesla', {});
    expect(codes(vs)).toEqual(['novel_term', 'unrelated_text']);
    expect(codes(ach(1, 'Organizei eventos internos para a comunidade', {}))).toEqual(['unrelated_text']);
    expect(codes(ach(1, '   ', {}))).toEqual(['unrelated_text']);
  });

  it('flags job keywords and job-title words that are not in the profile, in any case or position', () => {
    // Sem contexto da vaga, uma palavra desconhecida no começo da frase ou em minúsculas passa.
    expect(summary('Atuo com testes automatizados e design system em React.', {})).toEqual([]);
    expect(summary('Engineer com foco em React.', {})).toEqual([]);
    const vs = summary('Atuo com testes automatizados, design system e graphql em React.');
    expect(vs.map((v) => `${v.code}:${v.detail}`).sort()).toEqual(['novel_term:design system', 'novel_term:graphql', 'novel_term:testes automatizados']);
    expect(summary('Engineer com foco em React.').map((v) => v.detail)).toEqual(['Engineer']);
    // Palavras da vaga que o perfil tem não são problema.
    expect(summary('Desenvolvedora com foco em React e TypeScript.')).toEqual([]);
  });

  it('accepts legitimate rewrites with zero violations (false-positive set)', () => {
    const summaries = [
      'Desenvolvedora front-end com foco em React e TypeScript.',
      'Desenvolvedora Front-end com experiência em React, TypeScript, Node.js e Java.',
      'Profissional de front-end. Atuei na Empresa Fictícia Ltda de 2021 a 2024, onde reduzi o tempo de build em 40%.',
      'Formada em Ciência da Computação pela Universidade Exemplo. Inglês avançado.',
      'Experiência com NodeJS, Node e typescript em aplicações web; trabalho remoto desde março de 2021.',
      'Baseada em São Paulo, Brasil. Portfólio disponível.',
      '• Front-end em React\n• APIs em Node.js\n- Liderança de 3 pessoas',
      'Estagiária na Outra Fictícia e depois desenvolvedora: liderei pessoas, migrei builds e mantive APIs de pagamentos.',
      'Processei R$ 1,5 milhão por mês em pagamentos e atendi 40 clientes internos.',
      'Desenvolvedoras e desenvolvedores do time contaram comigo no redesenho do checkout.',
      '',
    ];
    for (const text of summaries) expect({ text, v: summary(text) }).toEqual({ text, v: [] });
    const achievements: [number, string][] = [
      [0, 'Migrei o build para Vite e cortei 40% do tempo'],
      [0, 'Redução de 40% no tempo de build após migração para o Vite.'],
      [0, 'Conduzi a migração para Vite, reduzindo em 40 por cento o tempo de build'],
      [1, 'Liderança de 3 pessoas no redesenho do checkout'],
      [1, 'Redesenhei o checkout à frente de uma equipe de três pessoas'],
      [1, 'Checkout: liderei o redesenho com 3 pessoas (React, TypeScript).'],
    ];
    for (const [i, text] of achievements) expect({ text, v: ach(i, text) }).toEqual({ text, v: [] });
  });

  it('accepts an honest English draft over an English profile', () => {
    const profile = structuredClone(REALISTIC_PROFILE);
    profile.summary = 'Front-end developer focused on React.';
    profile.experiences[0].title = 'Front-end Developer';
    profile.experiences[0].achievements[0].text = 'Cut build time by 40% by migrating to Vite';
    profile.experiences[0].achievements[1].text = 'Led 3 people in the checkout redesign';
    profile.education[0].degree = 'Computer Science';
    profile.languages = [{ id: 'lang_3m4n5o6p', name: 'English', level: 'advanced' }];
    const d = honest();
    d.summary = 'Front-end Developer focused on React and TypeScript. I hold a Computer Science degree and speak advanced English.';
    d.experiences[0].achievements[0].text = 'Migrated the build to Vite, cutting build time by 40 percent';
    d.experiences[0].achievements[1].text = 'Led a team of three people through the checkout redesign.';
    expect(resolveTailored(d, profile, 'en', JOB).violations).toEqual([]);
    d.summary = 'Front-end developer, formerly Software Engineer at Initech, with a PhD.';
    expect(resolveTailored(d, profile, 'en', {}).violations.map((v) => v.detail)).toEqual(['Software', 'Engineer', 'Initech', 'PhD']);
  });
});

describe('V4: the hiring company', () => {
  it('reduces a company name to its core', () => {
    expect(companyCore('Acme Fictícia Ltda.')).toEqual(['acme', 'ficticia']);
    expect(companyCore('Outra Fictícia S.A.')).toEqual(['outra', 'ficticia']);
    expect(companyCore('Exemplo Tech, Inc.')).toEqual(['exemplo', 'tech']);
    expect(companyCore('SA')).toEqual(['sa']);
  });

  it.each([
    ['exact', 'Quero trabalhar na Acme Fictícia Ltda.'],
    ['without the legal suffix', 'Quero levar minha experiência para a Acme Fictícia.'],
    ['zero-width space', `Quero trabalhar na Acme${ZWSP} Fictícia Ltda.`],
    ['Cyrillic A', `Quero trabalhar na ${ch(0x410)}cme Fictícia Ltda.`],
    ['NBSP', `Quero trabalhar na Acme${NBSP}Fictícia Ltda.`],
    ['no accent, other case', 'Quero trabalhar na ACME FICTICIA'],
  ])('blocks the company name: %s', (_name, text) => {
    expect(codes(summary(text, { jobCompany: 'Acme Fictícia Ltda' }))).toEqual(['foreign_company']);
  });

  it('checks two-letter names and names that are a substring or a skill of the profile', () => {
    expect(codes(summary('Trabalhei na HP com React.', { jobCompany: 'HP' }))).toEqual(['foreign_company']);
    expect(codes(summary('Fui engenheira na Java.', { jobCompany: 'Java' }))).toEqual(['foreign_company']);
    expect(codes(summary('Atuei como líder na Node.', { jobCompany: 'Node' }))).toEqual(['foreign_company']);
    // "Meta" não fica desligada por causa de "metadata", e a palavra comum em minúsculas não é a empresa.
    const profile = structuredClone(REALISTIC_PROFILE);
    profile.summary += ' Trabalho com metadata.';
    const run = (text: string) => resolveTailored({ ...honest(), summary: text }, profile, 'pt-BR', { jobCompany: 'Meta' }).violations;
    expect(codes(run('Quero trabalhar na Meta.'))).toEqual(['foreign_company']);
    expect(run('Bati a meta de entregas com React.')).toEqual([]);
  });

  it('accepts a company that is an employer in the profile, with or without the suffix', () => {
    expect(summary('Atuei na Empresa Fictícia Ltda.', { jobCompany: 'Empresa Fictícia' })).toEqual([]);
    expect(summary('Atuei na Empresa Fictícia.', { jobCompany: 'Empresa Fictícia Ltda' })).toEqual([]);
  });
});

describe('V5: limits on model output', () => {
  it('blocks over-long texts without running the other checks on them', () => {
    const started = Date.now();
    const vs = summary('a '.repeat(500_000));
    expect(vs.map((v) => v.code)).toEqual(['limit']);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(codes(ach(0, 'x'.repeat(LIMITS.profileLong + 1)))).toEqual(['limit']);
    expect(summary('Desenvolvedora front-end. '.repeat(70).trim().slice(0, LIMITS.profileLong))).toEqual([]);
  });

  it('blocks NUL, control characters and direction overrides', () => {
    expect(codes(summary(`abc${ch(0)}def`))).toEqual(['limit']);
    expect(codes(summary(`Desenvolvedora ${ch(0x1b)}[31m`))).toContain('limit');
    expect(codes(summary(`Desenvolvedora ${ch(0x202e)}tnorf`))).toContain('limit');
    expect(summary('Desenvolvedora front-end.\n\tFoco em React.')).toEqual([]);
  });

  it('blocks oversized lists and ids', () => {
    expect(codes(check((d) => { d.skillIds = Array.from({ length: LIMITS.profileItems + 1 }, () => 'skill_1a2b3c4d'); }))).toContain('limit');
    expect(codes(check((d) => { d.experiences = Array.from({ length: LIMITS.profileItems + 1 }, () => ({ id: 'exp_k3j9x0aq', achievements: [] })); }))).toContain('limit');
    expect(codes(check((d) => {
      d.experiences[0].achievements = Array.from({ length: LIMITS.achievements + 1 }, () => ({ sourceId: 'ach_10ab7cde', text: 'Migrei o build' }));
    }))).toContain('limit');
    expect(codes(check((d) => { d.skillIds = ['s'.repeat(LIMITS.profileShort + 1)]; }))).toEqual(['limit']);
  });

  it('lets the caller tell the codes apart', () => {
    expect(violationCodes(summary(`Mais de 10 anos no Google${ch(0)}`))).toEqual(['limit']);
    expect(violationCodes(summary('Mais de 10 anos no Google.')).sort()).toEqual(['new_number', 'novel_term']);
  });
});

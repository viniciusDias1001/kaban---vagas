import type { CandidateProfile } from '@kv/shared';

/** Dados fictícios para testes e para o roteiro manual `pnpm ai:smoke`. Nenhuma pessoa ou empresa real. */

export const SAMPLE_RESUME_TEXT = [
  'Maria Exemplo da Silva',
  'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  'maria@exemplo.test • São Paulo, SP',
  'Experiência',
  'Desenvolvedora Front-end | Empresa Fictícia Ltda | 2021-03 | 2024-06',
  '- Reduzi o tempo de build em 40% com a migração para Vite',
  '- Liderei 3 pessoas no redesenho do checkout',
  'Formação',
  'Ciência da Computação | Universidade Exemplo | 2015 | 2019',
  'Habilidades',
  'React, TypeScript, Node',
  'Idiomas',
  'Português (nativo), Inglês (avançado)',
].join('\n');

export const SAMPLE_PROFILE: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' },
  summary: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  experiences: [
    {
      id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end', start: '2021-03',
      end: '2024-06', location: 'Remoto',
      achievements: [
        { id: 'ach_aaaaaaa1', text: 'Reduzi o tempo de build em 40% com a migração para Vite' },
        { id: 'ach_aaaaaaa2', text: 'Liderei 3 pessoas no redesenho do checkout' },
      ],
    },
  ],
  education: [
    { id: 'edu_aaaaaaa1', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' },
  ],
  skills: [
    { id: 'skill_aaaaaaa1', name: 'React' },
    { id: 'skill_aaaaaaa2', name: 'TypeScript' },
    { id: 'skill_aaaaaaa3', name: 'Node' },
  ],
  languages: [{ id: 'lang_aaaaaaa1', name: 'Inglês', level: 'avançado' }],
  certifications: [],
  links: [{ id: 'link_aaaaaaa1', label: 'Portfólio', url: 'https://exemplo.test/maria' }],
};

export const SAMPLE_JOB = {
  id: 1,
  title: 'Senior React Engineer',
  company: 'Acme Fictícia',
  location: 'Remote',
  description:
    'We are looking for a Senior React Engineer with TypeScript experience to build our checkout. ' +
    'You will work with Node services and mentor other developers.',
};

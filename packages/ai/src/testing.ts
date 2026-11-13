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
  headline: '',
  summary: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  experiences: [
    {
      id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end', start: '2021-03',
      end: '2024-06', location: 'Remoto', section: 'principal', note: '',
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
    { id: 'skill_aaaaaaa1', name: 'React', group: '' },
    { id: 'skill_aaaaaaa2', name: 'TypeScript', group: '' },
    { id: 'skill_aaaaaaa3', name: 'Node', group: '' },
  ],
  languages: [{ id: 'lang_aaaaaaa1', name: 'Inglês', level: 'avançado' }],
  certifications: [],
  links: [{ id: 'link_aaaaaaa1', label: 'Portfólio', url: 'https://exemplo.test/maria' }],
};

/**
 * Perfil com cara de dado real, para os testes do verificador: ids aleatórios com dígitos, telefone, duas
 * experiências, datas com mês. Um teste que só passa porque um dígito de id ou de telefone "liberou" um
 * número falha com este perfil.
 */
export const REALISTIC_PROFILE: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria.exemplo99@exemplo.test', phone: '+55 11 91234-5678', location: 'São Paulo, SP' },
  headline: '',
  summary: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  experiences: [
    {
      id: 'exp_k3j9x0aq', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end', start: '2021-03',
      end: '2024-06', location: 'Remoto', section: 'principal', note: '',
      achievements: [
        { id: 'ach_10ab7cde', text: 'Reduzi o tempo de build em 40% com a migração para Vite' },
        { id: 'ach_zz15yy20', text: 'Liderei 3 pessoas no redesenho do checkout' },
        { id: 'ach_8d2f6g1h', text: 'Mantive a API de pagamentos em Node.js, com R$ 1,5 milhão processado por mês' },
      ],
    },
    {
      id: 'exp_bbbbbbb2', company: 'Outra Fictícia SA', title: 'Estagiária', start: '2019-10', end: '2021-02', location: '', section: 'principal', note: '',
      achievements: [{ id: 'ach_bbbbbbb1', text: 'Atendi 40 clientes internos' }],
    },
  ],
  education: [
    { id: 'edu_4f5g6h7j', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' },
  ],
  skills: [
    { id: 'skill_1a2b3c4d', name: 'React', group: '' },
    { id: 'skill_5e6f7g8h', name: 'TypeScript', group: '' },
    { id: 'skill_9i0j1k2l', name: 'Node.js', group: '' },
    { id: 'skill_bbbbbbb4', name: 'Java', group: '' },
  ],
  languages: [{ id: 'lang_3m4n5o6p', name: 'Inglês', level: 'avançado' }],
  certifications: [],
  links: [{ id: 'link_7q8r9s0t', label: 'Portfólio', url: 'https://exemplo.test/maria2024' }],
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

/** SAMPLE_PROFILE com os campos do modelo preenchidos. */
export const LAYOUT_PROFILE: CandidateProfile = {
  ...SAMPLE_PROFILE,
  headline: 'Desenvolvedora Front-end Sênior',
  experiences: [
    { ...SAMPLE_PROFILE.experiences[0], section: 'principal', note: 'Promovida após 18 meses' },
    { id: 'exp_aaaaaaa2', company: 'Outra Fictícia SA', title: 'Monitora de Programação', start: '2018', end: '2019', location: '',
      section: 'complementar', note: '', achievements: [{ id: 'ach_aaaaaaa3', text: 'Atendi 40 estudantes por semestre' }] },
  ],
  skills: [
    { id: 'skill_aaaaaaa1', name: 'React', group: 'Front-end' }, { id: 'skill_aaaaaaa2', name: 'TypeScript', group: 'Front-end' },
    { id: 'skill_aaaaaaa3', name: 'Node', group: 'Back-end & APIs' }, { id: 'skill_aaaaaaa4', name: 'PostgreSQL', group: 'Banco de dados' },
    { id: 'skill_aaaaaaa5', name: 'MySQL', group: 'Banco de dados' }, { id: 'skill_aaaaaaa6', name: 'Docker', group: 'DevOps & Kubernetes' },
  ],
};

/** O mesmo perfil como era gravado antes: sem headline, group, section e note. */
export function legacyProfile(profile: CandidateProfile): CandidateProfile {
  const { headline: _headline, ...rest } = profile;
  return {
    ...rest,
    experiences: profile.experiences.map(({ section: _section, note: _note, ...e }) => e),
    skills: profile.skills.map(({ group: _group, ...k }) => k),
  };
}

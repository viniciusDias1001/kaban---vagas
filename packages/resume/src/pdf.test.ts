import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '@kv/shared';
import { extractResumeText } from './extract';
import { renderResumePdf } from './pdf';
import { sniffResume } from './sniff';

/** Pessoa fictícia, com os acentos e sinais que um currículo em português usa. */
const resume: TailoredResume = {
  lang: 'pt-BR',
  contact: { name: 'João Conceição Exemplo', email: 'joao@exemplo.test', phone: '+55 11 90000-0000', location: 'São Paulo, SP' },
  summary: 'Pessoa fictícia. Atuação em avaliação, gestão e migração de aplicações: ã õ á é í ó ú â ê ô à ç ü Ã Õ Ç É.',
  experiences: [
    {
      id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Sênior', start: '2021-03', end: '',
      location: 'Remoto',
      achievements: [
        { sourceId: 'ach_aaaaaaa1', text: 'Reduzi o tempo de build em 40% com a migração para Vite' },
        { sourceId: 'ach_aaaaaaa2', text: 'Economia de R$ 1.000,00 por mês: "infra" mais simples' },
      ],
    },
    { id: 'exp_aaaaaaa2', company: 'Outra Fictícia S.A.', title: 'Estagiário', start: '2019', end: '2020', location: '', achievements: [] },
  ],
  education: [{ id: 'edu_aaaaaaa1', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' }],
  skills: [{ id: 'skill_aaaaaaa1', name: 'React' }, { id: 'skill_aaaaaaa2', name: 'TypeScript' }],
  languages: [{ id: 'lang_aaaaaaa1', name: 'Inglês', level: 'avançado' }],
  certifications: [{ id: 'cert_aaaaaaa1', name: 'Certificação Fictícia', issuer: 'Instituto Exemplo', date: '2022' }],
  links: [{ id: 'link_aaaaaaa1', label: 'Portfólio', url: 'https://exemplo.test/joao' }],
};

async function textOf(r: TailoredResume): Promise<string> {
  const pdf = await renderResumePdf(r);
  expect(sniffResume(pdf)).toBe('pdf');
  const result = await extractResumeText(pdf, 'pdf');
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

describe('renderResumePdf', () => {
  it('produces real, selectable text: everything can be extracted back, accents included', async () => {
    const text = await textOf(resume);
    for (const expected of [
      'João Conceição Exemplo',
      'joao@exemplo.test | +55 11 90000-0000 | São Paulo, SP',
      'ã õ á é í ó ú â ê ô à ç ü Ã Õ Ç É',
      'Desenvolvedora Sênior - Empresa Fictícia Ltda',
      '2021-03 - atual | Remoto',
      '• Reduzi o tempo de build em 40% com a migração para Vite',
      '• Economia de R$ 1.000,00 por mês: "infra" mais simples',
      'Ciência da Computação - Universidade Exemplo | 2015 - 2019',
      'React, TypeScript',
      'Inglês (avançado)',
      'Certificação Fictícia | Instituto Exemplo | 2022',
      'Portfólio: https://exemplo.test/joao',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('is a single column: the extracted text follows the reading order of the content', async () => {
    const text = await textOf(resume);
    const order = [
      'João Conceição Exemplo', 'RESUMO', 'EXPERIÊNCIA', 'Desenvolvedora Sênior', 'Reduzi o tempo', 'Estagiário',
      'FORMAÇÃO', 'HABILIDADES', 'IDIOMAS', 'CERTIFICAÇÕES', 'LINKS',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('uses english headings for an english resume and skips empty sections', async () => {
    const text = await textOf({ ...resume, lang: 'en', certifications: [], links: [], summary: '' });
    expect(text).toContain('EXPERIENCE');
    expect(text).toContain('2021-03 - present');
    expect(text).not.toContain('CERTIFICATIONS');
    expect(text).not.toContain('SUMMARY');
    expect(text).not.toContain('EXPERIÊNCIA');
  });

  it('embeds the font and carries no image', async () => {
    const raw = (await renderResumePdf(resume)).toString('latin1');
    expect(raw).toContain('/FontFile');
    expect(raw).not.toContain('/Subtype /Image');
  });

  it('breaks a long resume into pages instead of cutting it', async () => {
    const many = { ...resume.experiences[0], achievements: Array.from({ length: 20 }, (_, i) => ({ sourceId: 'ach_aaaaaaa1', text: `Realização número ${i + 1} com um texto longo o bastante para ocupar a linha inteira do documento.` })) };
    const text = await textOf({ ...resume, experiences: [many, many, many, many] });
    expect(text.match(/Realização número 20 /g)).toHaveLength(4);
  });
});

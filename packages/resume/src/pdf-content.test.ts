import { describe, expect, it } from 'vitest';
import { bareUrl, footerName, formatPeriod, formatResumeDate, resumeContent } from './pdf-content';
import { SAMPLE_TAILORED } from './testing';

describe('pdf content', () => {
  it('formats dates, periods, links and the footer name', () => {
    expect([formatResumeDate('2026-02', 'pt-BR'), formatResumeDate('2026-02', 'en'), formatResumeDate(' 2019 ', 'en')]).toEqual(['Fev 2026', 'Feb 2026', '2019']);
    expect([formatResumeDate('mar/2021', 'pt-BR'), formatResumeDate('2021-13', 'pt-BR'), formatResumeDate('', 'en')]).toEqual(['mar/2021', '2021-13', '']);
    expect([formatPeriod('2021-03', '', 'pt-BR'), formatPeriod('2021-03', '', 'en'), formatPeriod('', '', 'en'), formatPeriod('', '2019', 'en')])
      .toEqual(['Mar 2021 - Atual', 'Mar 2021 - Present', '', '2019']);
    expect([bareUrl('https://exemplo.test/maria/'), bareUrl('HTTP://Exemplo.test')]).toEqual(['exemplo.test/maria', 'Exemplo.test']);
    expect(footerName('JOÃO CONCEIÇÃO E SOUZA-LIMA')).toBe('João Conceição e Souza-Lima');
    expect(footerName('Maria exemplo da SILVA')).toBe('Maria exemplo da SILVA'); // não está toda em maiúsculas: sai como está
  });
  it('writes the header, the sections in the order of the model and every line', () => {
    const c = resumeContent(SAMPLE_TAILORED);
    expect(c).toMatchObject({ name: 'MARIA EXEMPLO DA SILVA', headline: 'DESENVOLVEDORA FRONT-END SÊNIOR', footerName: 'Maria Exemplo da Silva' });
    expect(c.contact).toEqual(['São Paulo, SP', '+55 11 90000-0000', 'maria@exemplo.test', 'exemplo.test/maria', 'www.rede.exemplo.test/in/maria']);
    expect(c.sections.map((s) => s.title)).toEqual(['RESUMO PROFISSIONAL', 'COMPETÊNCIAS TÉCNICAS', 'EXPERIÊNCIA PROFISSIONAL', 'EXPERIÊNCIAS COMPLEMENTARES', 'FORMAÇÃO ACADÊMICA', 'IDIOMAS', 'CERTIFICAÇÕES']);
    expect(c.sections.slice(1)).toMatchObject([
      { groups: [{ label: 'Front-end:', items: 'React, TypeScript' }, { label: 'Back-end & APIs:', items: 'Node.js' }, { label: '', items: 'Git' }] },
      { items: [{ role: 'Desenvolvedora Front-end Sênior - Empresa Fictícia Ltda', meta: 'Mar 2021 - Atual | Remoto · Antes: Desenvolvedora Pleno (2019-2021)' }] },
      { items: [{ role: 'Monitora de Programação - Outra Fictícia SA', meta: '2018 - Dez 2019', achievements: ['Atendi 40 estudantes por semestre'] }] },
      { lines: ['Ciência da Computação - Universidade Exemplo | 2015 - 2019'] }, { line: 'Inglês: avançado | Espanhol' }, { lines: ['Certificação Fictícia - Instituto Exemplo | Mai 2022'] },
    ]);
  });
  it('uses the english titles, months and "Present", and skips empty sections', () => {
    const c = resumeContent({ ...SAMPLE_TAILORED, lang: 'en' });
    expect(c.sections.map((s) => s.title)).toEqual(['PROFESSIONAL SUMMARY', 'TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE', 'ADDITIONAL EXPERIENCE', 'EDUCATION', 'LANGUAGES', 'CERTIFICATIONS']);
    for (const part of ['Mar 2021 - Present', '2018 - Dec 2019', '| May 2022']) expect(JSON.stringify(c)).toContain(part);
    expect(resumeContent({ ...SAMPLE_TAILORED, summary: '', experiences: [], certifications: [] }).sections.map((s) => s.key)).toEqual(['skills', 'education', 'languages']);
  });
  it('renders a résumé stored before the layout fields', () => { // Review Focus 1
    const { headline: _headline, ...rest } = SAMPLE_TAILORED;
    const old = { ...rest, skills: rest.skills.map(({ group: _g, ...k }) => k), experiences: rest.experiences.map(({ section: _s, note: _n, ...e }) => e) };
    const c = resumeContent(old);
    expect(c.headline).toBe('');
    expect(c.sections.map((s) => s.key)).toEqual(['summary', 'skills', 'experience', 'education', 'languages', 'certifications']);
    expect(c.sections[1]).toMatchObject({ groups: [{ label: '', items: 'React, Node.js, TypeScript, Git' }] });
    expect(c.sections[2]).toMatchObject({ items: [{ meta: 'Mar 2021 - Atual | Remoto' }, { meta: '2018 - Dez 2019' }] });
    expect(JSON.stringify(c)).not.toContain('undefined');
  });
  it('upper-cases the raw name and keeps the footer readable', () => { // Review Focus 2
    const named = (name: string) => resumeContent({ ...SAMPLE_TAILORED, contact: { ...SAMPLE_TAILORED.contact, name } });
    expect(named('MARIA EXEMPLO DA SILVA')).toMatchObject({ name: 'MARIA EXEMPLO DA SILVA', footerName: 'Maria Exemplo da Silva' });
    expect(named('Jörg Straße')).toMatchObject({ name: 'JÖRG STRASSE', footerName: 'Jörg Straße' });
  });
});

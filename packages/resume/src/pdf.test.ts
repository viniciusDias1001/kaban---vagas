import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '@kv/shared';
import { extractResumeText } from './extract';
import { PDF_LIMITS, ResumePdfError, renderResumePdf, unsupportedPdfCharacters } from './pdf';
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

/** Carregar o pdfkit, as fontes e o pdf.js sob CPU disputada passa dos 5 s padrão. Mesmo teto do `hookTimeout` da raiz. */
const SLOW = { timeout: 60_000 };

describe('renderResumePdf', SLOW, () => {
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

  it('keeps polish, czech, turkish, vietnamese, cyrillic and greek text, in bold and in regular', async () => {
    const names = 'Łukasz Żółć Çelik Şahin Dvořák Nguyễn Thị Hồng';
    const text = await textOf({
      ...resume,
      contact: { ...resume.contact, name: names, location: 'Kraków, Gdańsk' },
      summary: `${names}. Привет мир: Київ. Αθήνα, Ελλάδα. İstanbul ğ ı ő ű ß œ € “aspas” ‘simples’ – — …`,
      experiences: [{ ...resume.experiences[0], title: 'Inżynier', company: 'Přední Şirket Việt' }],
    });
    for (const expected of [
      names, 'Kraków, Gdańsk', `${names}. Привет мир: Київ. Αθήνα, Ελλάδα. İstanbul ğ ı ő ű ß œ € “aspas” ‘simples’ – — …`, 'Inżynier - Přední Şirket Việt',
    ]) {
      // Algumas letras vietnamitas ("ị") vão para o PDF como letra + acento combinante; e o resumo ocupa duas linhas.
      expect(text.normalize('NFC').replaceAll('\n', ' '), expected).toContain(expected);
    }
  });

  it('accepts decomposed accents (NFD), as pasted from a mac', async () => {
    const text = await textOf({ ...resume, summary: 'Gestão de migração'.normalize('NFD') });
    expect(text).toContain('Gestão de migração');
  });

  it('refuses characters no embedded font can draw, naming each one, instead of dropping them', async () => {
    const japanese = { ...resume, summary: 'Fluente em 日本語 ✓ e emoji 🚀, 日本 de novo' };
    const error = await renderResumePdf(japanese).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumePdfError);
    expect(error).toMatchObject({ name: 'ResumePdfError', code: 'unsupported_characters', characters: ['日', '本', '語', '✓', '🚀'] });
    expect((error as ResumePdfError).message).toContain('"日" (U+65E5)');
    expect((error as ResumePdfError).message).toContain('"🚀" (U+1F680)');

    expect(unsupportedPdfCharacters(japanese)).toEqual(['日', '本', '語', '✓', '🚀']);
    expect(unsupportedPdfCharacters(resume)).toEqual([]);
    // Em qualquer campo, inclusive nos que saem em negrito.
    expect(unsupportedPdfCharacters({ ...resume, contact: { ...resume.contact, name: '山田 Exemplo' } })).toEqual(['山', '田']);
    expect(unsupportedPdfCharacters({ ...resume, skills: [{ id: 'skill_aaaaaaa1', name: 'عربي' }] })).toHaveLength(4);
  });

  it('writes an ascii equivalent for typographic symbols the fonts lack, and plain spaces for exotic ones', async () => {
    const text = await textOf({
      ...resume,
      contact: { ...resume.contact, location: 'Kraków → Gdańsk' },
      summary: 'Júnior ⇒ sênior; R$\u00a01.000\u202f000; conﬁança ≥ 90%; ＡＢＣ; item\u2003largo; ‣ marcador',
    });
    expect(text).toContain('Kraków -> Gdańsk');
    expect(text).toContain('Júnior => sênior; R$ 1.000 000; confiança >= 90%; ABC; item largo; - marcador');
  });

  it('strips NUL, control and invisible characters and keeps line breaks', async () => {
    const dirty = { ...resume, summary: 'linha\u0000 um\u0007\u001b[31m\r\nlinha\u202e dois\u200b\ufeff\u00ad\n\n\n\n\nlinha\ttrês\ud800' };
    const pdf = await renderResumePdf(dirty);
    const text = await textOf(dirty);
    // A linha em branco existe na página, mas a extração de texto não a devolve.
    expect(text).toContain('linha um[31m\nlinha dois\nlinha três\n');
    expect(unsupportedPdfCharacters(dirty)).toEqual([]);
    // Metadados também: o nome vai para Title e Author.
    const named = await renderResumePdf({ ...resume, contact: { ...resume.contact, name: 'Maria\u0000 Exemplo\u202e\n(ok)' } });
    expect(named.toString('latin1')).not.toContain('\u0000 Exemplo');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('renders a pathological unbroken token in bounded time, keeping every character', async () => {
    const started = Date.now();
    const text = await textOf({ ...resume, summary: 'Q'.repeat(40_000), links: [{ id: 'link_aaaaaaa1', label: '', url: `https://exemplo.test/${'a'.repeat(50)}` }] });
    // Antes o tempo era quadrático: 5,6 s para 10 mil caracteres, 25,7 s para 20 mil; 40 mil passariam de um minuto.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text.match(/Q/g)).toHaveLength(40_000);
    // Uma URL comum, que cabe na linha, segue inteira.
    expect(text).toContain(`https://exemplo.test/${'a'.repeat(50)}`);
  });

  it('refuses a resume with more text than the cap, fast', async () => {
    const started = Date.now();
    const huge = { ...resume, summary: 'palavra '.repeat(PDF_LIMITS.maxChars / 8 + 1) };
    await expect(renderResumePdf(huge)).rejects.toMatchObject({ name: 'ResumePdfError', code: 'too_long', characters: [] });
    expect(() => unsupportedPdfCharacters(huge)).toThrow(ResumePdfError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('renders the largest accepted resume in bounded time', async () => {
    const started = Date.now();
    const lines = { ...resume, summary: 'a\n\n'.repeat(30_000), experiences: [], education: [], skills: [], languages: [], certifications: [], links: [] };
    const words = { ...resume, summary: 'palavra '.repeat(PDF_LIMITS.maxChars / 8 - 100) };
    expect((await renderResumePdf(lines)).length).toBeGreaterThan(1000);
    expect((await renderResumePdf(words)).length).toBeGreaterThan(1000);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

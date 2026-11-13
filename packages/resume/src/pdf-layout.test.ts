import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '@kv/shared';
import { resumeContent } from './pdf-content';
import { blocksOf, GEOMETRY, layoutPages, PAGE, shapeBlocks, type Measure, type PageLayout, type PlacedLine } from './pdf-layout';
import { SAMPLE_TAILORED } from './testing';

const narrow: Measure = (text, _font, size) => text.length * size * 0.1; // nada quebra
const wide: Measure = (text, _font, size) => text.length * size * 0.6;   // o contato passa de uma linha
const pagesOf = (resume: TailoredResume, measure: Measure) => {
  const content = resumeContent(resume);
  return layoutPages(shapeBlocks(blocksOf(content), new Set()), content.footerName, measure);
};
const textOf = (line: PlacedLine) => line.runs.map((r) => r.text).join('');
const textLines = (page: PageLayout) => page.lines.filter((l) => l.x !== GEOMETRY.bulletX);
const ys = (page: PageLayout) => textLines(page).map((l) => Math.round(l.y * 10) / 10);

describe('pdf layout', () => {
  it('places every baseline of the sample résumé at the distances of the model', () => {
    const [page] = pagesOf(SAMPLE_TAILORED, narrow);
    expect(ys(page)).toEqual([
      66.4, 83.5, 97.1,                  // nome, título, contato
      127.2, 143.8,                      // RESUMO PROFISSIONAL e o resumo
      167.7, 184.3, 199.5, 214.7,        // COMPETÊNCIAS TÉCNICAS e três linhas de grupo
      238.6, 255.2, 268.9, 283.6, 297.7, // EXPERIÊNCIA PROFISSIONAL: cargo, período, duas realizações
      334.6, 351.2, 364.9, 379.6,        // EXPERIÊNCIAS COMPLEMENTARES
      416.5, 433.1, 457, 473.6, 497.5, 514.1, // FORMAÇÃO ACADÊMICA, IDIOMAS e CERTIFICAÇÕES, cada uma com uma linha
    ]);
    expect(page.ruleY).toBeCloseTo(105.7, 1);
  });
  it('reproduces the header of the model when the contact takes two lines', () => {
    const [page] = pagesOf(SAMPLE_TAILORED, wide);
    expect(ys(page).slice(0, 5)).toEqual([66.4, 83.5, 97.1, 108, 138.1]);
    expect(page.ruleY).toBeCloseTo(116.6, 1);
    expect(page.lines.slice(2, 4).map(textOf)).toEqual(['São Paulo, SP • +55 11 90000-0000 • maria@exemplo.test • exemplo.test/maria', 'www.rede.exemplo.test/in/maria']);
  });
  it('closes up the header when there is no headline and centres the footer', () => {
    const [page] = pagesOf({ ...SAMPLE_TAILORED, headline: '' }, narrow);
    expect(ys(page).slice(0, 3)).toEqual([66.4, 83.5, 113.6]); // nome, contato, primeira seção
    expect(page.ruleY).toBeCloseTo(92.1, 1);
    expect(page.footer.x + narrow(textOf(page.footer), '', 7) / 2).toBeCloseTo(PAGE.width / 2, 1);
  });
  it('uses the type scale of the model', () => {
    const [page] = pagesOf(SAMPLE_TAILORED, narrow);
    const style = (i: number) => { const [r] = textLines(page)[i].runs; return [r.font.split('-')[0], r.size, r.color]; };
    expect([0, 2, 4, 10].map(style)).toEqual([['bold', 20, '#1f2a44'], ['regular', 8, '#6b7280'], ['regular', 8.5, '#222222'], ['bold', 9, '#1f2a44']]); // nome, contato, corpo, cargo
    const group = page.lines.find((l) => textOf(l).startsWith('Front-end:'))!;
    expect(group.runs.map((r) => [r.text, r.font.split('-')[0], r.color])).toEqual([['Front-end: ', 'bold', '#1f2a44'], ['React, TypeScript', 'regular', '#222222']]);
    expect(page.footer.runs[0]).toMatchObject({ size: 7, color: '#6b7280' });
  });
  it('hangs the achievements: bullet at 54.1, every text line at 63.1', () => {
    const long = { ...SAMPLE_TAILORED.experiences[0], achievements: [{ sourceId: 'ach_ccccccc1', text: 'palavra '.repeat(30).trim() }, { sourceId: 'ach_ccccccc2', text: 'curta' }] };
    const [page] = pagesOf({ ...SAMPLE_TAILORED, experiences: [long] }, (t, _f, size) => t.length * size * 0.5);
    const body = page.lines.filter((l) => l.x === GEOMETRY.achievementX);
    expect(body).toHaveLength(4); // a primeira realização ocupa três linhas; a segunda, uma
    expect([body[1].y - body[0].y, body[3].y - body[2].y].map((d) => Math.round(d * 10) / 10)).toEqual([12.6, 14.1]); // dentro e entre
    const bullets = page.lines.filter((l) => l.x === GEOMETRY.bulletX);
    expect(bullets.map(textOf)).toEqual(['• ', '• ']);
    expect(bullets.map((l) => l.y)).toEqual([body[0].y, body[3].y]); // na primeira linha de cada uma
  });
  it('breaks twenty achievements across pages without orphans, with a numbered footer on every page', () => { // Review Focus 3
    const many = { ...SAMPLE_TAILORED.experiences[0], achievements: Array.from({ length: 20 }, (_, i) => ({ sourceId: 'ach_ccccccc1', text: `Realização número ${i + 1}` })) };
    for (let extra = 0; extra < 60; extra++) { // desloca o conteúdo linha a linha, para toda posição cair no pé da página
      const summary = Array.from({ length: extra + 1 }, () => 'linha').join('\n');
      const pages = pagesOf({ ...SAMPLE_TAILORED, summary, experiences: [many, many, many, many] }, narrow);
      expect(pages.length).toBeGreaterThan(1);
      pages.forEach((page, i) => {
        expect(Math.max(...page.lines.map((l) => l.y))).toBeLessThanOrEqual(PAGE.height - PAGE.margin);
        expect(textOf(page.footer)).toBe(`Maria Exemplo da Silva • ${i + 1}`);
        expect(page.footer.y).toBeCloseTo(PAGE.height - 38, 1);
        if (i > 0) expect(page.lines[0].y).toBeCloseTo(PAGE.margin + page.lines[0].runs[0].size, 1);
        if (i < pages.length - 1) expect(page.lines.at(-1)!.runs[0].size, `página ${i + 1}, ${extra} linhas a mais`).toBe(8.5); // corpo: nunca título, cargo ou período
      });
      expect(pages.flatMap((p) => p.lines).filter((l) => textOf(l) === 'Realização número 20')).toHaveLength(4);
    }
  });
});

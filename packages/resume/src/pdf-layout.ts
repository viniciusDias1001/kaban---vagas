import type { ContentSection, ResumeContent } from './pdf-content';
import { layoutLine, sanitizePdfText } from './pdf-text';

/**
 * A geometria do modelo do dono: tamanhos, cores e distâncias entre linhas de base, medidos do arquivo
 * dele. É o único lugar do código onde esses números aparecem. Aqui nada é desenhado: o documento vira
 * blocos, os blocos viram linhas posicionadas por página, e quem desenha é `pdf.ts`.
 */

export const PAGE = { width: 595.28, height: 841.89, margin: 50 } as const; // A4, em pontos
export const COLOR = { ink: '#1f2a44', muted: '#6b7280', rule: '#c9ced6', body: '#222222' } as const;
export const TYPE = {
  name:       { weight: 'bold',    size: 20,   color: COLOR.ink },   // em caixa alta
  headline:   { weight: 'bold',    size: 10.5, color: COLOR.ink },   // em caixa alta
  contact:    { weight: 'regular', size: 8,    color: COLOR.muted },
  section:    { weight: 'bold',    size: 10.5, color: COLOR.ink },   // em caixa alta
  role:       { weight: 'bold',    size: 9,    color: COLOR.ink },   // "Cargo - Empresa"
  meta:       { weight: 'regular', size: 8,    color: COLOR.muted }, // período, local e nota
  groupLabel: { weight: 'bold',    size: 8.5,  color: COLOR.ink },
  body:       { weight: 'regular', size: 8.5,  color: COLOR.body },  // corpo e realizações
  footer:     { weight: 'regular', size: 7,    color: COLOR.muted },
} as const;
/** Distâncias entre linhas de base, em pontos. */
export const GEOMETRY = {
  nameBaseline: 66.4, nameToHeadline: 17.1, headlineToContact: 13.6, contactLine: 10.9,
  ruleBelowHeader: 8.6,                              // o fio fica a 116,6 no modelo: 66,4 + 17,1 + 13,6 + 10,9 + 8,6
  ruleX1: 50, ruleX2: 545, ruleWidth: 0.5,
  headerToSection: 30.1,                             // última linha do cabeçalho até o primeiro título de seção
  sectionToFirst: 16.6, bodyLine: 13.2,
  skillGroups: 15.2, listItems: 14.7,                // entre grupos; entre itens de formação e entre certificações
  roleToMeta: 13.7, metaToAchievement: 14.7,
  achievementLine: 12.6, achievements: 14.1,         // dentro de uma realização; entre realizações
  bulletX: 54.1, achievementX: 63.1,
  experiences: 27.2,                                 // última realização até a experiência seguinte
  bodyToSection: 23.9, achievementsToSection: 36.9,  // último texto até o título da seção seguinte
  footerFromBottom: 38,
  wrapLeading: 1.3,                                  // linha quebrada de nome, título, seção, cargo e período: 1,3 x tamanho
} as const;

export type StyleName = keyof typeof TYPE;

/** Uma linha lógica do documento; quebra sozinha quando não cabe. */
export interface Block {
  segments: { text: string; style: StyleName }[];
  gapBefore: number;    // da linha de base anterior até a primeira linha deste bloco
  lineGap: number;      // entre as linhas do próprio bloco
  x: number;
  bullet?: true;        // "• " em GEOMETRY.bulletX, na primeira linha
  keepWithNext?: true;  // nunca é a última coisa de uma página
  wrap?: 'parts';       // linha de contato: segmentos pares são partes; ímpares, o separador ' • '
  ruleAfter?: number;   // fio a esta distância abaixo da última linha do bloco
}

const CONTACT_SEPARATOR = ' • ';
const BULLET = '• ';
const wrapped = (style: StyleName) => GEOMETRY.wrapLeading * TYPE[style].size;

/** Os blocos do documento, na ordem de leitura, com as distâncias das tabelas do modelo. */
export function blocksOf(content: ResumeContent): Block[] {
  const blocks: Block[] = [];
  /** Acrescenta o bloco se ele tem texto; diz se acrescentou. */
  const add = (block: Block): boolean => {
    const hasText = block.segments.some((s) => s.text.trim());
    if (hasText) blocks.push(block);
    return hasText;
  };
  const left = PAGE.margin;

  // Cabeçalho: o primeiro bloco fica na linha de base do nome; sem título, o contato ocupa o lugar dele.
  const header = (block: Omit<Block, 'gapBefore'>, gapBefore: number) =>
    add({ ...block, gapBefore: blocks.length === 0 ? GEOMETRY.nameBaseline : gapBefore });
  header({ segments: [{ text: content.name, style: 'name' }], lineGap: wrapped('name'), x: left }, GEOMETRY.nameBaseline);
  const hasHeadline = Boolean(content.headline.trim());
  header({ segments: [{ text: content.headline, style: 'headline' }], lineGap: wrapped('headline'), x: left }, GEOMETRY.nameToHeadline);
  const contact = content.contact.flatMap((part, i) => [
    ...(i > 0 ? [{ text: CONTACT_SEPARATOR, style: 'contact' as const }] : []),
    { text: part, style: 'contact' as const },
  ]);
  if (contact.length) {
    header({ segments: contact, lineGap: GEOMETRY.contactLine, x: left, wrap: 'parts' },
      hasHeadline ? GEOMETRY.headlineToContact : GEOMETRY.nameToHeadline);
  }
  if (blocks.length) blocks[blocks.length - 1].ruleAfter = GEOMETRY.ruleBelowHeader;

  let previous: ContentSection['key'] | null = null;
  for (const section of content.sections) {
    const gapBefore = previous === null ? GEOMETRY.headerToSection
      : previous === 'experience' || previous === 'additional' ? GEOMETRY.achievementsToSection
      : GEOMETRY.bodyToSection;
    previous = section.key;
    add({ segments: [{ text: section.title, style: 'section' }], gapBefore, lineGap: wrapped('section'), x: left, keepWithNext: true });
    const body = (text: string, gap: number) =>
      add({ segments: [{ text, style: 'body' }], gapBefore: gap, lineGap: GEOMETRY.bodyLine, x: left });

    switch (section.key) {
      case 'summary':
        body(section.text, GEOMETRY.sectionToFirst);
        break;
      case 'languages':
        body(section.line, GEOMETRY.sectionToFirst);
        break;
      case 'education':
      case 'certifications':
        section.lines.forEach((line, i) => body(line, i === 0 ? GEOMETRY.sectionToFirst : GEOMETRY.listItems));
        break;
      case 'skills':
        section.groups.forEach((group, i) => add({
          segments: [...(group.label ? [{ text: `${group.label} `, style: 'groupLabel' as const }] : []), { text: group.items, style: 'body' }],
          gapBefore: i === 0 ? GEOMETRY.sectionToFirst : GEOMETRY.skillGroups,
          lineGap: GEOMETRY.bodyLine,
          x: left,
        }));
        break;
      case 'experience':
      case 'additional':
        section.items.forEach((item, i) => {
          // Sem cargo ou sem período, o que vem depois herda a distância do que faltou.
          let gap: number = i === 0 ? GEOMETRY.sectionToFirst : GEOMETRY.experiences;
          const role = add({ segments: [{ text: item.role, style: 'role' }], gapBefore: gap, lineGap: wrapped('role'), x: left, keepWithNext: true });
          if (role) gap = GEOMETRY.roleToMeta;
          const meta = add({ segments: [{ text: item.meta, style: 'meta' }], gapBefore: gap, lineGap: wrapped('meta'), x: left, keepWithNext: true });
          if (role || meta) gap = GEOMETRY.metaToAchievement;
          for (const text of item.achievements) {
            if (add({ segments: [{ text, style: 'body' }], gapBefore: gap, lineGap: GEOMETRY.achievementLine, x: GEOMETRY.achievementX, bullet: true })) {
              gap = GEOMETRY.achievements;
            }
          }
        });
        break;
    }
  }
  return blocks;
}

export interface PlacedRun { text: string; font: string; size: number; color: string }
export interface PlacedLine { x: number; y: number; runs: PlacedRun[] } // y = linha de base, a partir do topo
export interface PageLayout { lines: PlacedLine[]; ruleY: number | null; footer: PlacedLine }
/** Uma entrada de `lines` por linha forçada ("\n"); no contato, uma por segmento. */
export type ShapedBlock = Omit<Block, 'segments'> & { lines: PlacedRun[][] };

/** Um texto saneado em trechos de uma fonte só, uma lista por linha forçada. */
function shapeText(text: string, style: StyleName, missing: Set<string>): PlacedRun[][] {
  const { weight, size, color } = TYPE[style];
  return sanitizePdfText(text).split('\n').map((line) => layoutLine(line, weight, missing).map((run) => ({ ...run, size, color })));
}

/** Saneia cada texto e o divide em trechos de uma fonte só; o que não tem glifo vai para `missing`. Não mede nada. */
export function shapeBlocks(blocks: Block[], missing: Set<string>): ShapedBlock[] {
  return blocks.map(({ segments, ...block }) => {
    if (block.wrap === 'parts') {
      // Uma parte do contato é sempre uma linha só.
      return { ...block, lines: segments.map((s) => shapeText(s.text.replace(/[\r\n]+/g, ' '), s.style, missing).flat()) };
    }
    const lines: PlacedRun[][] = [[]];
    for (const segment of segments) {
      shapeText(segment.text, segment.style, missing).forEach((runs, i) => {
        if (i > 0) lines.push([]);
        lines[lines.length - 1].push(...runs);
      });
    }
    return { ...block, lines };
  });
}

export type Measure = (text: string, font: string, size: number) => number;

const sameStyle = (a: PlacedRun, b: PlacedRun) => a.font === b.font && a.size === b.size && a.color === b.color;

/** Junta trechos vizinhos de mesma fonte, tamanho e cor e tira o espaço do fim da linha. */
function finishLine(runs: PlacedRun[]): PlacedRun[] {
  const merged: PlacedRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, run)) merged[merged.length - 1] = { ...last, text: last.text + run.text };
    else merged.push({ ...run });
  }
  while (merged.length) {
    const last = merged[merged.length - 1];
    const text = last.text.replace(/ +$/, '');
    if (text) { merged[merged.length - 1] = { ...last, text }; break; }
    merged.pop();
  }
  return merged;
}

/**
 * Quebra uma linha forçada em linhas de até `width`. Quebra depois de um espaço; uma palavra mais larga
 * que a linha quebra entre os seus trechos (os pedaços de sequência longa de `layoutLine`), e o pedaço
 * que ainda assim não cabe fica sozinho na linha. Devolve ao menos uma linha (vazia, se não há texto).
 */
function wrapLine(runs: PlacedRun[], width: number, measure: Measure): PlacedRun[][] {
  // Palavras: pedaços até um espaço (inclusive). Uma palavra pode atravessar trechos.
  const words: PlacedRun[][] = [[]];
  for (const run of runs) {
    for (const chunk of run.text.match(/[^ ]+ *| +/g) ?? []) {
      words[words.length - 1].push({ ...run, text: chunk });
      if (chunk.endsWith(' ')) words.push([]);
    }
  }
  if (!words[words.length - 1].length) words.pop();

  const widthOf = (pieces: PlacedRun[], trimEnd: boolean) => pieces.reduce((sum, p, i) => {
    const text = trimEnd && i === pieces.length - 1 ? p.text.replace(/ +$/, '') : p.text;
    return sum + (text ? measure(text, p.font, p.size) : 0);
  }, 0);

  const lines: PlacedRun[][] = [];
  let line: PlacedRun[] = [];
  let used = 0;
  const place = (unit: PlacedRun[]) => {
    if (line.length && used + widthOf(unit, true) > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(...unit);
    used += widthOf(unit, false);
  };
  for (const word of words) {
    const fitsAlone = widthOf(word, true) <= width;
    if (fitsAlone || word.length === 1) place(word);
    else for (const piece of word) place([piece]);
  }
  lines.push(line);
  return lines.map(finishLine);
}

/** Linha de contato: cada parte inteira; a que não cabe abre a linha seguinte, sem o separador antes dela. */
function wrapParts(segments: PlacedRun[][], width: number, measure: Measure): PlacedRun[][] {
  const widthOf = (runs: PlacedRun[]) => runs.reduce((sum, r) => sum + measure(r.text, r.font, r.size), 0);
  const lines: PlacedRun[][] = [];
  let line: PlacedRun[] = [];
  let used = 0;
  for (let i = 0; i < segments.length; i += 2) {
    const part = segments[i];
    if (!part.length) continue;
    const separator = line.length && i > 0 ? segments[i - 1] : [];
    const partWidth = widthOf(part);
    if (line.length && used + widthOf(separator) + partWidth <= width) {
      line.push(...separator, ...part);
      used += widthOf(separator) + partWidth;
      continue;
    }
    if (line.length) lines.push(line);
    if (partWidth <= width) {
      line = [...part];
      used = partWidth;
    } else {
      lines.push(...wrapLine(part, width, measure));
      line = [];
      used = 0;
    }
  }
  if (line.length) lines.push(line);
  return lines.map(finishLine);
}

/** As linhas de um bloco depois da quebra. Linha vazia no meio ocupa uma linha; no fim, nada. */
function linesOf(block: ShapedBlock, measure: Measure): PlacedRun[][] {
  const width = PAGE.width - PAGE.margin - block.x;
  const lines = block.wrap === 'parts' ? wrapParts(block.lines, width, measure) : block.lines.flatMap((runs) => wrapLine(runs, width, measure));
  while (lines.length && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/** As páginas do documento: cada linha com a sua linha de base, o fio do cabeçalho e o rodapé numerado. */
export function layoutPages(blocks: ShapedBlock[], footerName: string, measure: Measure): PageLayout[] {
  const bottom = PAGE.height - PAGE.margin;
  const bullet = shapeText(BULLET, 'body', new Set())[0];
  const wrappedBlocks = blocks.map((block) => ({ block, lines: linesOf(block, measure) }));

  const pages: { lines: PlacedLine[]; ruleY: number | null }[] = [{ lines: [], ruleY: null }];
  let page = pages[0];
  let y = 0; // linha de base anterior
  const newPage = () => {
    page = { lines: [], ruleY: null };
    pages.push(page);
  };
  const topOf = (runs: PlacedRun[]) => PAGE.margin + (runs[0]?.size ?? 0);

  wrappedBlocks.forEach(({ block, lines }, index) => {
    if (!lines.length) return;
    if (block.keepWithNext && page.lines.length) {
      // O bloco marcado e os seguintes, até a primeira linha do primeiro bloco sem a marca, ficam juntos.
      let end = y;
      for (let k = index; k < wrappedBlocks.length; k++) {
        const next = wrappedBlocks[k];
        if (!next.lines.length) continue;
        end += next.block.gapBefore;
        if (!next.block.keepWithNext) break;
        end += (next.lines.length - 1) * next.block.lineGap;
      }
      if (end > bottom) {
        newPage();
        y = Number.NaN; // a primeira linha vai para o topo
      }
    }
    lines.forEach((runs, i) => {
      let at = Number.isNaN(y) ? Number.POSITIVE_INFINITY : y + (i === 0 ? block.gapBefore : block.lineGap);
      if (!runs.length) {
        // Linha vazia: ocupa espaço só se cabe na página; senão a quebra de página toma o lugar dela.
        if (at <= bottom) y = at;
        return;
      }
      if (at > bottom) {
        if (page.lines.length) newPage();
        at = topOf(runs);
      }
      y = at;
      if (i === 0 && block.bullet) page.lines.push({ x: GEOMETRY.bulletX, y, runs: bullet });
      page.lines.push({ x: block.x, y, runs });
    });
    if (block.ruleAfter !== undefined && !Number.isNaN(y)) page.ruleY = y + block.ruleAfter;
  });

  const name = footerName.replace(/[\r\n]+/g, ' ').trim();
  return pages.map((p, i) => {
    const runs = finishLine(shapeText(name ? `${name} • ${i + 1}` : `${i + 1}`, 'footer', new Set())[0]);
    const width = runs.reduce((sum, r) => sum + measure(r.text, r.font, r.size), 0);
    return { ...p, footer: { x: PAGE.width / 2 - width / 2, y: PAGE.height - GEOMETRY.footerFromBottom, runs } };
  });
}

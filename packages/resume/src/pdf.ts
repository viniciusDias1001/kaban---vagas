import PDFDocument from 'pdfkit';
import type { TailoredResume } from '@kv/shared';
import { resumeContent } from './pdf-content';
import { blocksOf, COLOR, GEOMETRY, layoutPages, shapeBlocks, type Measure, type PlacedLine, type ShapedBlock } from './pdf-layout';
import { allFaces, layoutLine, MAX_TOKEN_CHARS, sanitizePdfText } from './pdf-text';

/** Limites do renderizador, independentes da validação feita antes dele. */
export const PDF_LIMITS = {
  /** Soma de todos os textos do currículo. Um currículo de dez páginas tem uns 40 mil caracteres. */
  maxChars: 100_000,
  /** Sequência sem espaços acima disto é desenhada em pedaços (não é recusada nem alterada). */
  maxTokenChars: MAX_TOKEN_CHARS,
} as const;

export type ResumePdfErrorCode = 'unsupported_characters' | 'too_long';

/**
 * O currículo não pode virar PDF do jeito que está. `message` é para o usuário (pt-BR).
 * - `unsupported_characters`: há caracteres sem glifo nas fontes embutidas; `characters` lista cada um.
 *   Gerar o PDF mesmo assim faria esses caracteres sumirem do texto sem aviso.
 * - `too_long`: o texto passa de `PDF_LIMITS.maxChars`.
 */
export class ResumePdfError extends Error {
  readonly code: ResumePdfErrorCode;
  /** Caracteres sem glifo, sem repetição, na ordem em que aparecem. Vazio para `too_long`. */
  readonly characters: string[];

  constructor(code: ResumePdfErrorCode, message: string, characters: string[] = []) {
    super(message);
    this.name = 'ResumePdfError';
    this.code = code;
    this.characters = characters;
  }
}

/**
 * Confere o currículo inteiro antes de desenhar qualquer coisa: tamanho total, saneamento de cada texto
 * e cobertura de glifos, inclusive do nome do rodapé. Devolve os blocos prontos para a paginação e os
 * caracteres que nenhuma fonte embutida desenha.
 */
function prepare(resume: TailoredResume): { title: string; author: string; blocks: ShapedBlock[]; footerName: string; missing: string[] } {
  const content = resumeContent(resume);
  const blocks = blocksOf(content);
  const total = blocks.reduce((sum, block) => sum + block.segments.reduce((n, segment) => n + segment.text.length, 0), 0);
  if (total > PDF_LIMITS.maxChars) {
    throw new ResumePdfError(
      'too_long',
      `O currículo tem texto demais para virar PDF (${total} caracteres; o limite é ${PDF_LIMITS.maxChars}). Encurte o resumo e as realizações.`,
    );
  }
  const missing = new Set<string>();
  const shaped = shapeBlocks(blocks, missing);
  for (const line of sanitizePdfText(content.footerName).split('\n')) layoutLine(line, 'regular', missing);
  const oneLine = (value: string) => {
    const runs = sanitizePdfText(value).split('\n').map((line) => layoutLine(line, 'regular', new Set()));
    return runs.map((line) => line.map((run) => run.text).join('')).join(' ');
  };
  const title = `${resume.contact.name} - ${resume.lang === 'en' ? 'Resume' : 'Currículo'}`;
  return { title: oneLine(title), author: oneLine(resume.contact.name), blocks: shaped, footerName: content.footerName, missing: [...missing] };
}

const describe = (char: string) => `"${char}" (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;

function unsupported(characters: string[]): ResumePdfError {
  const shown = characters.slice(0, 20).map(describe).join(', ');
  const more = characters.length > 20 ? ` e mais ${characters.length - 20}` : '';
  return new ResumePdfError(
    'unsupported_characters',
    `O PDF não pode ser gerado: a fonte do documento não tem ${characters.length === 1 ? 'o caractere' : 'os caracteres'} ${shown}${more}. ` +
      'Edite o currículo e troque ou remova esses caracteres.',
    characters,
  );
}

/**
 * Caracteres do currículo que nenhuma fonte embutida desenha (vazio = pode gerar o PDF). Serve para avisar
 * o usuário ao salvar, antes de ele pedir o PDF. Lança `ResumePdfError` (`too_long`) se o texto passa do teto.
 */
export function unsupportedPdfCharacters(resume: TailoredResume): string[] {
  return prepare(resume).missing;
}

/**
 * PDF do currículo adaptado, no modelo do dono: A4, uma coluna, Noto Serif. Cabeçalho com o nome e o título
 * profissional em caixa alta e a linha de contato, um fio fino embaixo dele, títulos de seção em caixa alta,
 * competências por grupo com o rótulo em negrito, realizações com marcador e recuo deslocado, e em toda
 * página um rodapé centralizado com o nome e o número da página. Título de seção, cargo e período nunca
 * ficam sozinhos no pé da página. Texto real e selecionável na ordem de leitura, sem tabelas nem imagens,
 * pensado para sistemas de triagem (ATS). Recebe o conteúdo já revisado.
 *
 * Fontes: Noto Serif latino, latino estendido, vietnamita, cirílico e grego, trocadas por trecho conforme
 * o texto pede. Nenhum caractere some em silêncio: se algum não tem glifo (CJK, árabe, emoji, "✓"...), a
 * promessa rejeita com `ResumePdfError` (`unsupported_characters`) dizendo quais. Também rejeita
 * (`too_long`) acima de `PDF_LIMITS.maxChars`. Caracteres de controle e invisíveis são descartados.
 */
export function renderResumePdf(resume: TailoredResume): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { title, author, blocks, footerName, missing } = prepare(resume);
    if (missing.length > 0) throw unsupported(missing);

    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: author } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const face of allFaces()) doc.registerFont(face.name, face.path);

    const widths = new Map<string, number>();
    const measure: Measure = (text, font, size) => {
      const key = `${font}\u0000${size}\u0000${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        width = doc.font(font).fontSize(size).widthOfString(text);
        widths.set(key, width);
      }
      return width;
    };
    // Cada trecho no seu ponto exato; `lineBreak: false` impede o pdfkit de quebrar linha ou abrir página.
    const draw = (line: PlacedLine) => {
      let x = line.x;
      for (const run of line.runs) {
        doc.font(run.font).fontSize(run.size).fillColor(run.color).text(run.text, x, line.y, { lineBreak: false, baseline: 'alphabetic' });
        x += measure(run.text, run.font, run.size);
      }
    };

    layoutPages(blocks, footerName, measure).forEach((page, i) => {
      if (i > 0) doc.addPage();
      for (const line of page.lines) draw(line);
      if (page.ruleY !== null) {
        doc.moveTo(GEOMETRY.ruleX1, page.ruleY).lineTo(GEOMETRY.ruleX2, page.ruleY)
          .lineWidth(GEOMETRY.ruleWidth).strokeColor(COLOR.rule).stroke();
      }
      draw(page.footer);
    });
    doc.end();
  });
}

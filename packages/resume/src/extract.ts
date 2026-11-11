import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { LIMITS } from '@kv/shared';
import { DocxTooLargeError, rebuildDocx } from './docx-zip';
import type { ResumeKind } from './sniff';

export type ExtractFailure = 'no_text' | 'too_many_pages' | 'too_large' | 'invalid' | 'timeout';

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: ExtractFailure; message: string };

/** Limites para arquivo hostil. Tempo e memória são impostos por `extractInWorker` (extract-runner.ts). */
export const EXTRACT_LIMITS = {
  maxPages: 30,
  /**
   * Soma dos bytes REALMENTE descompactados das partes de texto do DOCX (bomba de descompressão). Os
   * tamanhos declarados no ZIP não são consultados: a contagem é feita enquanto se descompacta.
   */
  maxDocxBytes: 20 * 1024 * 1024,
  /** Texto bruto lido de um PDF antes de parar: bem mais do que os `LIMITS.resumeText` que seguem adiante. */
  maxPdfTextChars: 500_000,
  /** Menos texto que isso = PDF só com imagem (currículo escaneado). */
  minTextChars: 50,
  /** Tempo de leitura, contado a partir do aviso de "pronta" da worker (a partida não entra na conta). */
  timeoutMs: 15_000,
  /** Tempo para a worker subir e carregar os parsers. Sob CPU disputada isso passa de 10 s. */
  startupTimeoutMs: 60_000,
  /** Heap do V8 da worker. Não cobre ArrayBuffers: para eles existe `maxRssGrowthMb`. */
  maxMemoryMb: 256,
  /** Quanto o RSS do processo pode crescer enquanto uma extração roda antes de a worker ser terminada. */
  maxRssGrowthMb: 384,
} as const;

const fail = (reason: ExtractFailure, message: string): ExtractResult => ({ ok: false, reason, message });

function clean(text: string): string {
  return text
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, LIMITS.resumeText);
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
interface TextChunk {
  items: { str?: string; hasEOL?: boolean }[];
}

/**
 * Texto das páginas, uma de cada vez e em fluxo: a leitura para assim que `maxPdfTextChars` é alcançado,
 * em vez de montar na memória todo o texto de um arquivo feito para inchar.
 */
async function pdfText(pdf: PdfDocument): Promise<string> {
  const pages: string[] = [];
  let total = 0;
  for (let n = 1; n <= pdf.numPages && total <= EXTRACT_LIMITS.maxPdfTextChars; n++) {
    const page = await pdf.getPage(n);
    const reader = (page.streamTextContent() as ReadableStream<TextChunk>).getReader();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of value.items) if (item.str != null) text += item.str + (item.hasEOL ? '\n' : '');
        if (total + text.length > EXTRACT_LIMITS.maxPdfTextChars) {
          // O pdf.js exige um Error como motivo do cancelamento.
          await reader.cancel(new Error('limite de texto alcançado'));
          break;
        }
      }
    } finally {
      page.cleanup();
    }
    total += text.length;
    pages.push(text);
  }
  return pages.join('\n');
}

async function fromPdf(buf: Uint8Array): Promise<ExtractResult> {
  let pdf: PdfDocument;
  try {
    // Cópia: o pdf.js toma posse do buffer que recebe.
    // `verbosity: 0`: só erros. Arquivo hostil não enche o log de avisos do pdf.js.
    pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  } catch {
    return fail('invalid', 'O arquivo não é um PDF válido ou está protegido por senha.');
  }
  try {
    if (pdf.numPages > EXTRACT_LIMITS.maxPages) {
      return fail('too_many_pages', `O PDF tem ${pdf.numPages} páginas; o limite é ${EXTRACT_LIMITS.maxPages}.`);
    }
    const cleaned = clean(await pdfText(pdf));
    if (cleaned.length < EXTRACT_LIMITS.minTextChars) {
      return fail(
        'no_text',
        'Este PDF não tem texto extraível (parece ser uma imagem escaneada). Exporte o currículo como PDF com texto ou envie um DOCX.',
      );
    }
    return { ok: true, text: cleaned };
  } finally {
    // Solta os buffers do documento: fora da worker (testes) o processo segue vivo depois desta chamada.
    void pdf.loadingTask.destroy().catch(() => {});
  }
}

async function fromDocx(buf: Uint8Array): Promise<ExtractResult> {
  let safe: Uint8Array;
  try {
    // O mammoth nunca vê o arquivo enviado: recebe um ZIP refeito aqui, já descompactado e dentro do teto.
    safe = rebuildDocx(buf, EXTRACT_LIMITS.maxDocxBytes);
  } catch (e) {
    if (e instanceof DocxTooLargeError) return fail('too_large', 'O DOCX é grande demais depois de descompactado.');
    return fail('invalid', 'O arquivo não é um DOCX válido.');
  }
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer: Buffer.from(safe.buffer, safe.byteOffset, safe.byteLength) }));
  } catch {
    return fail('invalid', 'O arquivo não é um DOCX válido.');
  }
  const cleaned = clean(value);
  if (cleaned.length < EXTRACT_LIMITS.minTextChars) return fail('no_text', 'Este DOCX não tem texto.');
  return { ok: true, text: cleaned };
}

/**
 * Texto de um currículo PDF ou DOCX. Nunca lança: todo problema vira `{ ok: false }` com mensagem para
 * o usuário. Em produção é chamada dentro de uma worker thread (`extractInWorker`), nunca direto.
 */
export async function extractResumeText(buf: Uint8Array, kind: ResumeKind): Promise<ExtractResult> {
  try {
    return kind === 'pdf' ? await fromPdf(buf) : await fromDocx(buf);
  } catch (e) {
    return fail('invalid', `Não foi possível ler o arquivo (${e instanceof Error ? e.message : String(e)}).`);
  }
}

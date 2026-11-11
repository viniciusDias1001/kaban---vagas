import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { LIMITS } from '@kv/shared';
import { zipEntries, type ResumeKind } from './sniff';

export type ExtractFailure = 'no_text' | 'too_many_pages' | 'too_large' | 'invalid' | 'timeout';

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: ExtractFailure; message: string };

/** Limites para arquivo hostil. Tempo e memória são impostos por `extractInWorker` (extract-runner.ts). */
export const EXTRACT_LIMITS = {
  maxPages: 30,
  /** Soma dos tamanhos descompactados das entradas do DOCX (bomba de descompressão). */
  maxDocxBytes: 20 * 1024 * 1024,
  /** Menos texto que isso = PDF só com imagem (currículo escaneado). */
  minTextChars: 50,
  timeoutMs: 15_000,
  maxMemoryMb: 256,
} as const;

const fail = (reason: ExtractFailure, message: string): ExtractResult => ({ ok: false, reason, message });

function clean(text: string): string {
  return text
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, LIMITS.resumeText);
}

async function fromPdf(buf: Uint8Array): Promise<ExtractResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Cópia: o pdf.js toma posse do buffer que recebe.
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch {
    return fail('invalid', 'O arquivo não é um PDF válido ou está protegido por senha.');
  }
  if (pdf.numPages > EXTRACT_LIMITS.maxPages) {
    return fail('too_many_pages', `O PDF tem ${pdf.numPages} páginas; o limite é ${EXTRACT_LIMITS.maxPages}.`);
  }
  const { text } = await extractText(pdf, { mergePages: true });
  const cleaned = clean(text);
  if (cleaned.length < EXTRACT_LIMITS.minTextChars) {
    return fail(
      'no_text',
      'Este PDF não tem texto extraível (parece ser uma imagem escaneada). Exporte o currículo como PDF com texto ou envie um DOCX.',
    );
  }
  return { ok: true, text: cleaned };
}

async function fromDocx(buf: Uint8Array): Promise<ExtractResult> {
  let total: number;
  try {
    total = zipEntries(buf).reduce((sum, e) => sum + e.size, 0);
  } catch {
    return fail('invalid', 'O arquivo não é um DOCX válido.');
  }
  if (total > EXTRACT_LIMITS.maxDocxBytes) return fail('too_large', 'O DOCX é grande demais depois de descompactado.');
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) }));
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

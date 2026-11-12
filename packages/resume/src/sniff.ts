import { unzipSync } from 'fflate';

export type ResumeKind = 'pdf' | 'docx';

export const RESUME_MIME: Record<ResumeKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const startsWith = (buf: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => buf[at + i] === b);

/**
 * Nomes e tamanhos descompactados DECLARADOS das entradas de um ZIP, lendo só o índice (nada é
 * descompactado). Serve para reconhecer o tipo do arquivo. O tamanho é o que o arquivo diz de si mesmo,
 * então não vale como limite: quem impõe o teto de descompressão é `rebuildDocx` (docx-zip.ts).
 */
export function zipEntries(buf: Uint8Array): { name: string; size: number }[] {
  const entries: { name: string; size: number }[] = [];
  unzipSync(buf, {
    filter: (file) => {
      entries.push({ name: file.name, size: file.originalSize });
      return false;
    },
  });
  return entries;
}

/**
 * Tipo do arquivo pelo CONTEÚDO. A extensão e o Content-Type enviados pelo cliente não são consultados.
 * PDF: assinatura "%PDF-" no primeiro KiB. DOCX: um ZIP que contém `word/document.xml` e
 * `[Content_Types].xml`. Qualquer outra coisa (inclusive .doc antigo, .odt, ZIP comum) devolve null.
 */
export function sniffResume(buf: Uint8Array): ResumeKind | null {
  const head = Math.min(buf.length - 5, 1024);
  for (let i = 0; i <= head; i++) if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const names = zipEntries(buf).map((e) => e.name);
      if (names.includes('word/document.xml') && names.includes('[Content_Types].xml')) return 'docx';
    } catch {
      return null; // ZIP corrompido
    }
  }
  return null;
}

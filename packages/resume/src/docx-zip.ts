import { Inflate, zipSync } from 'fflate';

/** As partes do DOCX passariam do teto depois de descompactadas (bomba de descompressão). */
export class DocxTooLargeError extends Error {}
/** O ZIP está corrompido ou usa algo que não lemos (criptografia, ZIP64, método de compressão exótico). */
export class DocxInvalidError extends Error {}

/** Só as partes de texto interessam: XML e relações. Imagens, fontes e anexos nunca são descompactados. */
const WANTED = /\.(xml|rels)$/i;
/** Um DOCX de verdade tem dezenas de entradas. */
const MAX_ENTRIES = 5_000;
/**
 * Bytes compactados entregues ao inflater por vez. O DEFLATE expande no máximo ~1032:1, então cada passo
 * produz no máximo ~4 MiB antes de o contador ser conferido.
 */
const STEP = 4 * 1024;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Índice central do ZIP. Os tamanhos descompactados declarados nem são lidos: quem os escreve é o arquivo. */
function centralDirectory(buf: Uint8Array): CentralEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 0xffff); i >= min; i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxInvalidError('fim do índice não encontrado');
  const count = u16(buf, eocd + 10);
  let at = u32(buf, eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new DocxInvalidError('ZIP64 não é aceito');
  if (count > MAX_ENTRIES) throw new DocxInvalidError('entradas demais');
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || u32(buf, at) !== 0x02014b50) throw new DocxInvalidError('índice corrompido');
    const nameLength = u16(buf, at + 28);
    const next = at + 46 + nameLength + u16(buf, at + 30) + u16(buf, at + 32);
    if (next > buf.length) throw new DocxInvalidError('índice corrompido');
    entries.push({
      name: decoder.decode(buf.subarray(at + 46, at + 46 + nameLength)),
      method: u16(buf, at + 10),
      compressedSize: u32(buf, at + 20),
      localOffset: u32(buf, at + 42),
    });
    if (u16(buf, at + 8) & 1) throw new DocxInvalidError('arquivo criptografado');
    at = next;
  }
  return entries;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Descompacta uma entrada em passos pequenos; `take` conta cada bloco produzido e lança ao passar do teto. */
function inflateEntry(buf: Uint8Array, entry: CentralEntry, take: (bytes: number) => void): Uint8Array {
  const local = entry.localOffset;
  if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) throw new DocxInvalidError('entrada corrompida');
  const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
  const end = start + entry.compressedSize;
  if (entry.compressedSize === 0xffffffff || end > buf.length) throw new DocxInvalidError('entrada corrompida');
  const raw = buf.subarray(start, end);
  if (entry.method === 0) {
    take(raw.length);
    return raw;
  }
  if (entry.method !== 8) throw new DocxInvalidError('método de compressão não aceito');

  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  const inflate = new Inflate((chunk, final) => {
    take(chunk.length);
    chunks.push(chunk);
    length += chunk.length;
    finished ||= final;
  });
  try {
    for (let i = 0; i < raw.length && !finished; i += STEP) inflate.push(raw.subarray(i, i + STEP), i + STEP >= raw.length);
  } catch (e) {
    if (e instanceof DocxTooLargeError) throw e;
    throw new DocxInvalidError('dados compactados corrompidos');
  }
  if (!finished) throw new DocxInvalidError('dados compactados truncados');
  return concat(chunks, length);
}

/**
 * Reconstrói em memória um DOCX mínimo só com as partes de texto, cada uma descompactada AQUI, em fluxo,
 * com um contador de bytes que aborta em `maxBytes`. O parser (mammoth) recebe o resultado, com entradas
 * sem compressão: ele nunca infla nada do arquivo original e não depende de tamanho declarado nenhum.
 *
 * Lança `DocxTooLargeError` ao passar do teto e `DocxInvalidError` para ZIP corrompido.
 */
export function rebuildDocx(buf: Uint8Array, maxBytes: number): Uint8Array {
  let total = 0;
  const take = (bytes: number) => {
    total += bytes;
    if (total > maxBytes) throw new DocxTooLargeError('partes grandes demais depois de descompactadas');
  };
  const parts: Record<string, Uint8Array> = {};
  for (const entry of centralDirectory(buf)) {
    // Nome repetido: vale a última entrada, como nos leitores de ZIP que seguem o índice central.
    if (WANTED.test(entry.name)) parts[entry.name] = inflateEntry(buf, entry, take);
  }
  return zipSync(parts, { level: 0 });
}

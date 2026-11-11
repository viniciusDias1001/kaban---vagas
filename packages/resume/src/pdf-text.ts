/// <reference path="./fontkit.d.ts" />
import { createRequire } from 'node:module';
import { openSync } from 'fontkit';

const require = createRequire(import.meta.url);

export type Weight = 'regular' | 'bold';

/**
 * Noto Sans (OFL-1.1) em subconjuntos, na ordem de preferência. O latino cobre o português e a pontuação
 * tipográfica; os demais entram só quando o texto pede (nomes poloneses, tchecos, turcos, vietnamitas,
 * cirílico, grego). O pdfkit embute só as fontes usadas, e de cada uma só os glifos usados.
 * Sem glifo em nenhuma: CJK, árabe, hebraico, devanágari, emoji e símbolos como "✓".
 */
const SUBSETS = ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext'] as const;
const WEIGHTS: Record<Weight, number> = { regular: 400, bold: 700 };

export interface Face {
  /** Nome com que a fonte é registrada no documento. */
  name: string;
  path: string;
  has(codePoint: number): boolean;
}

const faces = new Map<string, Face>();

/** Fonte de um subconjunto, carregada (só a tabela de caracteres) na primeira vez em que é consultada. */
function face(subset: number, weight: Weight): Face {
  const name = `${weight}-${SUBSETS[subset]}`;
  let found = faces.get(name);
  if (!found) {
    const path = require.resolve(`@fontsource/noto-sans/files/noto-sans-${SUBSETS[subset]}-${WEIGHTS[weight]}-normal.woff`);
    const font = openSync(path);
    const characters = new Set(font.characterSet);
    const clean = new Map<number, boolean>();
    found = {
      name,
      path,
      has: (codePoint) => {
        if (!characters.has(codePoint)) return false;
        let ok = clean.get(codePoint);
        if (ok === undefined) {
          // Alguns caracteres compostos ("ị" no subconjunto vietnamita) saem como dois glifos, e o segundo
          // não corresponde a caractere nenhum: no PDF ele viraria lixo na camada de texto. Só vale o
          // caractere que a fonte desenha com um glifo que sabe dizer de onde veio.
          const { glyphs } = font.layout(String.fromCodePoint(codePoint));
          ok = glyphs.length === 1 && glyphs[0].codePoints.length > 0;
          clean.set(codePoint, ok);
        }
        return ok;
      },
    };
    faces.set(name, found);
  }
  return found;
}

/** Todas as fontes, para registrar no documento. Registrar não lê o arquivo: isso só acontece no uso. */
export function allFaces(): { name: string; path: string }[] {
  return (Object.keys(WEIGHTS) as Weight[]).flatMap((weight) =>
    SUBSETS.map((subset) => ({
      name: `${weight}-${subset}`,
      path: require.resolve(`@fontsource/noto-sans/files/noto-sans-${subset}-${WEIGHTS[weight]}-normal.woff`),
    })),
  );
}

/**
 * A fonte que desenha o caractere: sempre a primeira da ordem que o tem. O espaço e a pontuação saem
 * assim da fonte latina, e não da que estiver em uso (o espaço de alguns subconjuntos volta como
 * caractere de controle na extração do texto).
 */
function faceFor(codePoint: number, weight: Weight): Face | null {
  for (let i = 0; i < SUBSETS.length; i++) {
    const candidate = face(i, weight);
    if (candidate.has(codePoint)) return candidate;
  }
  return null;
}

const covered = (char: string) => faceFor(char.codePointAt(0)!, 'regular') !== null;

/**
 * Equivalentes em ASCII para sinais tipográficos, usados SÓ quando nenhuma fonte tem o glifo (hoje as
 * setas, alguns marcadores de lista e sinais de comparação; aspas curvas, travessões e "•" têm glifo).
 * Só entra aqui o que tem equivalente seguro: "✓" e "★" não têm, e por isso são recusados com erro.
 */
const ASCII_FALLBACK: Record<string, string> = {
  '→': '->', '⟶': '->', '➔': '->', '➜': '->', '➝': '->', '➞': '->', '➡': '->', '⇒': '=>', '⟹': '=>',
  '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '⇔': '<=>',
  '•': '-', '‣': '-', '◦': '-', '⁃': '-', '∙': '-', '▪': '-', '▫': '-', '■': '-', '□': '-', '●': '-', '○': '-', '◆': '-', '◇': '-',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '…': '...', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '⁄': '/', '∕': '/',
};

/** Substituto desenhável de um caractere sem glifo, ou null: a tabela, a forma decomposta ou a de compatibilidade (ﬁ -> fi, Ａ -> A). */
function fallbackOf(char: string): string | null {
  const ascii = ASCII_FALLBACK[char];
  if (ascii !== undefined) return ascii;
  // Letra + acento combinante, quando a forma composta não tem um glifo limpo (ver `face`).
  const decomposed = char.normalize('NFD');
  if (decomposed !== char && Array.from(decomposed).every(covered)) return decomposed;
  const compatible = char.normalize('NFKC');
  if (compatible !== char) {
    const mapped = Array.from(compatible, (c) => (covered(c) ? c : ASCII_FALLBACK[c]));
    if (mapped.every((c) => c !== undefined)) return mapped.join('');
  }
  return null;
}

// Controles C0 (menos \n) e C1, DEL, hífen opcional, marcas invisíveis de formatação e de direção
// (zero-width, LRM/RLM, overrides bidi), BOM, seletores de variação e surrogates soltos.
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]|[\ud800-\udfff]/gu;

/**
 * Deixa um texto livre (vindo do modelo ou do usuário) seguro para desenhar: forma NFC, quebras de linha
 * normalizadas (no máximo uma linha em branco seguida), todo tipo de espaço vira espaço comum, NUL e
 * caracteres de controle ou invisíveis somem, e sinais sem glifo ganham o equivalente em ASCII.
 * O que continuar sem glifo fica no texto: `layoutLine` é quem o acusa.
 */
export function sanitizePdfText(text: string): string {
  const base = text
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, '\n')
    .replace(/[\t\p{Zs}]/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/g, '\n\n');
  let out = '';
  for (const char of base) out += char === '\n' || covered(char) ? char : (fallbackOf(char) ?? char);
  return out;
}

export interface Run {
  font: string;
  text: string;
}

/** Sequência sem espaço mais longa que isto é desenhada em pedaços (uma linha de corpo tem ~95 caracteres). */
export const MAX_TOKEN_CHARS = 80;
const PIECE_CHARS = 40;

/**
 * Divide uma linha (sem \n, já saneada) em trechos de uma fonte só. Dois motivos para trocar de trecho:
 * a fonte em uso não tem o caractere seguinte, ou uma sequência sem espaços passou de `MAX_TOKEN_CHARS`:
 * o quebrador de linha do pdfkit mede a palavra inteira a cada linha (tempo quadrático), então ela é
 * entregue em pedaços de `PIECE_CHARS`, que quebram de linha entre si sem inserir nada no texto.
 * Caracteres sem glifo em nenhuma fonte ficam fora dos trechos e entram em `missing`.
 */
export function layoutLine(line: string, weight: Weight, missing: Set<string>): Run[] {
  const chars = Array.from(line);
  const cuts = new Set<number>();
  for (let start = 0; start < chars.length; ) {
    if (chars[start] === ' ') {
      start++;
      continue;
    }
    let end = start;
    while (end < chars.length && chars[end] !== ' ') end++;
    if (end - start > MAX_TOKEN_CHARS) for (let at = start + PIECE_CHARS; at < end; at += PIECE_CHARS) cuts.add(at);
    start = end;
  }

  const runs: Run[] = [];
  let current: Face | null = null;
  let text = '';
  const flush = () => {
    if (text) runs.push({ font: current!.name, text });
    text = '';
  };
  chars.forEach((char, i) => {
    const next = faceFor(char.codePointAt(0)!, weight);
    if (!next) return void missing.add(char);
    if (next !== current || cuts.has(i)) flush();
    current = next;
    text += char;
  });
  flush();
  return runs;
}

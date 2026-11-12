/** O fontkit não publica tipos. Só o que `pdf-text.ts` usa: a tabela de caracteres e os glifos de um arquivo de fonte. */
declare module 'fontkit' {
  export interface Font {
    /** Todos os code points que a fonte sabe desenhar. */
    characterSet: number[];
    /** Glifos que desenham o texto; `codePoints` diz de que caracteres cada um veio. */
    layout(text: string): { glyphs: { codePoints: number[] }[] };
  }
  export function openSync(path: string): Font;
}

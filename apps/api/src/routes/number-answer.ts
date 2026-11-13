/** Uma só regra para a resposta numérica, nas rotas do banco de respostas e nas das perguntas paradas. */
export const NUMBER_ANSWER_MESSAGE = 'Use só dígitos, com no máximo duas casas decimais e sem separador de milhar (ex.: 20000 ou 1234,56).';

/**
 * O número escrito pelo dono, com ponto decimal, ou `null` se não serve: dígitos com sinal de menos opcional e, no máximo,
 * duas casas decimais (`.` ou `,`). 20.000 é vinte mil no Brasil e vinte fora dele: não dá para adivinhar, então `.` ou `,`
 * seguido de três dígitos é recusado.
 */
export function normalizeNumberAnswer(text: string): string | null {
  const t = text.trim();
  return /^-?\d+([.,]\d{1,2})?$/.test(t) ? t.replace(',', '.') : null;
}

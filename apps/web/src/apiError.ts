/** Erro de uma chamada à API, com o status HTTP (0 = a requisição nem chegou a ter resposta). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const NETWORK_ERROR = 'Não foi possível falar com a API. Confira se ela está no ar e tente de novo.';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A mensagem que a API manda em `{ error, message }`, se o corpo for mesmo esse JSON. */
function apiMessage(bodyText: string): string | null {
  try {
    const body: unknown = JSON.parse(bodyText);
    const message = (body as { message?: unknown } | null)?.message;
    return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
  } catch {
    return null; // HTML de um proxy, texto puro, corpo vazio
  }
}

/**
 * Texto para mostrar ao usuário quando a API responde com erro. O corpo é lido com cuidado: um 502 em
 * HTML vindo de um proxy, ou um corpo vazio, não pode virar um segundo erro (de JSON) no lugar do primeiro.
 */
export function errorMessage(status: number, bodyText: string): string {
  const message = apiMessage(bodyText);
  if (status === 403) {
    return (
      'A API recusou a alteração porque esta página foi aberta por um endereço diferente do dela. ' +
      'Abra o quadro pelo endereço da própria API (ou pelo Vite, em desenvolvimento) e tente de novo.'
    );
  }
  if (status >= 500) {
    // "erro interno" não ajuda ninguém; e o corpo de um proxy não é para o usuário ler.
    return `A API falhou ao responder (erro ${status}). Tente de novo em instantes.`;
  }
  if (message) return capitalize(message);
  if (status === 404) return 'Não encontrado: o item pode ter sido apagado.';
  if (status === 413) return 'O conteúdo enviado é grande demais.';
  return `A API recusou a requisição (erro ${status}).`;
}

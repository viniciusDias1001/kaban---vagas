import { AiError, InputTooLargeError, ProfileTranslationError } from '@kv/ai';
import type { ViolationCode } from '@kv/shared';

/** Páginas de texto cheio que cabem em `maxChars` (uma página cheia tem uns 3 000 caracteres). */
const pagesOf = (maxChars: number) => Math.max(1, Math.floor(maxChars / 3_000));

/** O que cada código do verificador quer dizer para o usuário. Frases fixas: nada do que o modelo escreveu entra aqui. */
const CODE_LABELS: Record<ViolationCode, string> = {
  unknown_id: 'referências a itens que não existem no perfil',
  duplicate_id: 'itens repetidos',
  new_number: 'números que não estão no perfil',
  foreign_company: 'o nome da empresa da vaga',
  novel_term: 'termos que não estão no perfil',
  unrelated_text: 'realizações sem relação com as originais',
  limit: 'textos fora dos limites de tamanho',
};

/**
 * O currículo adaptado foi bloqueado pelo verificador de não invenção. Tem `kind` `refused`, que a fila
 * NÃO repete: a nova tentativa que vale a pena (a corretiva, com os códigos de volta) já foi feita dentro
 * da própria tarefa, e repetir a mesma chamada às cegas só cobra de novo. `message` é fixa por código.
 */
export class DraftBlockedError extends AiError {
  override name = 'DraftBlockedError';
  constructor(readonly codes: readonly ViolationCode[]) {
    const what = [...new Set(codes)].map((c) => CODE_LABELS[c]).join('; ');
    super(
      'refused',
      `A IA propôs um currículo com informações que não estão no seu perfil${what ? ` (${what})` : ''} e o resultado foi descartado. ` +
        'Confira se o perfil tem tudo o que você quer destacar, edite-o se faltar algo, e peça a adaptação de novo.',
    );
  }
}

/** Teto do que vai para `ai_tasks.error` quando a mensagem é fixa; as demais continuam limitadas a 2 000. */
export const FIXED_MESSAGE_MAX = 400;

/**
 * O texto que fica em `ai_tasks.error` (e, daí, na resposta da API e na tela). Erros tipados que carregam
 * texto controlado pelo modelo ou pelo arquivo do usuário viram uma frase curta e fixa; o detalhe
 * (violações, termos) fica fora de qualquer resposta.
 */
export function taskErrorMessage(error: unknown): string {
  if (error instanceof DraftBlockedError) return error.message;
  if (error instanceof ProfileTranslationError) {
    return 'A tradução do perfil mudou fatos do original (números, nomes ou termos técnicos) e foi descartada. Tente traduzir de novo ou edite o perfil por conta própria.';
  }
  if (error instanceof InputTooLargeError) {
    return error.what === 'resume'
      ? `O texto do currículo é longo demais para a IA ler de uma vez (o limite é de cerca de ${pagesOf(error.maxChars)} páginas). Envie uma versão mais curta.`
      : 'O perfil é grande demais para ser traduzido de uma vez. Reduza o perfil e tente de novo.';
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

import type { JobAnalysis } from '@kv/shared';

/** O INSERT/UPDATE falhou porque a vaga foi apagada no meio da tarefa (chave estrangeira, SQLSTATE 23503)? */
export function isForeignKeyViolation(error: unknown): boolean {
  let cause: { code?: unknown; cause?: unknown } | undefined = error as typeof cause;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause as typeof cause) if (cause.code === '23503') return true;
  return false;
}

/** Palavras-chave da análise da camada 2 (as que a vaga pede), para o verificador da camada 3. */
export const keywordsOf = (ai: { tier2State: 'ok' | 'error' | null; analysis: JobAnalysis | null } | undefined): string[] =>
  ai?.tier2State === 'ok' && ai.analysis ? [...ai.analysis.keywordsMissing, ...ai.analysis.keywordsPresent] : [];

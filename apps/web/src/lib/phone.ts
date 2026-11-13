import { PHONE_ALERT_LIMITS, TELEGRAM_TOKEN_PATTERN } from '@kv/shared/client';

/** O que há de errado no token colado (as mesmas regras da API), ou null. O texto nunca repete o token. */
export function phoneTokenProblem(raw: string): string | null {
  const token = raw.trim();
  if (token === '') return 'Cole o token que o BotFather mostrou.';
  if (token.length < PHONE_ALERT_LIMITS.tokenMin) return 'O token parece curto demais.';
  if (token.length > PHONE_ALERT_LIMITS.tokenMax) return 'O token é longo demais.';
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) return 'O token não tem espaços nem acentos. Copie de novo do BotFather.';
  return null;
}

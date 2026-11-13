import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_REFRESH_KEYS, EMAIL_KEYS, EMAIL_REFRESH_KEYS, alertsQuery, jobEmailsQuery, mailAccountQuery, mailMessagesQuery,
} from './useEmail';
import { JOBS_KEY } from './useMoveJob';

describe('e-mail queries', () => {
  it('leave their errors to the screen that shows them inline, so no toast repeats them on every refetch', () => {
    // Settings > E-mail relê a conta a cada 60 s e o sino relê os alertas a cada 15 s: com a API fora, o aviso flutuante
    // voltaria a cada releitura, por cima do erro que a própria tela já mostra.
    for (const options of [mailAccountQuery(), alertsQuery(), jobEmailsQuery(5), mailMessagesQuery({})]) {
      expect(options.meta).toEqual({ inlineError: true });
    }
    expect(alertsQuery().queryKey).toEqual(EMAIL_KEYS.alerts);
    expect(jobEmailsQuery(5).queryKey).toEqual(EMAIL_KEYS.job(5));
  });
});

describe('what a mail action refreshes', () => {
  it('rereads the Painel numbers along with the alerts, the conversations, the board and the job', () => {
    expect(EMAIL_REFRESH_KEYS).toContainEqual(['dashboard']);
    expect(EMAIL_REFRESH_KEYS).toContainEqual(EMAIL_KEYS.alerts);
    expect(EMAIL_REFRESH_KEYS).toContainEqual(JOBS_KEY);
    expect(EMAIL_REFRESH_KEYS).toContainEqual(['job']);
    expect(EMAIL_REFRESH_KEYS).toContainEqual(['stats']);
  });

  it('rereads the Painel, the open job and the stats when the mailbox is disconnected', () => {
    for (const key of [['dashboard'], ['job'], ['stats'], EMAIL_KEYS.account, EMAIL_KEYS.alerts, EMAIL_KEYS.ignored, JOBS_KEY]) {
      expect(DISCONNECT_REFRESH_KEYS).toContainEqual(key);
    }
  });
});

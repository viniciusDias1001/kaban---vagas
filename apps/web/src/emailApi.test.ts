import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiError';
import * as email from './emailApi';

const reply = (status: number, body: string | null = null) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const JSON_HEADERS = { 'content-type': 'application/json' };

afterEach(() => vi.unstubAllGlobals());

describe('emailApi', () => {
  it('reads the account and connects with a PUT that carries the address and password', async () => {
    let fetchMock = reply(200, JSON.stringify({ connected: false }));
    await expect(email.getMailAccount()).resolves.toEqual({ connected: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/email/account', expect.anything());
    fetchMock = reply(200, JSON.stringify({ connected: true }));
    await email.connectMailbox({ address: 'maria@example.com', password: 'abcd efgh ijkl mnop' });
    expect(fetchMock).toHaveBeenCalledWith('/api/email/account', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ address: 'maria@example.com', password: 'abcd efgh ijkl mnop' }), headers: JSON_HEADERS,
    }));
  });

  it('always sends the messages parameter on disconnect, and takes the 204 as a success', async () => {
    const fetchMock = reply(204);
    await expect(email.disconnectMailbox('keep')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/email/account?messages=keep', expect.objectContaining({ method: 'DELETE' }));
    reply(204);
    await email.disconnectMailbox('delete');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/api/email/account?messages=delete');
  });

  it('builds the message list query from the filter', async () => {
    let fetchMock = reply(200, '[]');
    await email.listMailMessages({});
    expect(fetchMock).toHaveBeenCalledWith('/api/email/messages', expect.anything());
    fetchMock = reply(200, '[]');
    await email.listMailMessages({ kind: 'oferta', unmatched: true, since: 5 });
    expect(fetchMock).toHaveBeenCalledWith('/api/email/messages?kind=oferta&unmatched=1&since=5', expect.anything());
    fetchMock = reply(200, '[]');
    await email.listMailMessages({ unmatched: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/email/messages', expect.anything());
  });

  it.each([
    ['getJobEmails', () => email.getJobEmails(3), '/api/jobs/3/emails', undefined, undefined],
    ['linkMessage', () => email.linkMessage(4, 3), '/api/email/messages/4/link', 'POST', { jobId: 3 }],
    ['unlinkMessage', () => email.unlinkMessage(4), '/api/email/messages/4/unlink', 'POST', undefined],
    ['undoMailMove', () => email.undoMailMove(4), '/api/email/messages/4/undo-move', 'POST', undefined],
    ['listIgnored', () => email.listIgnored(), '/api/email/ignored', undefined, undefined],
    ['promoteIgnored', () => email.promoteIgnored(6), '/api/email/ignored/6/promote', 'POST', undefined],
    ['editReply', () => email.editReply(7, 'Olá'), '/api/email/replies/7', 'PATCH', { body: 'Olá' }],
    ['approveReply', () => email.approveReply(7, 'Olá\n\nMaria'), '/api/email/replies/7/approve', 'POST', { body: 'Olá\n\nMaria' }],
    ['discardReply', () => email.discardReply(7), '/api/email/replies/7/discard', 'POST', undefined],
    ['listAlerts', () => email.listAlerts(), '/api/alerts', undefined, undefined],
    ['dismissAlert', () => email.dismissAlert(8), '/api/alerts/8/dismiss', 'POST', undefined],
    ['answerMoveAlert', () => email.answerMoveAlert(8, true), '/api/alerts/8/move', 'POST', { accept: true }],
    ['retryAlert', () => email.retryAlert(8), '/api/alerts/8/retry', 'POST', undefined],
    ['classifyAnyway', () => email.classifyAnyway(8), '/api/alerts/8/classify-anyway', 'POST', undefined],
  ])('%s calls the right method and path', async (_name, call, path, method, body) => {
    const fetchMock = reply(200, JSON.stringify({ ok: true }));
    await call();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(fetchMock.mock.calls[0]![0]).toBe(path);
    expect(init.method).toBe(method);
    expect(init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  });

  it('returns the body the routes answer with', async () => {
    reply(200, JSON.stringify({ alerts: [] }));
    await expect(email.listAlerts()).resolves.toEqual({ alerts: [] });
    reply(200, JSON.stringify({ moved: true }));
    await expect(email.answerMoveAlert(1, true)).resolves.toEqual({ moved: true });
    reply(200, JSON.stringify({ released: 4 }));
    await expect(email.classifyAnyway(1)).resolves.toEqual({ released: 4 });
  });

  it('shows the Portuguese message the API sends for the known codes, whatever the status', async () => {
    const cases: [number, string, string][] = [
      [409, 'email_unavailable', 'só funciona com o app em endereço local'],
      [409, 'no_app_secret', 'defina o APP_SECRET'],
      [422, 'mail_auth', 'o Gmail recusou a senha'],
      [502, 'mail_unreachable', 'Não foi possível falar com o Gmail agora.'],
      [429, 'rate_limited', 'Aguarde 12 s para testar a conexão de novo.'],
      [422, 'draft_has_gaps', 'Preencha as partes entre [[ ]] antes de aprovar.'],
      [409, 'not_a_draft', 'Só um rascunho pode ser editado.'],
      [409, 'wrong_state', 'Esta resposta não pode mais ser aprovada ou descartada.'],
      [409, 'wrong_kind', 'Esta ação não vale para este alerta.'],
      [409, 'alert_closed', 'Este alerta já foi resolvido ou dispensado.'],
      [409, 'cannot_undo', 'Este movimento não pode mais ser desfeito.'],
      [409, 'reply_changed', 'O texto desta resposta mudou. Confira o texto atual antes de enviar.'],
    ];
    for (const [status, error, message] of cases) {
      reply(status, JSON.stringify({ error, message }));
      const e = await email.approveReply(1, 'Texto.').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(status);
      expect((e as ApiError).message).toBe(message.charAt(0).toUpperCase() + message.slice(1));
    }
  });

  it('falls back to the generic messages for other errors and for no answer', async () => {
    reply(502, '<html>bad gateway</html>');
    await expect(email.listAlerts()).rejects.toMatchObject({ status: 502, message: 'A API falhou ao responder (erro 502). Tente de novo em instantes.' });
    reply(404, JSON.stringify({ error: 'not_found', message: 'alerta não encontrado' }));
    await expect(email.dismissAlert(1)).rejects.toMatchObject({ status: 404, message: 'Alerta não encontrado' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(email.listAlerts()).rejects.toMatchObject({ status: 0 });
  });
});

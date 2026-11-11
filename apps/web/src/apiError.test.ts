import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from './apiError';

describe('errorMessage', () => {
  it("shows the API's validation message for a 400", () => {
    const body = JSON.stringify({ error: 'validation', message: 'sources: fonte desconhecida: "x". Fontes disponíveis: gupy' });
    expect(errorMessage(400, body)).toBe('Sources: fonte desconhecida: "x". Fontes disponíveis: gupy');
  });
  it('explains a 403 from the Origin guard in plain words', () => {
    const text = errorMessage(403, JSON.stringify({ error: 'forbidden', message: 'requisição de outra origem recusada' }));
    expect(text).toContain('endereço diferente');
    expect(text).not.toContain('forbidden');
  });
  it('does not throw or leak markup for a non-JSON 5xx from a proxy', () => {
    const text = errorMessage(502, '<html><body><h1>502 Bad Gateway</h1></body></html>');
    expect(text).toBe('A API falhou ao responder (erro 502). Tente de novo em instantes.');
  });
  it('hides the generic body of a JSON 500', () => {
    expect(errorMessage(500, JSON.stringify({ error: 'internal', message: 'erro interno' }))).toContain('erro 500');
  });
  it('falls back by status when the body is empty, not an object, or has no message', () => {
    expect(errorMessage(404, '')).toBe('Não encontrado: o item pode ter sido apagado.');
    expect(errorMessage(400, 'null')).toBe('A API recusou a requisição (erro 400).');
    expect(errorMessage(400, '{"message":42}')).toBe('A API recusou a requisição (erro 400).');
    expect(errorMessage(413, 'Payload Too Large')).toBe('O conteúdo enviado é grande demais.');
  });
  it('uses the API message for a 404 when there is one', () => {
    expect(errorMessage(404, JSON.stringify({ error: 'not_found', message: 'vaga não encontrada' }))).toBe('Vaga não encontrada');
  });
});

describe('ApiError', () => {
  it('carries the status', () => {
    const err = new ApiError(400, 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.message).toBe('x');
  });
});

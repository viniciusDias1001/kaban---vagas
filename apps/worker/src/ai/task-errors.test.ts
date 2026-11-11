import { describe, expect, it } from 'vitest';
import { AiError, InputTooLargeError, isRetryable } from '@kv/ai';
import { VIOLATION_CODES } from '@kv/shared';
import { DraftBlockedError, FIXED_MESSAGE_MAX, UNKNOWN_TASK_ERROR, describeForLog, isUnknownError, taskErrorMessage } from './task-errors';

describe('DraftBlockedError', () => {
  it('has its own kind, different from a model refusal, and is never retried by the queue', () => {
    const error = new DraftBlockedError(['new_number', 'novel_term']);
    expect(error).toBeInstanceOf(AiError);
    expect(error.kind).toBe('draft_blocked');
    expect(error.kind).not.toBe('refused');
    expect(isRetryable(error)).toBe(false);
    expect(isRetryable('draft_blocked')).toBe(false);
  });

  it('says what was found with a fixed phrase per code, within the fixed-message limit', () => {
    const error = new DraftBlockedError(['new_number', 'novel_term', 'new_number']);
    expect(error.message).toMatch(/não estão no seu perfil \(números que não estão no perfil; termos que não estão no perfil\)/);
    expect(error.message.length).toBeLessThanOrEqual(FIXED_MESSAGE_MAX);
    expect(taskErrorMessage(error)).toBe(error.message);
    // Todos os códigos de uma vez: continua uma frase curta, sem nada além dos rótulos fixos.
    expect(new DraftBlockedError(VIOLATION_CODES).message.length).toBeLessThan(500);
  });
});

describe('taskErrorMessage', () => {
  it('keeps the message of a typed error', () => {
    expect(taskErrorMessage(new AiError('transient', 'falha de rede'))).toBe('falha de rede');
    expect(taskErrorMessage(new AiError('config', 'não há perfil em inglês: envie o currículo'))).toMatch(/inglês/);
    expect(taskErrorMessage(new AiError('other', 'x'.repeat(5_000)))).toHaveLength(2_000);
    expect(taskErrorMessage(new InputTooLargeError('resume', 30_000, 18_000))).toMatch(/cerca de 6 páginas/);
  });

  it('answers one fixed sentence for anything that is not an AiError', () => {
    const sql = new Error('Failed query: select "extracted_text" from "resumes" where "lang" = $1\nparams: pt-BR');
    for (const unknown of [sql, new TypeError("Cannot read properties of undefined (reading 'id')"), 'texto', null, undefined, { code: 'X' }]) {
      expect(isUnknownError(unknown)).toBe(true);
      expect(taskErrorMessage(unknown)).toBe(UNKNOWN_TASK_ERROR);
    }
    expect(isUnknownError(new AiError('other', 'x'))).toBe(false);
    expect(UNKNOWN_TASK_ERROR.length).toBeLessThanOrEqual(FIXED_MESSAGE_MAX);
  });
});

describe('describeForLog', () => {
  it('writes name, code and message of the error and of its causes on one line', () => {
    const error = Object.assign(new Error('Failed query: update "ai_tasks" set "status" = $1\nparams: ok'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
    });
    const line = describeForLog(error);
    expect(line).toBe('Error: Failed query: update "ai_tasks" set "status" = $1 <- Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:5433');
    expect(line).not.toContain('\n');
  });

  it('drops the query parameters, anything shaped like an api key, and long text', () => {
    const error = new Error(`Failed query: insert into "resumes" values ($1)\nparams: Maria Exemplo da Silva, sk-test-chave-ficticia-1234`);
    expect(describeForLog(error)).not.toMatch(/Maria|sk-test/);
    expect(describeForLog(new Error('o provedor ecoou sk-test-chave-ficticia-1234 no erro'))).toContain('[chave removida]');
    expect(describeForLog(new Error('y'.repeat(2_000))).length).toBeLessThan(400);
  });

  it('accepts things that are not errors', () => {
    expect(describeForLog('texto, não Error')).toBe('texto, não Error');
    expect(describeForLog(undefined)).toBe('erro sem detalhe');
  });
});

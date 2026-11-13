import { describe, expect, it } from 'vitest';
import { phoneTokenProblem } from './phone';

describe('phoneTokenProblem', () => {
  it('accepts a BotFather token, trimmed, and says what is wrong otherwise without repeating it', () => {
    expect(phoneTokenProblem('  123456:ABC-fake-bot-token\n')).toBeNull();
    expect(phoneTokenProblem('')).toMatch(/Cole o token/);
    expect(phoneTokenProblem('123:AB')).toMatch(/curto/);
    expect(phoneTokenProblem('x'.repeat(101))).toMatch(/longo/);
    const spaced = phoneTokenProblem('123456:ABC fake token');
    expect(spaced).toMatch(/espaços/);
    expect(spaced).not.toContain('123456');
  });
});

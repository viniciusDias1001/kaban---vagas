import { describe, expect, it } from 'vitest';
import { ageLabel } from './age';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

describe('ageLabel', () => {
  it('mostra "data n/d" quando não há data', () => {
    expect(ageLabel(null, NOW)).toBe('data n/d');
  });

  it('mostra "hoje" para menos de um dia', () => {
    expect(ageLabel(NOW, NOW)).toBe('hoje');
    expect(ageLabel(NOW - 23 * HOUR, NOW)).toBe('hoje');
  });

  it('mostra "hoje" para datas no futuro (LinkedIn só informa o dia: o fim do dia UTC pode estar à frente)', () => {
    expect(ageLabel(NOW + 1, NOW)).toBe('hoje');
    expect(ageLabel(NOW + 11 * HOUR, NOW)).toBe('hoje');
    expect(ageLabel(NOW + 3 * DAY, NOW)).toBe('hoje');
  });

  it('usa o singular para 1 dia e o plural a partir de 2', () => {
    expect(ageLabel(NOW - DAY, NOW)).toBe('há 1 dia');
    expect(ageLabel(NOW - 2 * DAY - HOUR, NOW)).toBe('há 2 dias');
    expect(ageLabel(NOW - 30 * DAY, NOW)).toBe('há 30 dias');
  });
});

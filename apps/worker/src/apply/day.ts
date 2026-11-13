import { dayStartMs } from '@kv/ai';

export const DAY_MS = 86_400_000;

/** A próxima meia-noite do fuso: o começo do dia seguinte ao que contém `now` (certo também nos dias de horário de verão). */
export function nextMidnight(now: number, timeZone: string): number {
  return dayStartMs(dayStartMs(now, timeZone) + DAY_MS + 3 * 3_600_000, timeZone);
}

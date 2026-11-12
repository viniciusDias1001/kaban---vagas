const DAY_MS = 86_400_000;

/** Diferença, em ms, entre a hora local de `timeZone` e o UTC no instante `ms` (São Paulo: -3 h). */
function offsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(ms / 1000) * 1000;
}

/**
 * Início (meia-noite local) do dia que contém `now`, no fuso do orçamento. É a ÚNICA definição de "dia"
 * do limite de gasto: o worker (para pausar e retomar) e a API (para mostrar o gasto de hoje) usam esta
 * função com o mesmo `budgetTimeZone` da configuração.
 */
export function dayStartMs(now: number, timeZone: string): number {
  const offset = offsetMs(now, timeZone);
  const start = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  // Dia com mudança de horário de verão: o deslocamento à meia-noite pode ser outro.
  const atStart = offsetMs(start, timeZone);
  return atStart === offset ? start : Math.floor((now + offset) / DAY_MS) * DAY_MS - atStart;
}

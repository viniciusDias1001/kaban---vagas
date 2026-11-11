const DAY = 86_400_000;

/**
 * Idade da vaga em texto. Datas no futuro valem "hoje": o LinkedIn informa só o dia, e esse dia é
 * normalizado para o fim dele (UTC), que pode estar algumas horas à frente do relógio.
 */
export function ageLabel(postedAt: number | null, now: number = Date.now()): string {
  if (postedAt === null) return 'data n/d';
  if (postedAt >= now) return 'hoje';
  const days = Math.floor((now - postedAt) / DAY);
  if (days < 1) return 'hoje';
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

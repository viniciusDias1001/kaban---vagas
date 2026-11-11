import type { JobAiSummaryDto } from '@kv/shared/client';
import { languageBadge, scoreTone, type ScoreTone } from '../lib/ai';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Tooltip } from './ui/tooltip';

// A faixa muda cor E preenchimento; o número está sempre escrito, então nada depende só da cor.
const TONE: Record<ScoreTone, string> = {
  high: 'bg-ok/16 text-ok ring-ok/30',
  mid: 'bg-warn/14 text-warn ring-warn/25',
  low: 'bg-surface-3 text-muted ring-white/8',
};

export const STALE_SCORE = 'Nota calculada com uma versão anterior do seu perfil';
const LANGUAGE_NAMES: Record<string, string> = { PT: 'português', EN: 'inglês', ES: 'espanhol', FR: 'francês', DE: 'alemão', IT: 'italiano' };

/** Nota de aderência (0 a 100). O texto do elemento é só o número; a justificativa vai na dica. */
export function ScoreBadge({ ai, size = 'sm', className }: { ai: JobAiSummaryDto; size?: 'sm' | 'lg'; className?: string }) {
  if (ai.score === null) return null;
  // Justificativa vem da IA: é só texto (dica e `title`), nunca marcação.
  const hint = [ai.stale ? `${STALE_SCORE}.` : null, ai.reason].filter(Boolean).join(' ');
  const badge = (
    <span
      data-testid="job-score" data-stale={ai.stale || undefined}
      aria-label={`Aderência: ${ai.score} de 100`} title={hint || undefined}
      className={cn(
        'inline-grid shrink-0 place-items-center font-semibold tabular-nums ring-1 ring-inset',
        size === 'sm' ? 'h-[1.375rem] min-w-7 rounded-md px-1 text-xs' : 'h-9 min-w-11 rounded-xl px-2 text-lg',
        TONE[scoreTone(ai.score)],
        ai.stale && 'border border-dashed border-current opacity-60 ring-0',
        className,
      )}
    >
      {ai.score}
    </span>
  );
  return hint ? <Tooltip label={hint} side="top">{badge}</Tooltip> : badge;
}

/** Idioma original da vaga ("PT", "EN"); nada quando ainda não foi detectado. */
export function LanguageBadge({ language, size, className }: { language: string | null | undefined; size?: 'sm' | 'md'; className?: string }) {
  const code = languageBadge(language);
  if (!code) return null;
  return (
    <Badge tone="outline" size={size} data-testid="job-language" aria-label={`Idioma da vaga: ${LANGUAGE_NAMES[code] ?? code}`} className={className}>
      {code}
    </Badge>
  );
}

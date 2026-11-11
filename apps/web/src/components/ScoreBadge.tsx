import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { JobAiListItemDto } from '@kv/shared/client';
import { aiApi } from '../aiApi';
import { languageBadge, scoreTone, type ScoreTone } from '../lib/ai';
import { cn } from '../lib/utils';
import { AI_KEYS } from '../useAi';
import { Badge } from './ui/badge';
import { Tooltip } from './ui/tooltip';

// A faixa muda cor E preenchimento; o número está sempre escrito, então nada depende só da cor.
const TONE: Record<ScoreTone, string> = {
  high: 'bg-ok/16 text-ok ring-ok/30',
  mid: 'bg-warn/14 text-warn ring-warn/25',
  low: 'bg-surface-3 text-muted ring-white/8',
};

export const STALE_SCORE = 'Nota calculada com uma versão anterior do seu perfil';
const LOADING_REASON = 'Carregando a justificativa…';
const NO_REASON = 'Sem justificativa registrada.';
const LANGUAGE_NAMES: Record<string, string> = { PT: 'português', EN: 'inglês', ES: 'espanhol', FR: 'francês', DE: 'alemão', IT: 'italiano' };

/**
 * A justificativa da nota para quem não a recebeu pronta. A lista do quadro (GET /jobs/ai, relida a cada 15 s) não
 * traz o texto: ele é buscado na rota da vaga (GET /jobs/:id/ai) só quando o ponteiro ou o foco chega à nota, e fica
 * no cache do React Query (a mesma chave do painel da vaga). `undefined` = ainda não pedida ou carregando.
 */
function useLazyReason(jobId: number, score: number | null, enabled: boolean) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<string | null | undefined>(undefined);
  const asked = useRef(false);
  // Nota nova (a vaga foi reavaliada): a justificativa guardada não vale mais.
  useEffect(() => {
    asked.current = false;
    setReason(undefined);
  }, [jobId, score]);
  function load() {
    if (!enabled || asked.current) return;
    asked.current = true;
    qc.fetchQuery({ queryKey: AI_KEYS.job(jobId), queryFn: () => aiApi.jobAi(jobId), staleTime: 60_000 })
      .then((detail) => setReason(detail.summary?.reason?.trim() || null))
      // Falhou: a dica fica sem o texto e o próximo ponteiro tenta de novo.
      .catch(() => {
        asked.current = false;
      });
  }
  return { reason, load };
}

/**
 * Nota de aderência (0 a 100). O texto do elemento é só o número; a justificativa vai na dica. Quem já tem a
 * justificativa (o painel da vaga) passa `ai.reason`; no card do quadro ela não vem e é buscada sob demanda.
 */
export function ScoreBadge({ ai, size = 'sm', className }: {
  ai: JobAiListItemDto & { reason?: string | null }; size?: 'sm' | 'lg'; className?: string;
}) {
  const lazy = ai.reason === undefined;
  const fetched = useLazyReason(ai.jobId, ai.score, lazy);
  if (ai.score === null) return null;
  const reason = lazy ? fetched.reason : ai.reason;
  // Justificativa vem da IA: é só texto (dica e `title`), nunca marcação.
  const known = [ai.stale ? `${STALE_SCORE}.` : null, reason].filter(Boolean).join(' ');
  // No modo sob demanda a dica existe desde o início (senão ela só apareceria no segundo ponteiro): enquanto a
  // justificativa não chega, diz que está carregando; se a vaga não tem justificativa, diz isso.
  const hint = !lazy || reason ? known : reason === null ? known || NO_REASON : [known, LOADING_REASON].filter(Boolean).join(' ');
  const badge = (
    <span
      data-testid="job-score" data-stale={ai.stale || undefined}
      aria-label={`Aderência: ${ai.score} de 100`} title={known || undefined}
      onPointerEnter={lazy ? fetched.load : undefined} onFocus={lazy ? fetched.load : undefined}
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

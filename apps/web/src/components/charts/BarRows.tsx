import { motion } from 'motion/react';
import { springSoft } from '../../lib/motion';
import { cn } from '../../lib/utils';

export interface BarSeries {
  /** Nome da série, escrito ao lado de cada barra (a cor nunca é a única pista). */
  name: string;
  /** Cor da barra e da amostra da legenda (`bg-…`). */
  fill: string;
}

export interface BarRow {
  key: string;
  label: string;
  /** Linha pequena abaixo do rótulo (ex.: o tipo da trava). */
  hint?: string;
  /** Uma barra por série, na ordem de `series`: largura de 0 a 1 e o texto do número. */
  bars: { share: number; text: string }[];
}

/** Largura mínima visível de uma barra que não é zero, para "1 de 40" não sumir. */
const MIN_VISIBLE = 0.012;

export function Bar({ share, fill, delay = 0 }: { share: number; fill: string; delay?: number }) {
  const width = share <= 0 ? 0 : Math.max(MIN_VISIBLE, Math.min(1, share));
  return (
    <div aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3/80">
      <motion.div
        className={cn('h-full rounded-full', fill)}
        initial={{ width: 0 }} animate={{ width: `${width * 100}%` }}
        transition={{ ...springSoft, delay }}
      />
    </div>
  );
}

/** Legenda das séries: amostra de cor e nome. */
export function BarLegend({ series }: { series: BarSeries[] }) {
  return (
    <ul aria-hidden className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
      {series.map((s) => (
        <li key={s.name} className="flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-[3px]', s.fill)} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Linhas de barras horizontais: rótulo à esquerda e, por série, o nome, a barra e o número. Com uma série só,
 * o nome não se repete em cada linha (o título do bloco o diz). É uma imagem para leitores de tela, com todos
 * os números no `aria-label`.
 */
export function BarRows({ rows, series, label, testId, stacked = false }: {
  rows: BarRow[];
  series: BarSeries[];
  /** Nome do gráfico, no começo do `aria-label`. */
  label: string;
  testId?: string;
  /** Rótulo sempre acima das barras (rótulos longos, blocos estreitos). */
  stacked?: boolean;
}) {
  const single = series.length === 1;
  const aria = `${label}: ${rows
    .map((r) => `${r.label}${r.hint ? ` (${r.hint})` : ''}, ${r.bars.map((b, i) => (single ? b.text : `${series[i]?.name} ${b.text}`)).join(', ')}`)
    .join('; ')}.`;
  return (
    <ul role="img" aria-label={aria} data-testid={testId} className="divide-y divide-line/70">
      {rows.map((r, ri) => (
        <li
          key={r.key}
          className={cn(
            'grid gap-x-5 gap-y-2 py-3 first:pt-0 last:pb-0',
            !stacked && 'sm:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)] sm:items-center',
          )}
        >
          <div className="min-w-0">
            <p className="break-words text-[13px] font-medium leading-snug text-ink">{r.label}</p>
            {r.hint && <p className="text-[12px] leading-snug text-muted">{r.hint}</p>}
          </div>
          <div className="min-w-0 space-y-1.5">
            {r.bars.map((b, i) => (
              <div key={series[i]?.name ?? i} className="flex items-center gap-3">
                {!single && <span className="w-20 shrink-0 text-[12px] text-muted">{series[i]?.name}</span>}
                <Bar share={b.share} fill={series[i]?.fill ?? 'bg-accent'} delay={0.04 * ri} />
                <span className={cn('shrink-0 text-right text-[12.5px] tabular-nums text-ink-2', single ? 'min-w-16' : 'w-36')}>{b.text}</span>
              </div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

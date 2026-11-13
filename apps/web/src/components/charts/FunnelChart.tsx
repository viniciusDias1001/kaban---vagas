import { motion } from 'motion/react';
import type { CSSProperties } from 'react';
import type { DashboardDto } from '@kv/shared/client';
import { funnelShares } from '../../lib/dashboard';
import { springSoft } from '../../lib/motion';

type Stage = 'applied' | 'responded' | 'interview' | 'offer';

/** As etapas com a cor da coluna do quadro que elas lembram ("responderam" não tem coluna: fica com o acento). */
const STAGES: { key: Stage; label: string; color: string }[] = [
  { key: 'applied', label: 'Aplicadas', color: 'var(--col-aplicada)' },
  { key: 'responded', label: 'Responderam', color: 'var(--color-accent)' },
  { key: 'interview', label: 'Entrevista', color: 'var(--col-entrevista)' },
  { key: 'offer', label: 'Oferta', color: 'var(--col-oferta)' },
];

/** Largura mínima visível de uma etapa que não é zero. */
const MIN_VISIBLE = 0.015;

/**
 * Funil das candidaturas do período: quatro barras empilhadas, largura relativa às aplicadas, número à direita;
 * ao lado, as perdidas. Para leitores de tela, uma imagem com todos os números no `aria-label`.
 */
export function FunnelChart({ funnel }: { funnel: DashboardDto['funnel'] }) {
  const shares = funnelShares(funnel);
  const aria = `Funil: ${STAGES.map((s) => `${s.label.toLowerCase()} ${funnel[s.key]}`).join(', ')}; perdidas ${funnel.lost}.`;
  return (
    <div role="img" aria-label={aria} className="grid gap-5 md:grid-cols-[minmax(0,1fr)_11rem] md:items-center">
      <ol className="space-y-2.5">
        {STAGES.map((s, i) => {
          const share = shares[s.key];
          const width = share <= 0 ? 0 : Math.max(MIN_VISIBLE, share);
          return (
            <li key={s.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-3">
              <span className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                <span className="kv-dot" style={{ '--col': s.color } as CSSProperties} />
                {s.label}
              </span>
              <div className="h-7 overflow-hidden rounded-lg bg-surface-3/60">
                <motion.div
                  className="h-full rounded-lg"
                  style={{
                    background: `linear-gradient(90deg, color-mix(in oklab, ${s.color} 38%, transparent), color-mix(in oklab, ${s.color} 78%, transparent))`,
                    boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.12), 0 0 18px -6px ${s.color}`,
                  }}
                  initial={{ width: 0 }} animate={{ width: `${width * 100}%` }}
                  transition={{ ...springSoft, delay: 0.08 + i * 0.07 }}
                />
              </div>
              <span className="text-right text-[17px] font-semibold tabular-nums text-ink">{funnel[s.key]}</span>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface-2/50 px-4 py-3 md:flex-col md:items-start md:gap-1">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
          <span className="kv-dot" style={{ '--col': 'var(--col-perdida)' } as CSSProperties} />
          Perdidas<span className="sr-only">: </span>
        </span>
        <span data-testid="painel-funnel-lost" className="ml-auto text-[26px] font-semibold leading-tight tabular-nums text-ink md:ml-0">
          {funnel.lost}
        </span>
      </div>
    </div>
  );
}

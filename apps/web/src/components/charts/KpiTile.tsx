import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { spring } from '../../lib/motion';
import { cn } from '../../lib/utils';

/**
 * Um número grande do Painel, no desenho dos contadores do quadro (`StatsBar`): ícone na cor da etapa,
 * rótulo, o número e, embaixo, a base dele ("3 de 8", "25% (3 de 12)").
 */
export function KpiTile({ label, value, detail, tone, icon, testId }: {
  label: string;
  value: number;
  detail: string;
  /** Classe de cor do ícone (`text-…`); o texto fica sempre nas cores de texto. */
  tone: string;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface/80 p-4 shadow-card">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-current/12 ring-1 ring-inset ring-current/15 [&_svg]:size-5', tone)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-tight text-muted">{label}</p>
        <p className="mt-1 h-9 overflow-hidden text-[30px] font-semibold leading-9 tracking-tight tabular-nums text-ink">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={value} className="block"
              initial={{ y: 22, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -22, opacity: 0 }}
              transition={spring}
            >
              {value}
            </motion.span>
          </AnimatePresence>
        </p>
        <p data-testid={`${testId}-detail`} className="mt-1 text-[12.5px] leading-snug tabular-nums text-ink-2">{detail}</p>
      </div>
    </div>
  );
}

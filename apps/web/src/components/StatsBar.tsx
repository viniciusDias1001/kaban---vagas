import { useQuery } from '@tanstack/react-query';
import { Bot, BriefcaseBusiness, ChevronRight, Hand, UserRoundCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';

const COUNTER = 'flex min-w-34 items-center gap-3 rounded-2xl border border-line bg-surface/80 py-2 pl-2.5 pr-4 shadow-card';

function Counter({ label, value, tone, icon, onClick, testId }: {
  label: string; value: number; tone: string; icon: ReactNode;
  /** Com ação, o contador vira botão (o mesmo desenho, com destaque ao passar o mouse). */
  onClick?: () => void;
  testId?: string;
}) {
  const content = (
    <>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-current/12 ring-1 ring-inset ring-current/15 [&_svg]:size-[18px]', tone)}>
        {icon}
      </span>
      <span className="block min-w-0 text-left">
        <span className="block whitespace-nowrap text-[11px] font-medium leading-tight text-muted">{label}</span>
        <span className="block h-7 overflow-hidden text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-ink">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={value} className="block"
              initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -18, opacity: 0 }}
              transition={spring}
            >
              {value}
            </motion.span>
          </AnimatePresence>
        </span>
      </span>
    </>
  );
  if (!onClick) return <div className={COUNTER}>{content}</div>;
  return (
    <button
      type="button" onClick={onClick} data-testid={testId}
      aria-label={`${label}: ${value}. Abrir em Candidaturas`}
      className={cn(
        COUNTER,
        'group cursor-pointer pr-3 transition-[border-color,background-color,transform] duration-150 ease-out-soft hover:border-line-strong hover:bg-surface-2 active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45',
      )}
    >
      {content}
      <ChevronRight aria-hidden className="ml-auto size-4 shrink-0 text-faint transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-ink" />
    </button>
  );
}

export function StatsBar({ onShowNeedsHuman }: { onShowNeedsHuman?: () => void }) {
  const { data } = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 15_000 });
  return (
    <div className="flex flex-wrap gap-2.5" data-testid="stats">
      <Counter label="Vagas" value={data?.total ?? 0} tone="text-ink-2" icon={<BriefcaseBusiness aria-hidden />} />
      <Counter label="Aplicadas pela IA" value={data?.appliedByAi ?? 0} tone="text-accent" icon={<Bot aria-hidden />} />
      <Counter label="Aplicadas por você" value={data?.appliedByHuman ?? 0} tone="text-ok" icon={<UserRoundCheck aria-hidden />} />
      <Counter
        label="Precisam de você" value={data?.needsHuman ?? 0} tone="text-warn" icon={<Hand aria-hidden />}
        onClick={onShowNeedsHuman} testId="stats-needs-human"
      />
    </div>
  );
}

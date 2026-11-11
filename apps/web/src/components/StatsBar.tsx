import { useQuery } from '@tanstack/react-query';
import { Bot, BriefcaseBusiness, Hand, UserRoundCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';

function Counter({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: ReactNode }) {
  return (
    <div className="flex min-w-34 items-center gap-3 rounded-2xl border border-line bg-surface/80 py-2 pl-2.5 pr-4 shadow-card">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-current/12 ring-1 ring-inset ring-current/15 [&_svg]:size-[18px]', tone)}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="whitespace-nowrap text-[11px] font-medium leading-tight text-muted">{label}</div>
        <div className="h-7 overflow-hidden text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-ink">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={value} className="block"
              initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -18, opacity: 0 }}
              transition={spring}
            >
              {value}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function StatsBar() {
  const { data } = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 15_000 });
  return (
    <div className="flex flex-wrap gap-2.5" data-testid="stats">
      <Counter label="Vagas" value={data?.total ?? 0} tone="text-ink-2" icon={<BriefcaseBusiness aria-hidden />} />
      <Counter label="Aplicadas pela IA" value={data?.appliedByAi ?? 0} tone="text-accent" icon={<Bot aria-hidden />} />
      <Counter label="Aplicadas por você" value={data?.appliedByHuman ?? 0} tone="text-ok" icon={<UserRoundCheck aria-hidden />} />
      <Counter label="Precisam de você" value={data?.needsHuman ?? 0} tone="text-warn" icon={<Hand aria-hidden />} />
    </div>
  );
}

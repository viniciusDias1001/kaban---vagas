import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`h-7 overflow-hidden text-xl font-semibold tabular-nums ${tone}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value} className="block"
            initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function StatsBar() {
  const { data } = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 15_000 });
  return (
    <div className="flex gap-3" data-testid="stats">
      <Counter label="Vagas" value={data?.total ?? 0} tone="text-ink" />
      <Counter label="Aplicadas pela IA" value={data?.appliedByAi ?? 0} tone="text-accent" />
      <Counter label="Aplicadas por você" value={data?.appliedByHuman ?? 0} tone="text-ok" />
      <Counter label="Precisam de você" value={data?.needsHuman ?? 0} tone="text-warn" />
    </div>
  );
}

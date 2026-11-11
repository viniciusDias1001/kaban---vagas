import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, CircleCheck, Columns3, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { api } from './api';
import { Board } from './components/Board';
import { HealthPanel } from './components/HealthPanel';
import { JobDrawer } from './components/JobDrawer';
import { ProfilesPage } from './components/ProfilesPage';
import { spring, springSnap } from './lib/motion';
import { cn } from './lib/utils';
import { useToast } from './toast';
import { useRunCatchUp } from './useRunCatchUp';

type View = 'quadro' | 'perfis' | 'fontes';
const VIEWS: { id: View; label: string; icon: typeof Columns3 }[] = [
  { id: 'quadro', label: 'Quadro', icon: Columns3 },
  { id: 'perfis', label: 'Perfis de busca', icon: SlidersHorizontal },
  { id: 'fontes', label: 'Saúde das fontes', icon: Activity },
];
const TWO_HOURS = 2 * 3_600_000;

export function App() {
  const [view, setView] = useState<View>('quadro');
  const [openJob, setOpenJob] = useState<number | null>(null);
  const toast = useToast();
  const catchUp = useRunCatchUp();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const stale = !!health?.lastFinishedAt && Date.now() - health.lastFinishedAt > TWO_HOURS;

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-10 shrink-0 border-b border-line bg-surface/70">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-50 mask-[linear-gradient(90deg,transparent_10%,black_70%)]"
          style={{ backgroundImage: 'url(/header-bg.jpg)' }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-accent/40 to-transparent" />
        <div className="relative flex h-15 items-center gap-4 px-4 sm:gap-7 sm:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <img
              src="/logo.png" alt="" className="size-8 rounded-[10px] shadow-[0_4px_14px_-4px_rgb(119_144_255/0.7)]"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <h1 className="text-[17px] font-semibold text-ink max-[820px]:sr-only">Kanban de Vagas</h1>
          </div>
          <nav aria-label="Seções" className="flex items-center gap-0.5 rounded-full border border-line bg-bg/55 p-1 shadow-[inset_0_1px_2px_rgb(3_5_14/0.6)]">
            {VIEWS.map((v) => {
              const active = view === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150 active:scale-[0.97]',
                    active ? 'text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      transition={spring}
                      className="absolute inset-0 rounded-full bg-accent/18 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-inset ring-accent/35"
                    />
                  )}
                  <v.icon aria-hidden className={cn('relative size-3.5 transition-colors', active ? 'text-accent' : 'text-faint')} />
                  <span className="relative">{v.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {stale && (
          <motion.div
            key="stale"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring}
            className="shrink-0 px-4 pt-3 sm:px-6"
          >
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-2xl border border-warn/25 bg-warn/10 px-4 py-2.5 text-[13px] text-warn"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p>
                O worker não termina uma busca há mais de 2 horas. Confira se ele está rodando (
                <code className="rounded-md bg-warn/15 px-1 py-px">pnpm dev</code>).
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="min-h-0 flex-1 overflow-hidden">
        {/* Só opacidade aqui: um transform neste nível viraria a referência do DragOverlay (position: fixed). */}
        <motion.div
          key={view} className="h-full"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {view === 'quadro' && <Board onOpen={setOpenJob} />}
          {view === 'perfis' && <ProfilesPage onRunQueued={catchUp} />}
          {view === 'fontes' && <HealthPanel />}
        </motion.div>
      </main>
      <JobDrawer id={openJob} onClose={() => setOpenJob(null)} />

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
        <AnimatePresence>
          {toast && (
            <motion.div
              role="status"
              initial={{ y: 20, opacity: 0, scale: 0.94 }} animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 12, opacity: 0, scale: 0.96 }} transition={springSnap}
              className={cn(
                'pointer-events-auto flex max-w-lg items-center gap-2.5 rounded-2xl border bg-surface-4 py-2.5 pl-3 pr-4 text-sm font-medium text-ink shadow-pop',
                toast.tone === 'error' ? 'border-bad/40' : 'border-accent/35',
              )}
            >
              {toast.tone === 'error'
                ? <CircleAlert aria-hidden className="size-[18px] shrink-0 text-bad" />
                : <CircleCheck aria-hidden className="size-[18px] shrink-0 text-accent" />}
              {toast.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

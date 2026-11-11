import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { api } from './api';
import { Board } from './components/Board';
import { HealthPanel } from './components/HealthPanel';
import { JobDrawer } from './components/JobDrawer';
import { ProfilesPage } from './components/ProfilesPage';
import { useToast } from './toast';

type View = 'quadro' | 'perfis' | 'fontes';
const VIEWS: { id: View; label: string }[] = [
  { id: 'quadro', label: 'Quadro' },
  { id: 'perfis', label: 'Perfis de busca' },
  { id: 'fontes', label: 'Saúde das fontes' },
];
const TWO_HOURS = 2 * 3_600_000;

export function App() {
  const [view, setView] = useState<View>('quadro');
  const [openJob, setOpenJob] = useState<number | null>(null);
  const toast = useToast();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const stale = !!health?.lastFinishedAt && Date.now() - health.lastFinishedAt > TWO_HOURS;

  return (
    <div className="flex h-full flex-col">
      <header
        className="border-b border-line bg-surface bg-cover bg-center"
        style={{ backgroundImage: 'linear-gradient(rgba(20,24,33,.88), rgba(20,24,33,.96)), url(/header-bg.jpg)' }}
      >
        <div className="flex items-center gap-6 px-6 py-3">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png" alt="" className="h-8 w-8 rounded"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <h1 className="text-lg font-semibold">Kanban de Vagas</h1>
          </div>
          <nav className="flex gap-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${
                  view === v.id ? 'bg-accent text-bg' : 'text-muted hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {stale && (
        <div role="alert" className="bg-warn/15 px-6 py-2 text-sm text-warn">
          O worker não termina uma busca há mais de 2 horas. Confira se ele está rodando (<code>pnpm dev</code>).
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {view === 'quadro' && <Board onOpen={setOpenJob} />}
        {view === 'perfis' && <ProfilesPage />}
        {view === 'fontes' && <HealthPanel />}
      </main>
      <JobDrawer id={openJob} onClose={() => setOpenJob(null)} />

      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-bg shadow-lg ${
              toast.tone === 'error' ? 'bg-bad' : 'bg-accent'
            }`}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

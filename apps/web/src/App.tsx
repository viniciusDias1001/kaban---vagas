import { useQuery } from '@tanstack/react-query';
import { Activity, ChartColumn, CircleAlert, CircleCheck, Columns3, Send, Settings, SlidersHorizontal, TriangleAlert, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { ApplicationFilter } from '@kv/shared/client';
import { api } from './api';
import { AlertBell } from './components/AlertBell';
import { Board } from './components/Board';
import { Tooltip } from './components/ui/tooltip';
import { useMediaQuery } from './lib/hooks';
import { spring, springSnap } from './lib/motion';
import { cn } from './lib/utils';
import { useBottomBarHeight, useToast } from './toast';
import { useApplyQueueRefresh, useApplyStatus, useLiveWaitNotification } from './useApply';
import { useRunCatchUp } from './useRunCatchUp';
import { isWorkerStale } from './workerStale';

// O quadro é a tela inicial e vai no pacote principal; o detalhe da vaga e as telas secundárias são
// baixados à parte (o painel já começa a baixar junto com o quadro, para abrir sem espera).
const JobDrawer = lazy(() => import('./components/JobDrawer').then((m) => ({ default: m.JobDrawer })));
const ProfilesPage = lazy(() => import('./components/ProfilesPage').then((m) => ({ default: m.ProfilesPage })));
const HealthPanel = lazy(() => import('./components/HealthPanel').then((m) => ({ default: m.HealthPanel })));
const MyProfilePage = lazy(() => import('./components/MyProfilePage').then((m) => ({ default: m.MyProfilePage })));
const SettingsPage = lazy(() => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const ApplicationsPage = lazy(() => import('./components/ApplicationsPage').then((m) => ({ default: m.ApplicationsPage })));
const PainelPage = lazy(() => import('./components/PainelPage'));

type View = 'quadro' | 'candidaturas' | 'painel' | 'perfis' | 'fontes' | 'perfil' | 'config';
const VIEWS: { id: View; label: string; icon: typeof Columns3 }[] = [
  { id: 'quadro', label: 'Quadro', icon: Columns3 },
  { id: 'candidaturas', label: 'Candidaturas', icon: Send },
  { id: 'painel', label: 'Painel', icon: ChartColumn },
  { id: 'perfis', label: 'Perfis de busca', icon: SlidersHorizontal },
  { id: 'fontes', label: 'Saúde das fontes', icon: Activity },
  { id: 'perfil', label: 'Meu perfil', icon: UserRound },
  { id: 'config', label: 'Configurações', icon: Settings },
];
/**
 * Abaixo desta largura as sete seções (e o sino) não cabem com o rótulo inteiro: as não ativas mostram só o ícone. O
 * rótulo continua no botão (escondido só da vista), então o nome acessível não muda, e aparece na dica.
 * O mesmo limite está nas classes `max-[1240px]:` dos botões abaixo (no Tailwind 4 elas valem para `width < 1240px`).
 * Medido com o sino: os rótulos inteiros pedem cerca de 1190 px; 1240 deixa folga (em 1366 cabem com 200 px de sobra).
 */
const COMPACT_NAV = '(width < 1240px)';
/** De quanto em quanto tempo o aviso do worker é recalculado numa aba parada. */
const STALE_CHECK_MS = 60_000;
/** O bloco "Respostas para candidaturas" de Meu perfil, aberto por um alerta de dado que falta. */
const ANSWERS_SECTION = '[data-testid="apply-answers-section"]';
/** Por quanto tempo esperar o bloco aparecer (a página é baixada à parte) antes de desistir de rolar até ele. */
const ANSWERS_WAIT_MS = 3_000;

export function App() {
  const [view, setView] = useState<View>('quadro');
  const [openJob, setOpenJob] = useState<number | null>(null);
  const toast = useToast();
  const bottomBar = useBottomBarHeight();
  const compactNav = useMediaQuery(COMPACT_NAV);
  const openSettings = useCallback(() => setView('config'), []);
  // "Abrir Respostas para candidaturas" (alerta de dado que falta): vai a Meu perfil e rola até o bloco quando ele aparece.
  const [answersPending, setAnswersPending] = useState(false);
  const openAnswers = useCallback(() => {
    setAnswersPending(true);
    setView('perfil');
  }, []);
  useEffect(() => {
    if (!answersPending || view !== 'perfil') return;
    const until = Date.now() + ANSWERS_WAIT_MS;
    let frame = 0;
    const look = () => {
      const el = document.querySelector<HTMLElement>(ANSWERS_SECTION);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setAnswersPending(false);
      } else if (Date.now() < until) {
        frame = requestAnimationFrame(look);
      } else {
        setAnswersPending(false);
      }
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [answersPending, view]);
  // A aba Candidaturas abre no filtro pedido (o contador do quadro pede "Precisam de você"); pela navegação, no padrão dela.
  const [applicationsFilter, setApplicationsFilter] = useState<ApplicationFilter | undefined>(undefined);
  const showNeedsHuman = useCallback(() => {
    setApplicationsFilter('needs_human');
    setView('candidaturas');
  }, []);
  // Espera ao vivo (captcha, código, login): um ponto na aba e, com a permissão dada, uma notificação do navegador.
  const applyState = useApplyStatus().data;
  // Um observador só: a fila mudou, as listas, as candidaturas das vagas e os selos do quadro são relidos na hora.
  useApplyQueueRefresh();
  const applyWaiting = applyState?.waiting ?? null;
  useLiveWaitNotification(applyState ? applyWaiting : undefined);
  const catchUp = useRunCatchUp();
  const { data: health, dataUpdatedAt: healthUpdatedAt } = useQuery({
    queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000,
  });
  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  // O aviso depende do relógio: recalcula a cada minuto (aba parada) e a cada resposta nova da saúde.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => setNow(Date.now()), [healthUpdatedAt]);
  const stale = !!health && !!profiles && isWorkerStale({ now, lastFinishedAt: health.lastFinishedAt, profiles });

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
              const button = (
                <button
                  key={v.id}
                  onClick={() => {
                    setApplicationsFilter(undefined);
                    setView(v.id);
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150 active:scale-[0.97]',
                    active ? 'text-ink' : 'text-muted hover:text-ink max-[1240px]:px-2.5',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      transition={spring}
                      className="absolute inset-0 rounded-full bg-accent/18 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-inset ring-accent/35"
                    />
                  )}
                  <v.icon aria-hidden className={cn('relative transition-colors', active ? 'size-3.5 text-accent' : 'size-3.5 text-faint max-[1240px]:size-4')} />
                  <span className={cn('relative whitespace-nowrap', !active && 'max-[1240px]:sr-only')}>{v.label}</span>
                  {v.id === 'candidaturas' && applyWaiting && (
                    <span data-testid="nav-applications-waiting" className="absolute right-1 top-1 flex size-2">
                      <span aria-hidden className="absolute inset-0 animate-pulse-dot rounded-full bg-warn" />
                      <span aria-hidden className="relative size-2 rounded-full bg-warn ring-2 ring-surface" />
                      <span className="sr-only"> (uma candidatura espera você agora)</span>
                    </span>
                  )}
                </button>
              );
              return compactNav && !active ? <Tooltip key={v.id} label={v.label}>{button}</Tooltip> : button;
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center">
            <AlertBell onOpenJob={setOpenJob} onOpenSettings={openSettings} onOpenAnswers={openAnswers} />
          </div>
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
          {view === 'quadro' && <Board onOpen={setOpenJob} onShowNeedsHuman={showNeedsHuman} />}
          <Suspense fallback={null}>
            {view === 'candidaturas' && <ApplicationsPage initialFilter={applicationsFilter} onOpenJob={setOpenJob} />}
            {view === 'painel' && <PainelPage />}
            {view === 'perfis' && <ProfilesPage onRunQueued={catchUp} />}
            {view === 'fontes' && <HealthPanel />}
            {view === 'perfil' && <MyProfilePage onOpenSettings={openSettings} />}
            {view === 'config' && <SettingsPage />}
          </Suspense>
        </motion.div>
      </main>
      <Suspense fallback={null}>
        <JobDrawer id={openJob} onClose={() => setOpenJob(null)} onOpenSettings={() => { setOpenJob(null); openSettings(); }} />
      </Suspense>

      {/* Acima de uma barra de ações fixa, quando a tela tem uma (Configurações, Meu perfil): nunca por cima dela. */}
      <div
        data-testid="toast-region"
        className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4 transition-[bottom] duration-200 ease-out-soft"
        style={{ bottom: `calc(${bottomBar}px + ${bottomBar > 0 ? '0.75rem' : '1.5rem'})` }}
      >
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

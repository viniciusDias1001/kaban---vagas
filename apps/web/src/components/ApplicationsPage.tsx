import { ArrowUpRight, BellRing, ChevronDown, CloudOff, LoaderCircle, RotateCw, Send } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { APPLY_SITE_LABELS, type ApplicationListItemDto } from '@kv/shared/client';
import {
  FILTER_LABELS, UNCONFIRMED_TEXT, filterApplications, filterCounts, firstFilterWithItems, reasonText, waitingText, type ApplicationFilter,
} from '../lib/apply';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { useApplications, useApplyActions, useApplyStatus, useJobApplication } from '../useApply';
import { ApplicationStatusBadge, formatWhen } from './JobApplicationSection';
import { PendingQuestions } from './PendingQuestions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';

const FILTERS = Object.keys(FILTER_LABELS) as ApplicationFilter[];
const EMPTY_TEXT: Record<ApplicationFilter, string> = {
  active: 'Nenhuma candidatura em andamento agora.',
  needs_human: 'Nada esperando você. Quando a IA parar numa pergunta, ela aparece aqui.',
  rehearsals: 'Nenhum ensaio pronto. Os ensaios mostram o que seria enviado, sem enviar.',
  submitted: 'Nenhuma candidatura enviada ainda.',
  skipped: 'Nenhuma candidatura pulada, com falha ou cancelada.',
};
/** Colunas da lista (a mesma grade no cabeçalho e nas linhas); abaixo de `md` cada linha empilha. */
const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_7.5rem_9.5rem_6.5rem_1.25rem] md:items-center md:gap-x-5';

type Permission = NotificationPermission | 'unsupported';
const readPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** O aviso da espera ao vivo, com o pedido de notificação do navegador por botão (nunca ao carregar a página). */
function LiveWait({ waiting, item, onOpenJob }: {
  waiting: { applicationId: number; jobId: number; gate: string };
  item: ApplicationListItemDto | undefined;
  onOpenJob: (jobId: number) => void;
}) {
  const [permission, setPermission] = useState<Permission>(readPermission);
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring}>
      <Notice
        tone="warn" role="alert" data-testid="applications-waiting" title={waitingText(waiting.gate)}
        icon={<span className="relative flex size-4 items-center justify-center"><span className="absolute size-2 animate-pulse-dot rounded-full bg-warn" /><span className="size-2 rounded-full bg-warn" /></span>}
        action={
          <>
            {permission === 'default' && (
              <Button
                type="button" size="sm" data-testid="applications-notify"
                onClick={() => void Notification.requestPermission().then(setPermission, () => setPermission(readPermission()))}
              >
                <BellRing aria-hidden /> Avisar-me aqui no navegador
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenJob(waiting.jobId)}>
              Abrir a vaga <ArrowUpRight aria-hidden />
            </Button>
          </>
        }
      >
        <p className="break-words">
          {item ? <>Vaga <span className="font-medium text-ink">{item.jobTitle}</span>, {item.company}. </> : null}
          A candidatura espera você por até 10 minutos; depois disso ela para e aparece em “Precisam de você”.
          {permission === 'granted' && ' Você recebe um aviso do navegador a cada nova espera.'}
        </p>
      </Notice>
    </motion.div>
  );
}

/** Uma candidatura parada em pergunta, aberta na própria linha. */
function RowAnswers({ jobId, onOpenJob }: { jobId: number; onOpenJob: (jobId: number) => void }) {
  const { data, isPending, isError, refetch } = useJobApplication(jobId);
  let body;
  if (isPending) {
    body = (
      <div aria-busy="true" className="space-y-2.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  } else if (isError && !data) {
    body = (
      <Notice tone="bad" action={<Button size="sm" onClick={() => refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}>
        Não foi possível carregar as perguntas desta candidatura.
      </Notice>
    );
  } else if (data && data.status === 'needs_human' && data.pendingQuestions.length > 0) {
    body = <PendingQuestions application={data} />;
  } else {
    body = (
      <p className="text-[13px] text-ink-2" role="status">
        Respostas recebidas. A candidatura voltou para a fila e continua sozinha.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {body}
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => onOpenJob(jobId)}>
        Ver a candidatura completa no painel da vaga <ArrowUpRight aria-hidden />
      </Button>
    </div>
  );
}

function Row({ item, index, open, onToggle, onOpenJob }: {
  item: ApplicationListItemDto; index: number; open: boolean; onToggle: () => void; onOpenJob: (jobId: number) => void;
}) {
  // Parada em pergunta: abre ali mesmo; as demais levam ao painel da vaga.
  const answersHere = item.status === 'needs_human' && item.reason === 'question' && item.pendingCount > 0;
  // Envio não confirmado não volta por "Tentar de novo": a frase da linha diz o que conferir.
  const reason = item.status === 'needs_human' && item.reason === 'confirm_submission'
    ? UNCONFIRMED_TEXT
    : reasonText(item.reason, item.detail);
  const when = item.submittedAt ?? item.createdAt;
  const panelId = `application-panel-${item.id}`;
  return (
    <motion.li
      layout="position" data-testid={`application-row-${item.id}`}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      transition={{ ...spring, delay: Math.min(index, 12) * 0.02 }}
      className={cn('border-t border-line first:border-t-0', open && 'bg-surface-2/40')}
    >
      <button
        type="button"
        onClick={answersHere ? onToggle : () => onOpenJob(item.jobId)}
        aria-expanded={answersHere ? open : undefined}
        aria-controls={answersHere ? panelId : undefined}
        className={cn(
          'w-full cursor-pointer px-4 py-3.5 text-left transition-colors duration-150 hover:bg-surface-2/70 sm:px-5',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-accent/45',
          GRID,
        )}
      >
        <span className="block min-w-0">
          <span className="block break-words text-sm font-semibold leading-snug text-ink">{item.jobTitle}</span>
          <span className="block mt-0.5 text-[13px] text-ink-2">
            {item.company}
            <span className="text-muted md:hidden"> · {APPLY_SITE_LABELS[item.site]}</span>
          </span>
          {(reason || answersHere) && (
            <span className="block mt-1 break-words text-xs leading-snug text-muted">
              {answersHere
                ? `${item.pendingCount === 1 ? '1 pergunta espera' : `${item.pendingCount} perguntas esperam`} a sua resposta.`
                : reason}
            </span>
          )}
        </span>
        <span className="hidden text-[13px] text-ink-2 md:block">{APPLY_SITE_LABELS[item.site]}</span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5 md:mt-0">
          <ApplicationStatusBadge status={item.status} />
          {item.mode === 'dry_run' && item.status !== 'dry_run_ready' && item.status !== 'skipped' && <Badge tone="outline">ensaio</Badge>}
          <span className="text-xs tabular-nums text-muted md:hidden">{formatWhen(when)}</span>
        </span>
        <span className="hidden text-xs tabular-nums text-muted md:block">{formatWhen(when)}</span>
        <span aria-hidden className="hidden text-faint md:block">
          {answersHere
            ? <ChevronDown className={cn('size-4 transition-transform duration-200', open && 'rotate-180 text-ink')} />
            : <ArrowUpRight className="size-4" />}
        </span>
        <span className="sr-only">{answersHere ? (open ? 'Fechar as perguntas' : 'Responder aqui') : 'Abrir no painel da vaga'}</span>
      </button>
      <AnimatePresence initial={false}>
        {answersHere && open && (
          <motion.div
            id={panelId} key="panel"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            transition={spring} className="overflow-hidden"
          >
            <div className="px-4 pb-4 sm:px-5 md:max-w-3xl">
              <RowAnswers jobId={item.jobId} onOpenJob={onOpenJob} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function ApplicationsPage({ initialFilter, onOpenJob }: { initialFilter?: ApplicationFilter; onOpenJob(jobId: number): void }) {
  const status = useApplyStatus().data;
  const list = useApplications();
  const { sendAll } = useApplyActions();
  const items = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(() => filterCounts(items), [items]);
  const [chosen, setChosen] = useState<ApplicationFilter | undefined>(initialFilter);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Sem escolha do dono, a aba abre no primeiro filtro com candidaturas e fica nele (não pula sozinha depois).
  const loaded = list.data !== undefined;
  useEffect(() => {
    if (chosen === undefined && loaded) setChosen(firstFilterWithItems(counts));
  }, [chosen, loaded, counts]);
  const filter = chosen ?? 'active';
  const shown = useMemo(() => filterApplications(items, filter), [items, filter]);
  const waiting = status?.waiting ?? null;
  const waitingItem = waiting ? items.find((a) => a.id === waiting.applicationId) : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}
          className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
        >
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">Candidaturas</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              O que a IA está fazendo em seu nome. Responda aqui o que só você sabe e aprove os ensaios antes do envio.
              {status && status.enabled && ` Hoje: ${status.totalToday} de ${status.totalCap} formulários.`}
            </p>
          </div>
          {counts.rehearsals > 0 && (
            <Button type="button" variant="primary" data-testid="applications-send-all" disabled={sendAll.isPending} onClick={() => setConfirmSend(true)}>
              {sendAll.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />}
              Enviar todos os ensaios ({counts.rehearsals})
            </Button>
          )}
        </motion.div>

        <AnimatePresence initial={false}>
          {waiting && <LiveWait key={`${waiting.applicationId}:${waiting.gate}`} waiting={waiting} item={waitingItem} onOpenJob={onOpenJob} />}
        </AnimatePresence>

        {status && !status.available && (
          <Notice tone="info" role="status" title="A candidatura automática não está disponível">{status.unavailableReason}</Notice>
        )}
        {status && status.available && !status.enabled && (
          <Notice tone="info" role="status" title="A candidatura automática está desligada">
            Ligue em Configurações para a IA se candidatar por você. As candidaturas que já existem continuam aqui.
          </Notice>
        )}
        {sendError && <Notice tone="bad" role="alert">{sendError}</Notice>}

        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 }}
          role="group" aria-label="Filtrar candidaturas"
          className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-2xl border border-line bg-bg/55 p-1 shadow-[inset_0_1px_2px_rgb(3_5_14/0.6)]"
        >
          {FILTERS.map((f) => {
            const active = f === filter;
            const attention = f === 'needs_human' && counts.needs_human > 0;
            return (
              <button
                key={f} type="button" data-testid={`applications-filter-${f}`} aria-pressed={active}
                onClick={() => { setChosen(f); setOpenId(null); }}
                className={cn(
                  'relative flex h-9 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-[13px] font-medium transition-colors duration-150 active:scale-[0.97]',
                  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45',
                  active ? 'text-ink' : 'text-muted hover:text-ink',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="applications-filter-pill" transition={spring}
                    className="absolute inset-0 rounded-xl bg-accent/18 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-inset ring-accent/35"
                  />
                )}
                <span className="relative whitespace-nowrap">{FILTER_LABELS[f]}</span>
                <span
                  className={cn(
                    'relative min-w-5 rounded-md px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums',
                    attention ? 'bg-warn/18 text-warn' : active ? 'bg-accent/20 text-ink' : 'bg-surface-3 text-muted',
                  )}
                >
                  {counts[f]}
                </span>
              </button>
            );
          })}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.06 }}
          className="overflow-hidden rounded-3xl border border-line bg-surface/85 shadow-raised"
        >
          <div aria-hidden className={cn('hidden h-10 border-b border-line bg-surface-2/60 px-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint', GRID)}>
            <span>Vaga</span><span>Site</span><span>Estado</span><span>Data</span><span />
          </div>
          {list.isPending ? (
            <ul aria-busy="true" aria-label="Carregando candidaturas">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className={cn('border-t border-line px-5 py-4 first:border-t-0', GRID)}>
                  <div><Skeleton className="h-4 w-3/5" /><Skeleton className="mt-2 h-3 w-1/3" /></div>
                  <Skeleton className="hidden h-3.5 w-20 md:block" />
                  <Skeleton className="hidden h-5 w-24 md:block" />
                  <Skeleton className="hidden h-3.5 w-20 md:block" />
                </li>
              ))}
            </ul>
          ) : list.isError && !list.data ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
                <CloudOff aria-hidden className="size-5" />
              </span>
              <p className="max-w-sm text-sm text-muted">Não foi possível carregar as candidaturas. Confira se a API está no ar.</p>
              <Button onClick={() => list.refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>
            </div>
          ) : shown.length === 0 ? (
            <p data-testid="applications-empty" className="px-6 py-12 text-center text-sm text-muted">{EMPTY_TEXT[filter]}</p>
          ) : (
            // Uma lista por filtro: trocar de filtro troca a lista inteira (as linhas do filtro anterior não ficam saindo);
            // dentro do filtro, a linha que muda de estado sai com animação.
            <ul key={filter} aria-label={FILTER_LABELS[filter]}>
              <AnimatePresence>
                {shown.map((item, i) => (
                  <Row
                    key={item.id} item={item} index={i} open={openId === item.id} onOpenJob={onOpenJob}
                    onToggle={() => setOpenId((id) => (id === item.id ? null : item.id))}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </motion.div>
      </div>

      <ConfirmDialog
        open={confirmSend} onOpenChange={setConfirmSend} testId="applications-send-all-dialog" busy={sendAll.isPending}
        title={`Enviar ${counts.rehearsals === 1 ? 'o ensaio pronto' : `os ${counts.rehearsals} ensaios prontos`} de verdade?`}
        confirmLabel={counts.rehearsals === 1 ? 'Enviar a candidatura' : `Enviar ${counts.rehearsals} candidaturas`}
        onConfirm={() => {
          setSendError(null);
          sendAll.mutate(undefined, {
            onSuccess: () => setConfirmSend(false),
            onError: (e) => { setConfirmSend(false); setSendError(e.message); },
          });
        }}
      >
        <p>Cada candidatura é enviada com exatamente as respostas do ensaio, no ritmo e nos limites do dia. Uma candidatura enviada não pode ser desfeita.</p>
      </ConfirmDialog>
    </div>
  );
}

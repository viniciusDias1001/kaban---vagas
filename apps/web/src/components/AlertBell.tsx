import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft, ArrowUpRight, Bell, BellOff, CalendarClock, Check, FileQuestionMark, Hourglass, Inbox, Link2, LoaderCircle,
  MailQuestionMark, MailWarning, PenLine, RotateCw, Search, Send, Settings, Trophy, TriangleAlert, X, type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  COLUMN_LABELS, DRAFT_PLACEHOLDER, isAppliedOrLater, type AlertDto, type AlertKind, type JobListItemDto, type MailReplyDto,
} from '@kv/shared/client';
import { api } from '../api';
import { alertAction, alertBody, alertTitle, alertsToNotify } from '../lib/email';
import { spring, springSnap } from '../lib/motion';
import { cn } from '../lib/utils';
import { useAlertActions, useAlerts, useJobEmails, useMessageActions, useReplyActions } from '../useEmail';
import { JOBS_KEY } from '../useMoveJob';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Input, Textarea } from './ui/input';
import { Notice } from './ui/notice';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

/** O ícone e a cor de cada tipo de alerta: a cor nunca é a única pista (o título diz o tipo). */
const KIND_LOOK: Record<AlertKind, { Icon: LucideIcon; tone: string }> = {
  interview: { Icon: CalendarClock, tone: 'bg-accent/14 text-accent ring-accent/25' },
  offer: { Icon: Trophy, tone: 'bg-ok/14 text-ok ring-ok/25' },
  missing_fact: { Icon: FileQuestionMark, tone: 'bg-warn/14 text-warn ring-warn/25' },
  draft: { Icon: PenLine, tone: 'bg-accent/14 text-accent ring-accent/25' },
  move_confirm: { Icon: ArrowRightLeft, tone: 'bg-surface-3 text-ink-2 ring-white/8' },
  unmatched: { Icon: MailQuestionMark, tone: 'bg-surface-3 text-ink-2 ring-white/8' },
  mailbox_error: { Icon: MailWarning, tone: 'bg-bad/14 text-bad ring-bad/25' },
  backfill_summary: { Icon: Inbox, tone: 'bg-surface-3 text-ink-2 ring-white/8' },
  budget_waiting: { Icon: Hourglass, tone: 'bg-warn/14 text-warn ring-warn/25' },
};

/** Quantas vagas a busca de "Ligar a esta vaga" mostra de uma vez: a lista não ganha barra própria. */
const LINK_MATCHES = 6;
const NO_JOBS: JobListItemDto[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
function sinceLabel(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'agora';
  if (ms < HOUR) return `há ${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `há ${Math.floor(ms / HOUR)} h`;
  const days = Math.floor(ms / DAY);
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

const messageOf = (e: unknown) => (e instanceof Error && e.message.trim() ? e.message : 'Não foi possível concluir. Tente de novo.');

/**
 * Um aviso do navegador por alerta de entrevista ou oferta novo, se o dono já deu a permissão (o botão fica na aba
 * Candidaturas, o mesmo da espera ao vivo). Os alertas que já existiam na primeira leitura não avisam.
 */
function useAlertNotifications(alerts: AlertDto[] | undefined) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!alerts) return;
    if (seen.current === null) {
      seen.current = new Set(alerts.map((a) => `alert-${a.id}`));
      return;
    }
    const fresh = alertsToNotify(alerts, seen.current);
    for (const a of fresh) seen.current.add(`alert-${a.id}`);
    if (fresh.length === 0 || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const a of fresh) {
      try {
        new Notification(alertTitle(a), { body: alertBody(a), tag: `alert-${a.id}` });
      } catch {
        // navegador sem `new Notification` (só via service worker): o sino continua valendo
      }
    }
  }, [alerts]);
}

export interface AlertBellProps {
  onOpenJob: (jobId: number) => void;
  onOpenSettings: () => void;
  onOpenAnswers: () => void;
}

/** O sino do cabeçalho: a contagem do que espera o dono e, ao clicar, o painel com cada alerta e a ação dele. */
export function AlertBell({ onOpenJob, onOpenSettings, onOpenAnswers }: AlertBellProps) {
  const [open, setOpen] = useState(false);
  const query = useAlerts();
  const alerts = useMemo(() => [...(query.data ?? [])].sort((a, b) => b.createdAt - a.createdAt), [query.data]);
  const count = alerts.length;
  useAlertNotifications(query.data);

  // Abrir outra tela fecha o painel primeiro.
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        type="button" data-testid="alert-bell" aria-label={`Alertas: ${count}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          'relative grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-bg/55 shadow-[inset_0_1px_2px_rgb(3_5_14/0.6)]',
          'text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink active:scale-[0.97]',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40',
          count > 0 && 'text-ink-2',
        )}
      >
        <Bell aria-hidden className="size-[18px]" />
        <AnimatePresence initial={false}>
          {count > 0 && (
            <motion.span
              key="count" data-testid="alert-count" aria-hidden
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={springSnap}
              className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold tabular-nums leading-none text-on-accent ring-2 ring-surface"
            >
              {/* Um só elemento; o número que muda dá um pulo curto. */}
              <motion.span key={count} initial={{ scale: 1.35 }} animate={{ scale: 1 }} transition={springSnap}>
                {count > 99 ? '99+' : count}
              </motion.span>
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent data-testid="alert-panel">
          <div className="flex h-full flex-col">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5">
              <div className="min-w-0">
                <SheetTitle className="text-lg font-semibold leading-snug text-ink">Alertas</SheetTitle>
                {/* Sem alertas, o corpo do painel já diz "Nada esperando você.". */}
                {count > 0 && (
                  <p className="mt-0.5 text-[13px] text-muted">{count === 1 ? '1 coisa espera você.' : `${count} coisas esperam você.`}</p>
                )}
              </div>
              <SheetClose asChild>
                <Button variant="ghost" size="icon" aria-label="Fechar" className="-mr-1.5 -mt-1 shrink-0"><X aria-hidden /></Button>
              </SheetClose>
            </header>
            <div className="relative flex-1 overflow-y-auto p-5">
              {query.isPending ? (
                <div aria-busy="true" className="space-y-3">
                  <Skeleton className="h-28 w-full rounded-2xl" />
                  <Skeleton className="h-20 w-full rounded-2xl" />
                  <span className="sr-only">Carregando…</span>
                </div>
              ) : query.isError && count === 0 ? (
                <Notice tone="bad" role="alert">Não foi possível carregar os alertas. Confira se a API está no ar.</Notice>
              ) : count === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}
                  className="flex flex-col items-center gap-3 py-16 text-center"
                >
                  <span className="grid size-14 place-items-center rounded-2xl bg-surface-3 text-faint ring-1 ring-inset ring-white/6">
                    <BellOff aria-hidden className="size-6" />
                  </span>
                  <p className="text-sm text-muted">Nada esperando você.</p>
                </motion.div>
              ) : (
                <ul aria-label="Alertas" className="space-y-3">
                  <AnimatePresence initial={false}>
                    {alerts.map((a) => (
                      <motion.li
                        key={a.id} layout
                        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }} transition={spring}
                      >
                        <AlertItem
                          alert={a}
                          onOpenJob={(id) => go(() => onOpenJob(id))()}
                          onOpenSettings={go(onOpenSettings)}
                          onOpenAnswers={go(onOpenAnswers)}
                        />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

type Run = (key: string, fn: () => Promise<unknown>) => Promise<boolean>;

function AlertItem({ alert, onOpenJob, onOpenSettings, onOpenAnswers }: {
  alert: AlertDto;
  onOpenJob: (jobId: number) => void;
  onOpenSettings: () => void;
  onOpenAnswers: () => void;
}) {
  const actions = useAlertActions();
  const messages = useMessageActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const { Icon, tone } = KIND_LOOK[alert.kind];
  const title = alertTitle(alert);
  const body = alertBody(alert);
  const action = alertAction(alert.kind);
  // O corpo cai no assunto quando não há resumo: se o título já o diz, não se repete.
  const showBody = body !== '' && !title.includes(body);

  /** Roda uma ação; o erro aparece uma vez, aqui no alerta (o aviso flutuante não abre). */
  const run: Run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const draftLike = action === 'review_draft' && alert.replyId !== null && alert.jobId !== null;
  const canOpenJob = alert.jobId !== null;
  const linkable = action === 'link' && alert.messageId !== null;
  /** A vaga escolhida em "De qual vaga é este e-mail?". */
  const [linkJob, setLinkJob] = useState<number | null>(null);

  return (
    <article
      data-testid={`alert-item-${alert.id}`} aria-labelledby={titleId}
      className="rounded-2xl border border-line bg-surface-2/70 p-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className={cn('grid size-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset', tone)}>
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={titleId} className="min-w-0 break-words text-sm font-semibold leading-snug text-ink">{title}</h3>
            <time dateTime={new Date(alert.createdAt).toISOString()} className="shrink-0 text-[11px] tabular-nums text-faint">
              {sinceLabel(alert.createdAt, Date.now())}
            </time>
          </div>
          {alert.jobTitle && alert.kind !== 'unmatched' && (
            <p className="mt-0.5 break-words text-xs leading-snug text-muted">{alert.jobTitle}</p>
          )}
          {showBody && <p className="mt-1.5 whitespace-pre-line break-words text-[13px] leading-relaxed text-ink-2">{body}</p>}
        </div>
      </div>

      {/* O que vem abaixo do texto alinha com o título (a coluna do ícone fica livre), menos em tela estreita. */}
      <div className="sm:pl-12">
        {draftLike && (
          <DraftEditor alert={alert} jobId={alert.jobId!} replyId={alert.replyId!} busy={busy} run={run} />
        )}
        {linkable && <LinkToJob alertId={alert.id} picked={linkJob} onPick={setLinkJob} />}

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {linkable && (
            <Button
              type="button" size="sm" variant="primary" data-testid={`alert-link-${alert.id}`} disabled={busy !== null || linkJob === null}
              onClick={() => linkJob !== null && void run('link', () => messages.link.mutateAsync({ id: alert.messageId!, jobId: linkJob }))}
            >
              {busy === 'link' ? <LoaderCircle aria-hidden className="animate-spin" /> : <Link2 aria-hidden />} Ligar a esta vaga
            </Button>
          )}
          {action === 'confirm_move' && (
            <>
              <Button
                type="button" size="sm" variant="primary" data-testid={`alert-move-${alert.id}`} disabled={busy !== null}
                onClick={() => void run('move', () => actions.move.mutateAsync({ id: alert.id, accept: true }))}
              >
                {busy === 'move' ? <LoaderCircle aria-hidden className="animate-spin" /> : <Check aria-hidden />} Mover
              </Button>
              <Button
                type="button" size="sm" data-testid={`alert-keep-${alert.id}`} disabled={busy !== null}
                onClick={() => void run('keep', () => actions.move.mutateAsync({ id: alert.id, accept: false }))}
              >
                Não mover
              </Button>
            </>
          )}
          {action === 'answer_fact' && (
            <>
              <Button type="button" size="sm" variant="primary" disabled={busy !== null} onClick={onOpenAnswers}>
                Abrir Respostas para candidaturas <ArrowUpRight aria-hidden />
              </Button>
              <Button
                type="button" size="sm" data-testid={`alert-retry-${alert.id}`} disabled={busy !== null}
                onClick={() => void run('retry', () => actions.retry.mutateAsync(alert.id))}
              >
                {busy === 'retry' ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />} Tentar de novo
              </Button>
            </>
          )}
          {action === 'open_settings' && (
            <Button type="button" size="sm" variant="primary" onClick={onOpenSettings}>
              <Settings aria-hidden /> Abrir Configurações
            </Button>
          )}
          {action === 'classify_anyway' && (
            <Button
              type="button" size="sm" variant="primary" data-testid={`alert-classify-${alert.id}`} disabled={busy !== null}
              onClick={() => void run('classify', () => actions.classifyAnyway.mutateAsync(alert.id))}
            >
              {busy === 'classify' && <LoaderCircle aria-hidden className="animate-spin" />} Classificar mesmo assim
            </Button>
          )}
          {canOpenJob && (
            <Button
              type="button" size="sm" variant={action === 'open_job' ? 'primary' : 'ghost'} data-testid={`alert-open-${alert.id}`}
              onClick={() => onOpenJob(alert.jobId!)}
            >
              Abrir a vaga <ArrowUpRight aria-hidden />
            </Button>
          )}
          <Button
            type="button" size="sm" variant="ghost" data-testid={`alert-dismiss-${alert.id}`} disabled={busy !== null}
            className="ml-auto" onClick={() => void run('dismiss', () => actions.dismiss.mutateAsync(alert.id))}
          >
            {busy === 'dismiss' && <LoaderCircle aria-hidden className="animate-spin" />} Dispensar
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {error && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
              <Notice tone="bad" role="alert" className="mt-3" data-testid={`alert-error-${alert.id}`}>{error}</Notice>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </article>
  );
}

/** O rascunho da resposta: o texto numa caixa que cresce, salvar, aprovar e enviar, descartar. */
function DraftEditor({ alert, jobId, replyId, busy, run }: {
  alert: AlertDto; jobId: number; replyId: number; busy: string | null; run: Run;
}) {
  const emails = useJobEmails(jobId);
  const reply: MailReplyDto | undefined = emails.data?.replies.find((r) => r.id === replyId);
  const replies = useReplyActions();
  /** null: o dono não mexeu, vale o texto do servidor. */
  const [text, setText] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fieldId = useId();
  const hintId = useId();

  if (emails.isPending) return <Skeleton className="mt-3.5 h-24 w-full rounded-xl" />;
  if (!reply) {
    return emails.isError
      ? <p className="mt-3 text-xs text-warn">Não foi possível carregar o rascunho agora.</p>
      : null;
  }
  if (reply.state !== 'rascunho') return null;

  const value = text ?? reply.body;
  const dirty = text !== null && text !== reply.body;
  const gaps = DRAFT_PLACEHOLDER.test(value);
  const hint = gaps ? 'Preencha os trechos entre colchetes duplos.' : dirty ? 'Salve a edição antes de enviar.' : null;
  const recipient = alert.payload.recipient?.trim();

  return (
    <div className="mt-3.5 space-y-2.5">
      {recipient ? (
        <Notice tone="warn" icon={<TriangleAlert />} data-testid={`alert-recipient-${alert.id}`}>
          Vai para <span className="font-medium text-ink">{recipient}</span>, que não é o remetente.
        </Notice>
      ) : (
        <p className="break-words text-xs text-muted">Para: <span className="text-ink-2">{reply.toAddress}</span></p>
      )}
      <label htmlFor={fieldId} className="sr-only">Texto da resposta</label>
      <Textarea
        id={fieldId} data-testid={`alert-draft-${alert.id}`} value={value} disabled={busy !== null}
        aria-describedby={hint ? hintId : undefined} onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" size="sm" variant="primary" data-testid={`alert-approve-${alert.id}`}
          disabled={busy !== null || gaps || dirty} aria-describedby={hint ? hintId : undefined}
          onClick={() => void run('approve', () => replies.approve.mutateAsync(reply.id))}
        >
          {busy === 'approve' ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />} Aprovar e enviar
        </Button>
        <Button
          type="button" size="sm" data-testid={`alert-save-${alert.id}`} disabled={busy !== null || !dirty}
          onClick={() => void run('save', async () => {
            await replies.edit.mutateAsync({ id: reply.id, body: value });
            setText(null);
          })}
        >
          {busy === 'save' && <LoaderCircle aria-hidden className="animate-spin" />} Salvar edição
        </Button>
        <Button
          type="button" size="sm" variant="danger" data-testid={`alert-discard-${alert.id}`} disabled={busy !== null}
          onClick={() => setConfirmDiscard(true)}
        >
          Descartar
        </Button>
      </div>
      {hint && <p id={hintId} className="text-xs leading-snug text-warn">{hint}</p>}
      <ConfirmDialog
        open={confirmDiscard} onOpenChange={setConfirmDiscard} title="Descartar este rascunho?" confirmLabel="Descartar"
        busy={busy === 'discard'} testId={`alert-discard-confirm-${alert.id}`}
        onConfirm={() => void run('discard', () => replies.discard.mutateAsync(reply.id)).then(() => setConfirmDiscard(false))}
      >
        <p>A resposta não é enviada. O e-mail continua na conversa da vaga.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Busca uma vaga em Aplicada ou depois e liga o e-mail (e o fio dele) a ela. */
function LinkToJob({ alertId, picked, onPick }: { alertId: number; picked: number | null; onPick: (jobId: number | null) => void }) {
  // A mesma consulta do quadro (mesma chave): em geral já está em cache.
  const { data, isPending } = useQuery({ queryKey: JOBS_KEY, queryFn: api.jobs });
  const [search, setSearch] = useState('');
  const fieldId = useId();

  const applied = useMemo(() => (data ?? NO_JOBS).filter((j) => isAppliedOrLater(j.column)), [data]);
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const matches = term === ''
    ? applied
    : applied.filter((j) => `${j.title} ${j.company}`.toLocaleLowerCase('pt-BR').includes(term));
  const pickedJob = applied.find((j) => j.id === picked) ?? null;
  // A vaga escolhida continua à vista mesmo quando a busca muda.
  const firstMatches = matches.slice(0, LINK_MATCHES);
  const shown = pickedJob && !firstMatches.includes(pickedJob) ? [pickedJob, ...firstMatches.slice(0, LINK_MATCHES - 1)] : firstMatches;
  const hidden = matches.filter((j) => !shown.includes(j)).length;

  return (
    <div className="mt-3.5 space-y-2.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-ink-2">De qual vaga é este e-mail?</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          id={fieldId} data-testid={`alert-link-search-${alertId}`} value={search} placeholder="Empresa ou título"
          autoComplete="off" className="h-9 pl-9" onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : applied.length === 0 ? (
        <p className="text-xs text-muted">Nenhuma vaga em Aplicada ou depois.</p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted">Nenhuma vaga com “{search.trim()}”.</p>
      ) : (
        <ul aria-label="Vagas em Aplicada ou depois" className="space-y-1">
          {shown.map((j) => {
            const on = j.id === picked;
            return (
              <li key={j.id}>
                <button
                  type="button" aria-pressed={on} data-testid={`alert-link-job-${alertId}-${j.id}`} onClick={() => onPick(on ? null : j.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40',
                    on ? 'border-accent/45 bg-accent/10' : 'border-line bg-bg/40 hover:border-line-strong hover:bg-surface-3',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{j.title}</span>
                    <span className="block truncate text-xs text-muted">{j.company}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{COLUMN_LABELS[j.column]}</span>
                  {on && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <p className="text-xs text-faint">Mais {hidden} {hidden === 1 ? 'vaga' : 'vagas'}: refine a busca.</p>}
    </div>
  );
}

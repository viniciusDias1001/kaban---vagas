import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Bot, CircleCheckBig, FileDown, LoaderCircle, RotateCw, Send, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  APPLY_SITE_LABELS, type ApplicationDto, type ApplicationReason, type ApplicationStatus, type JobDto, type ShotKind,
} from '@kv/shared/client';
import { applicationResumeUrl, applicationShotUrl } from '../applyApi';
import {
  ANSWER_SOURCE_LABELS, RUNNING_STATUSES, STATUS_LABELS, SHOT_LABELS, UNCONFIRMED_TEXT, answerText, applicationActions, applySectionView,
  liveWaitFor, markAppliedTarget, reasonText, statusLabel,
} from '../lib/apply';
import { spring } from '../lib/motion';
import { EYEBROW } from '../lib/styles';
import { cn } from '../lib/utils';
import { APPLY_KEYS, useApplyActions, useApplyStatus, useJobApplication } from '../useApply';
import { JOBS_KEY, useMoveJob } from '../useMoveJob';
import { PendingQuestions } from './PendingQuestions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Notice } from './ui/notice';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'outline';
const STATUS_TONE: Record<ApplicationStatus, Tone> = {
  queued: 'neutral', preparing: 'accent', filling: 'accent', waiting_human: 'warn', submitting: 'accent', submitted: 'ok',
  dry_run_ready: 'accent', needs_human: 'warn', skipped: 'outline', failed: 'bad', cancelled: 'outline',
};

/**
 * O estado da candidatura como selo; os estados em andamento ganham um ponto pulsando. Uma pulada porque o dono já
 * aplicou lê "Aplicada por você", no tom de enviada.
 */
export function ApplicationStatusBadge({ status, reason = null, size = 'sm' }: {
  status: ApplicationStatus; reason?: ApplicationReason | null; size?: 'sm' | 'md';
}) {
  const running = RUNNING_STATUSES.includes(status);
  const byOwner = status === 'skipped' && reason === 'already_applied';
  return (
    <Badge tone={byOwner ? 'ok' : STATUS_TONE[status]} size={size} className="gap-1.5" data-status={status}>
      {running && (
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inset-0 animate-pulse-dot rounded-full bg-current" />
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
      )}
      {statusLabel(status, reason)}
    </Badge>
  );
}

export const formatWhen = (ms: number) =>
  new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function SubHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h4 className="text-[13px] font-semibold text-ink">{children}</h4>
      {aside}
    </div>
  );
}

function Answers({ application }: { application: ApplicationDto }) {
  const title = application.status === 'dry_run_ready'
    ? 'O que o ensaio vai enviar'
    : application.status === 'submitted' ? 'Respostas enviadas' : 'Respostas preenchidas';
  return (
    <div className="space-y-2" data-testid="application-answers">
      <SubHeading>{title}</SubHeading>
      <dl className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-2/50">
        {application.answers.map((a) => (
          <div key={a.questionId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <dt className="break-words text-xs leading-snug text-muted">{a.label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{answerText(a.value)}</dd>
            </div>
            <Badge tone={a.source === 'written' ? 'accent' : a.source === 'blank' ? 'outline' : 'neutral'} className="mt-0.5">
              <span className="sr-only">Origem: </span>{ANSWER_SOURCE_LABELS[a.source]}
            </Badge>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** As fotos do formulário; cada uma abre em tamanho real numa caixa no centro, com o mesmo véu do painel. */
function Shots({ application }: { application: ApplicationDto }) {
  const [open, setOpen] = useState<ShotKind | null>(null);
  return (
    <div className="space-y-2">
      <SubHeading>Fotos</SubHeading>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {application.shots.map((kind) => (
          <li key={kind}>
            <button
              type="button" data-testid={`application-shot-${kind}`} onClick={() => setOpen(kind)}
              className="group block w-full cursor-pointer overflow-hidden rounded-xl border border-line bg-bg/60 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45"
            >
              <img
                src={applicationShotUrl(application.id, kind)} alt="" loading="lazy"
                className="aspect-[4/3] w-full object-cover object-top opacity-90 transition-opacity group-hover:opacity-100"
              />
              <span className="block px-2.5 py-1.5 text-xs text-ink-2">{SHOT_LABELS[kind]}</span>
            </button>
          </li>
        ))}
      </ul>
      {/*
        A foto é da página inteira (pode ter milhares de pixels de altura): abre na largura da caixa e quem rola é o véu,
        como num visualizador de imagem (o conteúdo fica dentro do véu, que é o que o Radix deixa rolar).
      */}
      <DialogPrimitive.Root open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <AnimatePresence>
          {open !== null && (
            <DialogPrimitive.Portal forceMount>
              <DialogPrimitive.Overlay asChild forceMount>
                <motion.div
                  data-testid="application-shot-overlay"
                  className="fixed inset-0 z-[70] overflow-y-auto bg-[#03040a]/80"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <div className="flex min-h-full items-center justify-center p-4">
                    <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                      <motion.div
                        data-testid="application-shot-dialog"
                        className="w-full max-w-5xl rounded-3xl border border-line-strong bg-surface p-3 shadow-pop outline-none"
                        initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        transition={spring}
                      >
                        <div className="flex items-center justify-between gap-3 px-1.5 pb-2.5">
                          <DialogPrimitive.Title className="text-sm font-semibold text-ink">{SHOT_LABELS[open]}</DialogPrimitive.Title>
                          <div className="flex items-center gap-1">
                            <Button asChild variant="ghost" size="sm">
                              <a href={applicationShotUrl(application.id, open)} target="_blank" rel="noopener noreferrer" data-testid="application-shot-new-tab">
                                Abrir em nova aba <ArrowUpRight aria-hidden />
                              </a>
                            </Button>
                            <DialogPrimitive.Close asChild>
                              <Button variant="ghost" size="icon" aria-label="Fechar"><X aria-hidden /></Button>
                            </DialogPrimitive.Close>
                          </div>
                        </div>
                        <img
                          src={applicationShotUrl(application.id, open)} alt={SHOT_LABELS[open]}
                          className="block h-auto w-full rounded-2xl border border-line"
                        />
                      </motion.div>
                    </DialogPrimitive.Content>
                  </div>
                </motion.div>
              </DialogPrimitive.Overlay>
            </DialogPrimitive.Portal>
          )}
        </AnimatePresence>
      </DialogPrimitive.Root>
    </div>
  );
}

function Timeline({ application }: { application: ApplicationDto }) {
  const last = application.events.length - 1;
  return (
    <div className="space-y-2.5">
      <SubHeading>Linha do tempo</SubHeading>
      <ol data-testid="application-timeline" className="relative space-y-3 before:absolute before:bottom-2 before:left-[4.5px] before:top-2 before:w-px before:bg-line">
        {application.events.map((e, i) => {
          // O motivo vai no último evento; o do envio não confirmado já está no aviso acima (e não se tenta de novo).
          const why = i === last && e.status === application.status && application.reason !== 'confirm_submission'
            ? reasonText(application.reason, application.detail)
            : '';
          return (
            <li key={`${e.at}-${i}`} className="relative flex gap-3">
              <span
                aria-hidden
                className={cn('relative mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-surface', i === last ? 'bg-accent' : 'bg-line-strong')}
              />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">
                  {i === last && e.status === application.status ? statusLabel(e.status, application.reason) : STATUS_LABELS[e.status]}
                </p>
                {e.message && <p className="break-words text-[13px] leading-snug text-ink-2">{e.message}</p>}
                {why && <p className="break-words text-[13px] leading-snug text-ink-2">{why}</p>}
                <p className="text-xs tabular-nums text-muted">{new Date(e.at).toLocaleString('pt-BR')}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function JobApplicationSection({ job, index }: { job: JobDto; index: number }) {
  const titleId = useId();
  const qc = useQueryClient();
  const query = useJobApplication(job.id);
  const status = useApplyStatus().data;
  const actions = useApplyActions();
  const { moveTo, resendColumn } = useMoveJob();
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const data = query.data;
  const application = data?.application ?? null;
  const view = applySectionView(data);

  // O painel aberto relê a vaga (selos, coluna, "precisa de você") quando o estado da candidatura muda.
  const stateKey = data === undefined ? undefined : application === null ? 'none' : `${application.status}:${application.reason}`;
  const previous = useRef(stateKey);
  useEffect(() => {
    if (previous.current !== undefined && stateKey !== undefined && previous.current !== stateKey) {
      void qc.invalidateQueries({ queryKey: ['job', job.id] });
      void qc.invalidateQueries({ queryKey: JOBS_KEY });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    }
    previous.current = stateKey;
  }, [stateKey, qc, job.id]);

  /** Erro de uma ação: aparece junto dos botões, e a candidatura é relida (pode ter terminado enquanto isso). */
  const onError = (e: Error) => {
    setError(e.message);
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.job(job.id) });
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.applications });
  };
  const run = <T,>(m: { mutate: (v: T, o: { onError: (e: Error) => void; onSuccess: () => void }) => void }, v: T) => {
    setError(null);
    m.mutate(v, { onError, onSuccess: () => setError(null) });
  };
  const busy = actions.apply.isPending || actions.retry.isPending || actions.cancel.isPending || actions.send.isPending || marking;

  /**
   * "Já apliquei por conta própria": o card vai para Aplicada (ou, se já está lá ou depois, a coluna é mandada de novo) e
   * a API encerra a candidatura como "Aplicada por você". A seção relê na hora em que o PATCH termina.
   */
  const markApplied = () => {
    setError(null);
    setMarking(true);
    const settled = () => {
      setMarking(false);
      void qc.invalidateQueries({ queryKey: APPLY_KEYS.job(job.id) });
      void qc.invalidateQueries({ queryKey: APPLY_KEYS.applications });
      void qc.invalidateQueries({ queryKey: APPLY_KEYS.status });
    };
    const target = markAppliedTarget(job.column);
    if (target.sameColumn) resendColumn(job.id, target.column, settled);
    else moveTo(job.id, target.column, null, settled);
  };

  // Sem candidatura e sem poder aplicar (site não atendido, vaga já aplicada, função desligada...): o painel fica como era.
  if (view === 'hidden' || (query.isError && !application)) return null;

  const waitText = liveWaitFor(status, job.id);
  let body: ReactNode;
  if (!application) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-2xl border border-dashed border-line px-3.5 py-3">
        <p className="min-w-48 flex-1 text-[13px] leading-snug text-muted">
          A IA ainda não se candidatou a esta vaga. Ela preenche o formulário em seu nome e para quando precisar de você.
        </p>
        <Button type="button" variant="primary" size="sm" data-testid="apply-now" disabled={busy} onClick={() => run(actions.apply, job.id)}>
          {actions.apply.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Bot aria-hidden />} Aplicar com IA
        </Button>
      </div>
    );
  } else {
    const can = applicationActions(application, job);
    const unconfirmed = can.alreadyApplied;
    const asking = application.status === 'needs_human' && application.reason === 'question' && application.pendingQuestions.length > 0;
    const reason = reasonText(application.reason, application.detail);
    body = (
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <ApplicationStatusBadge status={application.status} reason={application.reason} size="md" />
            {application.status !== 'dry_run_ready' && (
              <Badge size="md" tone="outline">{application.mode === 'dry_run' ? 'Ensaio' : 'Envio de verdade'}</Badge>
            )}
            <Badge size="md" tone="outline">{APPLY_SITE_LABELS[application.site]}</Badge>
            {application.gateScore !== null && (
              <Badge size="md" tone="outline" className="tabular-nums">Nota conferida: {application.gateScore}</Badge>
            )}
          </div>
          {reason && !unconfirmed && <p className="break-words text-[13px] leading-relaxed text-ink-2">{reason}</p>}
          {application.confirmation && (
            <p className="flex items-start gap-2 break-words text-[13px] leading-relaxed text-ink-2">
              <CircleCheckBig aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
              <span><span className="text-muted">Confirmação do site: </span>{application.confirmation}</span>
            </p>
          )}
        </div>

        {waitText && (
          <Notice tone="warn" role="status" data-testid="application-live-wait">
            <p>{waitText} A candidatura espera você por até 10 minutos.</p>
          </Notice>
        )}

        {unconfirmed && (
          <Notice tone="warn" role="status" data-testid="application-unconfirmed">
            <p>{UNCONFIRMED_TEXT}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button type="button" size="sm" data-testid="application-already-applied" disabled={busy} onClick={markApplied}>
                {marking && <LoaderCircle aria-hidden className="animate-spin" />} Já apliquei por conta própria
              </Button>
              <Button
                type="button" size="sm" variant="danger" data-testid="application-cancel" disabled={busy || can.cancelPending}
                onClick={() => run(actions.cancel, application.id)}
              >
                Cancelar
              </Button>
            </div>
          </Notice>
        )}

        {asking && <PendingQuestions application={application} />}

        {application.answers.length > 0 && <Answers application={application} />}

        {application.hasResume && (
          <Button asChild size="sm">
            <a href={applicationResumeUrl(application.id)} download data-testid="application-resume">
              <FileDown aria-hidden />
              {application.status === 'dry_run_ready' ? 'Currículo que vai junto' : 'Currículo enviado'}
              {application.resumeFileName && <span className="max-w-56 truncate font-normal text-muted">{application.resumeFileName}</span>}
            </a>
          </Button>
        )}

        {can.send && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-accent/25 bg-accent/7 px-3.5 py-3">
            <p className="min-w-48 flex-1 text-[13px] leading-snug text-ink-2">Envia a candidatura com exatamente estas respostas.</p>
            <Button type="button" variant="primary" data-testid="application-send" disabled={busy} onClick={() => run(actions.send, application.id)}>
              {actions.send.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />} Enviar de verdade
            </Button>
          </div>
        )}

        {(can.retry || (can.cancel && !unconfirmed)) && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {can.retry && (
                <Button type="button" size="sm" data-testid="application-retry" disabled={busy} onClick={() => run(actions.retry, application.id)}>
                  <RotateCw aria-hidden /> Tentar de novo
                </Button>
              )}
              {can.cancel && !unconfirmed && (
                <Button
                  type="button" size="sm" variant="danger" data-testid="application-cancel" disabled={busy || can.cancelPending}
                  onClick={() => run(actions.cancel, application.id)}
                >
                  Cancelar
                </Button>
              )}
            </div>
            {can.cancelPending ? (
              <p className="text-xs leading-snug text-warn" role="status" data-testid="application-cancel-pending">
                Cancelamento pedido; vale no próximo ponto seguro.
              </p>
            ) : can.cancelLater && (
              <p className="text-xs leading-snug text-faint">
                O cancelamento vale no próximo ponto seguro; um envio que já começou ainda pode ser concluído.
              </p>
            )}
          </div>
        )}

        {application.shots.length > 0 && <Shots application={application} />}

        {application.events.length > 0 && <Timeline application={application} />}
      </div>
    );
  }

  return (
    <motion.section
      data-testid="job-application" aria-labelledby={titleId}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 + index * 0.04 }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={titleId} className={EYEBROW}>Candidatura</h3>
        {application && <span className="text-[11px] tabular-nums text-faint">desde {formatWhen(application.createdAt)}</span>}
      </div>
      {body}
      {error && <Notice tone="bad" role="alert" className="mt-3" data-testid="application-error">{error}</Notice>}
      {query.isError && application && <p className="mt-2 text-xs text-warn">Não foi possível atualizar a candidatura agora.</p>}
    </motion.section>
  );
}

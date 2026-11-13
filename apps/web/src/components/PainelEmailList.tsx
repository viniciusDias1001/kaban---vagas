import { ArrowDownLeft, ArrowUpRight, Inbox, RotateCw, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { lazy, Suspense, useId, useMemo, useState, type KeyboardEvent } from 'react';
import {
  EMAIL_KINDS, EMAIL_KIND_LABELS, periodSince, type DashboardPeriod, type EmailKind, type MailMessageDto, type MailReplyDto,
} from '@kv/shared/client';
import { mailActions, replyStateLabel } from '../lib/email';
import { useMediaQuery } from '../lib/hooks';
import { spring } from '../lib/motion';
import { CARD, EYEBROW } from '../lib/styles';
import { cn } from '../lib/utils';
import { useJobEmails, useMailMessages } from '../useEmail';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

const JobDrawer = lazy(() => import('./JobDrawer').then((m) => ({ default: m.JobDrawer })));

type KindFilter = 'all' | EmailKind;

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  ...EMAIL_KINDS.map((k) => ({ value: k, label: EMAIL_KIND_LABELS[k] })),
];

const KIND_TONE: Record<EmailKind, 'neutral' | 'accent' | 'ok' | 'warn' | 'bad'> = {
  recebimento: 'neutral', reprovacao: 'bad', entrevista: 'accent', oferta: 'ok', pedido: 'warn', outro: 'neutral',
};

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** O que a linha mostra como texto: o resumo; nos enviados (e sem resumo), o assunto. */
const lineText = (m: MailMessageDto): string => (m.direction === 'in' && m.summary?.trim()) || m.subject.trim() || '(sem assunto)';

function KindBadge({ m }: { m: MailMessageDto }) {
  if (m.direction === 'out') return <Badge tone="outline">Enviado</Badge>;
  return m.kind ? <Badge tone={KIND_TONE[m.kind]}>{EMAIL_KIND_LABELS[m.kind]}</Badge> : <Badge tone="outline">Sem tipo</Badge>;
}

function Actions({ m }: { m: MailMessageDto }) {
  const actions = mailActions(m);
  if (actions.length === 0) return <span aria-label="Nada" className="text-faint">-</span>;
  return (
    <ul className="space-y-0.5 text-[13px] text-ink-2">
      {actions.map((a) => <li key={a}>{a}</li>)}
    </ul>
  );
}

function Who({ m }: { m: MailMessageDto }) {
  if (m.jobId === null) return <span className="text-muted">Sem vaga</span>;
  return (
    <span className="text-ink">
      {m.company}{m.jobTitle ? <span className="text-muted"> · {m.jobTitle}</span> : null}
    </span>
  );
}

function rowKeys(open: () => void) {
  return {
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    },
  };
}

const FOCUS = 'cursor-pointer focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45 focus-visible:ring-inset';

function MailTable({ rows, onOpen }: { rows: MailMessageDto[]; onOpen: (m: MailMessageDto) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-t-0 hover:bg-transparent">
          <TableHead className="px-3">Data</TableHead>
          <TableHead className="px-3">Vaga</TableHead>
          <TableHead className="px-3">Tipo</TableHead>
          <TableHead className="px-3">Resumo</TableHead>
          <TableHead className="px-3">O que o app fez</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.id} data-testid={`painel-mail-row-${m.id}`} className={FOCUS} {...rowKeys(() => onOpen(m))}>
            <TableCell className="whitespace-nowrap px-3 align-top tabular-nums text-muted">{dateFmt.format(m.sentAt)}</TableCell>
            <TableCell className="px-3 align-top text-[13px] leading-snug"><Who m={m} /></TableCell>
            <TableCell className="px-3 align-top"><KindBadge m={m} /></TableCell>
            <TableCell className="max-w-[30rem] px-3 align-top text-[13px] leading-snug text-ink-2">{lineText(m)}</TableCell>
            <TableCell className="px-3 align-top"><Actions m={m} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MailCards({ rows, onOpen }: { rows: MailMessageDto[]; onOpen: (m: MailMessageDto) => void }) {
  return (
    <ul className="space-y-2.5">
      {rows.map((m) => (
        <li key={m.id}>
          <div
            role="button" data-testid={`painel-mail-row-${m.id}`}
            className={cn(FOCUS, 'block w-full rounded-2xl border border-line bg-surface-2/50 p-3.5 text-left transition-colors hover:bg-surface-2/80')}
            {...rowKeys(() => onOpen(m))}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <KindBadge m={m} />
              <span className="text-xs tabular-nums text-muted">{dateFmt.format(m.sentAt)}</span>
            </div>
            <p className="mt-2 break-words text-[13px] leading-snug"><Who m={m} /></p>
            <p className="mt-1 break-words text-[13px] leading-snug text-ink-2">{lineText(m)}</p>
            {mailActions(m).length > 0 && <div className="mt-2 border-t border-line pt-2"><Actions m={m} /></div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Bubble({ m }: { m: MailMessageDto }) {
  const out = m.direction === 'out';
  const Icon = out ? ArrowUpRight : ArrowDownLeft;
  const body = m.body.trim() || m.summary?.trim() || '';
  return (
    <article
      data-testid={`painel-mail-message-${m.id}`}
      className={cn('rounded-2xl border p-4', out ? 'border-accent/25 bg-accent/7' : 'border-line bg-surface-2/50')}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
          <span className="min-w-0 break-words">{out ? 'Você' : m.fromName || m.fromAddress}</span>
        </p>
        <span className="text-xs tabular-nums text-muted">{dateTimeFmt.format(m.sentAt)}</span>
      </header>
      {body && <p className="mt-3 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{body}</p>}
    </article>
  );
}

function ReplyBox({ r }: { r: MailReplyDto }) {
  return (
    <article className="rounded-2xl border border-dashed border-line-strong p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className={EYEBROW}>Resposta preparada</p>
        <Badge tone={r.state === 'falhou' ? 'bad' : 'neutral'}>{replyStateLabel(r.state)}</Badge>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{r.body}</p>
      {r.note && <p className="mt-2 text-xs text-muted">{r.note}</p>}
    </article>
  );
}

/** O fio de uma vaga: as mensagens do mesmo fio, em ordem, e as respostas que ainda não saíram como e-mail. */
function JobThread({ mail, jobId }: { mail: MailMessageDto; jobId: number }) {
  const job = useJobEmails(jobId);
  if (job.isError) {
    return (
      <Notice
        tone="bad" role="alert" title="Não foi possível carregar a conversa"
        action={<Button size="sm" disabled={job.isFetching} onClick={() => void job.refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}
      >
        <p>{job.error.message}</p>
      </Notice>
    );
  }
  if (!job.data) return <div aria-hidden className="space-y-3"><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-24 rounded-2xl" /></div>;
  const thread = job.data.messages.filter((m) => m.threadKey === mail.threadKey).sort((a, b) => a.sentAt - b.sentAt);
  const messages = thread.length > 0 ? thread : [mail];
  const ids = new Set(messages.map((m) => m.id));
  // Uma resposta enviada já aparece como e-mail enviado do fio.
  const replies = job.data.replies.filter((r) => ids.has(r.messageId) && r.state !== 'enviada');
  return (
    <div className="space-y-3" data-testid="painel-mail-thread">
      {messages.map((m) => <Bubble key={m.id} m={m} />)}
      {replies.map((r) => <ReplyBox key={r.id} r={r} />)}
    </div>
  );
}

function MailSheet({ mail, open, onClose, onOpenJob }: {
  mail: MailMessageDto | null; open: boolean; onClose: () => void; onOpenJob: (jobId: number) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {mail && (
        <SheetContent>
          <div className="flex h-full flex-col">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5">
              <div className="min-w-0">
                <SheetTitle className="break-words text-[17px] font-semibold leading-snug text-ink">{mail.subject.trim() || '(sem assunto)'}</SheetTitle>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <KindBadge m={mail} />
                  <Who m={mail} />
                </p>
              </div>
              <SheetClose asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Fechar a conversa"><X aria-hidden /></Button>
              </SheetClose>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {mailActions(mail).length > 0 && (
                <div>
                  <p className={EYEBROW}>O que o app fez</p>
                  <div className="mt-1.5"><Actions m={mail} /></div>
                </div>
              )}
              {mail.jobId === null ? <div className="space-y-3"><Bubble m={mail} /></div> : <JobThread mail={mail} jobId={mail.jobId} />}
            </div>
            {mail.jobId !== null && (
              <footer className="border-t border-line p-4">
                <Button data-testid="painel-mail-open-job" className="w-full" onClick={() => onOpenJob(mail.jobId as number)}>
                  Abrir a vaga
                </Button>
              </footer>
            )}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}

function Loading() {
  return (
    <div aria-hidden className="space-y-2">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11 rounded-xl" />)}
    </div>
  );
}

/** A lista dos e-mails de vaga do período, recebidos e enviados, do mais novo ao mais antigo; clicar abre a conversa. */
export function PainelEmailList({ period }: { period: DashboardPeriod }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [unmatched, setUnmatched] = useState(false);
  const [selected, setSelected] = useState<MailMessageDto | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const narrow = useMediaQuery('(max-width: 767px)');
  const reduced = useReducedMotion();
  const titleId = useId();
  const kindLabelId = useId();
  // O início do período muda só com a escolha do período: a chave da consulta não pode mudar a cada renderização.
  const since = useMemo(() => periodSince(period, Date.now()), [period]);
  const { data, isError, error, isFetching, isPlaceholderData, refetch } = useMailMessages({
    ...(kind !== 'all' && { kind }),
    ...(unmatched && { unmatched: true }),
    ...(since !== null && { since }),
  });
  const rows = useMemo(() => [...(data ?? [])].sort((a, b) => b.sentAt - a.sentAt), [data]);
  const open = (m: MailMessageDto) => { setSelected(m); setSheetOpen(true); };

  return (
    <motion.section
      data-testid="painel-mail-list" aria-labelledby={titleId}
      initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring}
      className={cn(CARD, 'min-w-0 p-5 sm:p-6')}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h3 id={titleId} className="text-[15px] font-semibold leading-tight text-ink">Mensagens do período</h3>
        <CheckChip label="Sem vaga" checked={unmatched} onCheckedChange={setUnmatched} testId="painel-mail-filter-unmatched" />
      </div>
      <div data-testid="painel-mail-filter-kind" className="mt-4 max-w-full">
        <span id={kindLabelId} className="sr-only">Tipo</span>
        <Segmented
          aria-labelledby={kindLabelId} value={kind} onValueChange={setKind} options={KIND_OPTIONS}
          className="flex flex-wrap [&>button]:whitespace-nowrap [&>button]:px-3"
        />
      </div>

      <div
        className={cn('mt-5 transition-opacity duration-200 ease-out-soft', isPlaceholderData && 'pointer-events-none opacity-45')}
        aria-busy={isFetching || undefined}
      >
        {isError ? (
          <Notice
            tone="bad" role="alert" title="Não foi possível carregar os e-mails"
            action={<Button size="sm" disabled={isFetching} onClick={() => void refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}
          >
            <p>{error.message}</p>
          </Notice>
        ) : !data ? <Loading /> : rows.length === 0 ? (
          <p data-testid="painel-mail-empty" className="flex items-center gap-2 text-[13px] leading-relaxed text-muted">
            <Inbox aria-hidden className="size-4 shrink-0" /> Nenhum e-mail de vaga neste período.
          </p>
        ) : narrow ? <MailCards rows={rows} onOpen={open} /> : <MailTable rows={rows} onOpen={open} />}
      </div>

      <MailSheet
        mail={selected} open={sheetOpen} onClose={() => setSheetOpen(false)}
        onOpenJob={(id) => { setSheetOpen(false); setJobId(id); }}
      />
      <Suspense fallback={null}>
        {jobId !== null && <JobDrawer id={jobId} onClose={() => setJobId(null)} onOpenSettings={() => setJobId(null)} />}
      </Suspense>
    </motion.section>
  );
}

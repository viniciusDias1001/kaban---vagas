import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, Paperclip, RotateCcw, TriangleAlert, Unlink } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  COLUMN_LABELS, EMAIL_KIND_LABELS, type JobDto, type MailMessageDto, type MailReplyDto, type ReplyState,
} from '@kv/shared/client';
import { emailConversation, replyStateLabel, type ConversationItem } from '../lib/email';
import { spring } from '../lib/motion';
import { EYEBROW } from '../lib/styles';
import { cn } from '../lib/utils';
import { useJobEmails, useMessageActions } from '../useEmail';
import { formatWhen } from './JobApplicationSection';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Notice } from './ui/notice';
import { ReplyDraftEditor } from './ReplyDraftEditor';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'outline';
const REPLY_TONE: Record<ReplyState, Tone> = {
  rascunho: 'warn', aprovada: 'accent', enviando: 'accent', enviada: 'ok', falhou: 'bad', descartada: 'outline',
};
const ORIGIN_LABEL = { ai: 'escrita pela IA', facts: 'com seus dados salvos' } as const;

/** As mutações do e-mail não abrem o aviso flutuante: o erro vem por aqui e aparece junto do botão que falhou. */
const messageOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Não foi possível concluir. Tente de novo.');

/**
 * O texto do erro, e a conversa relida: uma recusa costuma querer dizer que o estado mudou (o card já se moveu, a resposta já
 * saiu), e os botões que não valem mais somem enquanto o erro fica à vista.
 */
function useFailure() {
  const qc = useQueryClient();
  return (e: unknown): string => {
    void qc.invalidateQueries({ queryKey: ['email', 'job'] });
    return messageOf(e);
  };
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function InlineError({ error, testId }: { error: string | null; testId: string }) {
  if (!error) return null;
  return <Notice tone="bad" role="alert" className="mt-2.5" data-testid={testId}>{error}</Notice>;
}

/** O texto de um e-mail dobrado em 6 linhas; "Ver tudo" só aparece quando há mais. A página rola, a caixa nunca. */
function FoldedText({ text }: { text: string }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  if (text.trim() === '') return <p className="text-[13px] italic text-faint">Sem texto.</p>;
  return (
    <div>
      <p ref={ref} id={id} className={cn('whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2', !open && 'line-clamp-6')}>
        {text}
      </p>
      {(overflows || open) && (
        <button
          type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
          className="mt-1 cursor-pointer rounded-md text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45"
        >
          {open ? 'Ver menos' : 'Ver tudo'}
        </button>
      )}
    </div>
  );
}

function Sender({ m }: { m: MailMessageDto }) {
  if (m.direction === 'out') {
    return <p className="break-words text-xs text-muted"><span className="text-faint">Para: </span>{m.toAddress}</p>;
  }
  return (
    <p className="break-words text-xs text-muted">
      <span className="text-faint">De: </span>
      {m.fromName.trim() ? <><span className="text-ink-2">{m.fromName}</span> &lt;{m.fromAddress}&gt;</> : m.fromAddress}
    </p>
  );
}

/** "enviada automaticamente" ou "aprovada por você", com a hora do envio. */
function SentBy({ approvedBy, sentAt }: { approvedBy: 'auto' | 'owner' | null; sentAt: number | null }) {
  const who = approvedBy === 'auto' ? 'enviada automaticamente' : approvedBy === 'owner' ? 'aprovada por você' : null;
  if (!who && sentAt === null) return null;
  return (
    <p className="text-xs text-muted">
      {who}{who && sentAt !== null && ' · '}{sentAt !== null && <span className="tabular-nums">{formatWhen(sentAt)}</span>}
    </p>
  );
}

/** Para quem a resposta vai; quando não é quem escreveu, isso é dito com o endereço (e o "Para:" não se repete). */
function Recipient({ reply, origin }: { reply: MailReplyDto; origin: MailMessageDto | undefined }) {
  const differs = origin !== undefined && !sameAddress(reply.toAddress, origin.fromAddress);
  return (
    <div className="space-y-1">
      {differs ? (
        <p className="flex items-start gap-1.5 break-words text-xs leading-snug text-warn">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Vai para {reply.toAddress}, que não é o remetente.</span>
        </p>
      ) : (
        <p className="break-words text-xs text-muted"><span className="text-faint">Para: </span>{reply.toAddress}</p>
      )}
      {reply.attachResume && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Paperclip aria-hidden className="size-3.5 shrink-0" /> Com o currículo em anexo.
        </p>
      )}
    </div>
  );
}

/** A resposta preparada para um e-mail recebido, presa a ele por um fio à esquerda. */
function ReplyBlock({ reply, origin, jobId }: { reply: MailReplyDto; origin: MailMessageDto | undefined; jobId: number }) {
  const note = reply.note?.trim() || null;
  // Rascunho e falha: o editor compartilhado com o sino (ele mesmo diz para quem vai).
  const pending = reply.state === 'rascunho' || reply.state === 'falhou';
  let body: ReactNode = null;
  if (pending) {
    body = (
      <ReplyDraftEditor
        reply={reply} jobId={jobId} failedText={<FoldedText text={reply.body} />}
        otherRecipient={origin !== undefined && !sameAddress(reply.toAddress, origin.fromAddress)}
        ids={{
          text: `job-reply-text-${reply.id}`, approve: `job-reply-approve-${reply.id}`, save: `job-reply-save-${reply.id}`,
          discard: `job-reply-discard-${reply.id}`, discardDialog: `job-reply-discard-dialog-${reply.id}`, error: `job-reply-error-${reply.id}`,
        }}
      />
    );
  } else if (reply.state !== 'descartada') body = <FoldedText text={reply.body} />;

  return (
    <div data-testid={`job-reply-${reply.id}`} data-state={reply.state} className="mt-3 space-y-2.5 border-l-2 border-line-strong pl-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <h5 className="mr-0.5 text-xs font-semibold text-ink">Resposta</h5>
        <Badge tone={REPLY_TONE[reply.state]} className="gap-1.5" data-status={reply.state}>
          {reply.state === 'enviando' && <LoaderCircle aria-hidden className="size-3 animate-spin" />}
          {replyStateLabel(reply.state)}
        </Badge>
        <Badge tone="outline">{ORIGIN_LABEL[reply.origin]}</Badge>
      </div>
      {note && (
        <p className={cn('flex items-start gap-1.5 break-words text-xs leading-snug', reply.state === 'falhou' ? 'text-bad' : 'text-muted')}>
          {reply.state === 'falhou' && <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />}
          <span>{note}</span>
        </p>
      )}
      {reply.state !== 'descartada' && !pending && <Recipient reply={reply} origin={origin} />}
      {body}
      {reply.state === 'enviada' && <SentBy approvedBy={origin?.replyApprovedBy ?? null} sentAt={reply.sentAt} />}
    </div>
  );
}

/** "Desfazer movimento" e "Não é desta vaga", cada um com o próprio erro. */
function MessageActions({ m }: { m: MailMessageDto }) {
  const actions = useMessageActions();
  const fail = useFailure();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = actions.undo.isPending || actions.unlink.isPending;
  const undo = async () => {
    setError(null);
    try {
      await actions.undo.mutateAsync(m.id);
    } catch (e) {
      setError(fail(e));
    }
  };
  const unlink = async () => {
    setError(null);
    try {
      await actions.unlink.mutateAsync(m.id);
    } catch (e) {
      setError(fail(e));
    } finally {
      setConfirming(false);
    }
  };
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {m.movedTo && (
          <p className="text-xs text-muted">
            Moveu o card para <span className="text-ink-2">{COLUMN_LABELS[m.movedTo]}</span>{m.corrected ? ' (desfeito)' : ''}.
          </p>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {m.canUndoMove && m.movedTo && (
            <Button type="button" size="sm" data-testid={`job-email-undo-${m.id}`} disabled={busy} onClick={undo}>
              {actions.undo.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />} Desfazer movimento
            </Button>
          )}
          <Button
            type="button" variant="ghost" size="sm" data-testid={`job-email-unlink-${m.id}`} disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Unlink aria-hidden /> Não é desta vaga
          </Button>
        </div>
      </div>
      <InlineError error={error} testId={`job-email-error-${m.id}`} />
      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} title="Tirar este e-mail da vaga?" confirmLabel="Não é desta vaga"
        onConfirm={unlink} busy={actions.unlink.isPending} testId={`job-email-unlink-dialog-${m.id}`}
      >
        <p>A conversa inteira sai deste card. Ela aparece como e-mail sem vaga no sino e no Painel, e dá para ligá-la à vaga certa por lá.</p>
      </ConfirmDialog>
    </div>
  );
}

function MessageItem({ item, jobId }: { item: ConversationItem; jobId: number }) {
  const { message: m, reply, sentReply: sentCopy, origin } = item;
  const incoming = m.direction === 'in';
  return (
    <motion.li
      layout="position" data-testid={`job-email-${m.id}`} data-direction={m.direction}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0 }} transition={spring}
      className={cn(
        'rounded-2xl border px-3.5 py-3',
        incoming ? 'border-line bg-surface-2/50' : 'border-accent/20 bg-accent/6',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {incoming
          ? m.kind && <Badge tone="neutral">{EMAIL_KIND_LABELS[m.kind]}</Badge>
          : <Badge tone="accent">{sentCopy ? 'Resposta enviada' : 'Enviado por você'}</Badge>}
        {m.corrected && <Badge tone="outline">classificação corrigida</Badge>}
        <span className="ml-auto text-[11px] tabular-nums text-faint">{formatWhen(m.sentAt)}</span>
      </div>
      <h4 className="mt-1.5 break-words text-[13px] font-semibold leading-snug text-ink">{m.subject.trim() || '(sem assunto)'}</h4>
      <div className="mb-2 mt-0.5"><Sender m={m} /></div>
      <FoldedText text={m.body} />
      {sentCopy && <div className="mt-1.5"><SentBy approvedBy={origin?.replyApprovedBy ?? null} sentAt={null} /></div>}
      {incoming && <MessageActions m={m} />}
      {reply && <ReplyBlock reply={reply} origin={m} jobId={jobId} />}
    </motion.li>
  );
}

/**
 * Seção "E-mails" do painel da vaga: a conversa em ordem (recebidos e enviados) com a resposta de cada recebido logo
 * abaixo dele. Some quando a vaga não tem e-mail.
 */
export function JobEmailSection({ job, index }: { job: JobDto; index: number }) {
  const titleId = useId();
  const { data } = useJobEmails(job.id);
  if (!data || data.messages.length === 0) return null;

  const { messages } = data;
  // Uma resposta enviada que já voltou como e-mail de saída aparece uma vez só, no lugar do e-mail de saída.
  const items = emailConversation(data);

  return (
    <motion.section
      data-testid="job-emails" aria-labelledby={titleId}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 + index * 0.04 }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={titleId} className={EYEBROW}>E-mails</h3>
        <span className="text-[11px] tabular-nums text-faint">{messages.length} {messages.length === 1 ? 'e-mail' : 'e-mails'}</span>
      </div>
      <ol className="space-y-2.5">
        <AnimatePresence initial={false}>
          {items.map((item) => <MessageItem key={item.message.id} item={item} jobId={job.id} />)}
        </AnimatePresence>
      </ol>
    </motion.section>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, Paperclip, RotateCcw, Save, Send, TriangleAlert, Unlink } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  COLUMN_LABELS, DRAFT_PLACEHOLDER, EMAIL_KIND_LABELS, MAIL_LIMITS, type JobDto, type MailMessageDto, type MailReplyDto, type ReplyState,
} from '@kv/shared/client';
import { replyStateLabel } from '../lib/email';
import { spring } from '../lib/motion';
import { EYEBROW } from '../lib/styles';
import { cn } from '../lib/utils';
import { useJobEmails, useMessageActions, useReplyActions } from '../useEmail';
import { formatWhen } from './JobApplicationSection';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Textarea } from './ui/input';
import { Notice } from './ui/notice';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'outline';
const REPLY_TONE: Record<ReplyState, Tone> = {
  rascunho: 'warn', aprovada: 'accent', enviando: 'accent', enviada: 'ok', falhou: 'bad', descartada: 'outline',
};
const ORIGIN_LABEL = { ai: 'escrita pela IA', facts: 'com seus dados salvos' } as const;
const GAP_HINT = 'Preencha os trechos entre colchetes duplos.';

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

/** Uma resposta enviada pelo app volta como e-mail de saída com o mesmo texto: os dois são uma coisa só na conversa. */
function sentCopyOf(m: MailMessageDto, replies: MailReplyDto[]): MailReplyDto | undefined {
  if (m.direction !== 'out') return undefined;
  return replies.find((r) => r.state === 'enviada' && r.body.trim() === m.body.trim() && sameAddress(r.toAddress, m.toAddress));
}

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

/** Rascunho: o texto numa caixa que cresce, "Salvar edição", "Aprovar e enviar" (sem lacunas e sem edição pendente) e "Descartar". */
function DraftEditor({ reply }: { reply: MailReplyDto }) {
  const actions = useReplyActions();
  const fail = useFailure();
  const hintId = useId();
  const [text, setText] = useState(reply.body);
  const [base, setBase] = useState(reply.body);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // O texto do servidor mudou (outra tela, outra aba) e não há edição aqui: a caixa acompanha.
  if (reply.body !== base && text === base) {
    setBase(reply.body);
    setText(reply.body);
  }
  const dirty = text !== base;
  const empty = text.trim() === '';
  const gap = DRAFT_PLACEHOLDER.test(text);
  const busy = actions.edit.isPending || actions.approve.isPending || actions.discard.isPending;
  const hint = empty ? 'Escreva o texto da resposta.' : gap ? GAP_HINT : dirty ? 'Salve a edição antes de enviar.' : null;

  const save = async () => {
    setError(null);
    try {
      const saved = await actions.edit.mutateAsync({ id: reply.id, body: text });
      setBase(saved.body);
      setText(saved.body);
    } catch (e) {
      setError(fail(e));
    }
  };
  const approve = async () => {
    setError(null);
    try {
      await actions.approve.mutateAsync(reply.id);
    } catch (e) {
      setError(fail(e));
    }
  };
  const discard = async () => {
    setError(null);
    try {
      await actions.discard.mutateAsync(reply.id);
    } catch (e) {
      setError(fail(e));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <Textarea
        value={text} onChange={(e) => setText(e.target.value)} maxLength={MAIL_LIMITS.draftChars} disabled={busy}
        aria-label="Texto da resposta" aria-describedby={hint ? hintId : undefined} aria-invalid={gap || undefined}
        data-testid={`job-reply-text-${reply.id}`} className="min-h-28 bg-bg/40"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="primary" size="sm" data-testid={`job-reply-approve-${reply.id}`}
          disabled={busy || hint !== null} aria-describedby={hint ? hintId : undefined} onClick={approve}
        >
          {actions.approve.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />} Aprovar e enviar
        </Button>
        <Button type="button" size="sm" data-testid={`job-reply-save-${reply.id}`} disabled={busy || !dirty || empty} onClick={save}>
          {actions.edit.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Save aria-hidden />} Salvar edição
        </Button>
        <Button
          type="button" variant="danger" size="sm" data-testid={`job-reply-discard-${reply.id}`} disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Descartar
        </Button>
        {hint && <p id={hintId} className="min-w-40 flex-1 text-xs leading-snug text-faint">{hint}</p>}
      </div>
      <InlineError error={error} testId={`job-reply-error-${reply.id}`} />
      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} title="Descartar esta resposta?" confirmLabel="Descartar"
        onConfirm={discard} busy={actions.discard.isPending} testId={`job-reply-discard-dialog-${reply.id}`}
      >
        <p>Nada é enviado à empresa. Para responder depois, escreva do seu próprio e-mail.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Uma resposta que falhou: o motivo, o texto e "Aprovar e enviar" de novo. */
function FailedReply({ reply }: { reply: MailReplyDto }) {
  const { approve } = useReplyActions();
  const fail = useFailure();
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setError(null);
    try {
      await approve.mutateAsync(reply.id);
    } catch (e) {
      setError(fail(e));
    }
  };
  return (
    <div className="space-y-2.5">
      <FoldedText text={reply.body} />
      <Button type="button" variant="primary" size="sm" data-testid={`job-reply-approve-${reply.id}`} disabled={approve.isPending} onClick={retry}>
        {approve.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />} Aprovar e enviar
      </Button>
      <InlineError error={error} testId={`job-reply-error-${reply.id}`} />
    </div>
  );
}

/** A resposta preparada para um e-mail recebido, presa a ele por um fio à esquerda. */
function ReplyBlock({ reply, origin }: { reply: MailReplyDto; origin: MailMessageDto | undefined }) {
  const note = reply.note?.trim() || null;
  let body: ReactNode = null;
  if (reply.state === 'rascunho') body = <DraftEditor reply={reply} />;
  else if (reply.state === 'falhou') body = <FailedReply reply={reply} />;
  else if (reply.state !== 'descartada') body = <FoldedText text={reply.body} />;

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
      {reply.state !== 'descartada' && <Recipient reply={reply} origin={origin} />}
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
      setConfirming(false);
    }
  };
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {m.movedTo && (
          <p className="text-xs text-muted">Moveu o card para <span className="text-ink-2">{COLUMN_LABELS[m.movedTo]}</span>.</p>
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
        <p>A conversa inteira sai deste card e passa a aparecer como e-mail sem vaga no Painel, onde dá para ligá-la à vaga certa.</p>
      </ConfirmDialog>
    </div>
  );
}

function MessageItem({ m, reply, sentCopy, origin }: {
  m: MailMessageDto; reply: MailReplyDto | undefined; sentCopy: MailReplyDto | undefined; origin: MailMessageDto | undefined;
}) {
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
      {reply && <ReplyBlock reply={reply} origin={m} />}
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

  const { messages, replies } = data;
  const byId = new Map(messages.map((m) => [m.id, m]));
  // Uma resposta enviada que já voltou como e-mail de saída aparece uma vez só, no lugar do e-mail de saída.
  const copies = new Map<number, MailReplyDto>();
  const shownAsCopy = new Set<number>();
  for (const m of messages) {
    const r = sentCopyOf(m, replies.filter((x) => !shownAsCopy.has(x.id)));
    if (r) {
      copies.set(m.id, r);
      shownAsCopy.add(r.id);
    }
  }
  const replyOf = new Map(replies.filter((r) => !shownAsCopy.has(r.id)).map((r) => [r.messageId, r]));

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
          {messages.map((m) => {
            const copy = copies.get(m.id);
            return (
              <MessageItem
                key={m.id} m={m} reply={replyOf.get(m.id)} sentCopy={copy} origin={copy ? byId.get(copy.messageId) : undefined}
              />
            );
          })}
        </AnimatePresence>
      </ol>
    </motion.section>
  );
}

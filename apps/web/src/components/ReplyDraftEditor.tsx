import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Paperclip, Save, Send, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { MAIL_LIMITS, type JobEmailsDto, type MailReplyDto } from '@kv/shared/client';
import { draftGate } from '../lib/email';
import { EMAIL_KEYS, useReplyActions } from '../useEmail';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Textarea } from './ui/input';
import { Notice } from './ui/notice';

/** Os `data-testid` de cada tela (o sino e o painel da vaga têm os seus). */
export interface ReplyDraftIds {
  text: string;
  approve: string;
  save: string;
  discard: string;
  /** Prefixo da caixa de confirmação do descarte e dos seus dois botões. */
  discardDialog: string;
  error: string;
  recipient?: string;
}

interface ReplyDraftEditorProps {
  /** Uma resposta em `rascunho` (editável) ou `falhou` (o texto guardado, para aprovar de novo ou descartar). */
  reply: MailReplyDto;
  /** A vaga da resposta: a edição salva entra no cache da conversa dela. */
  jobId: number;
  ids: ReplyDraftIds;
  /** O destinatário não é quem escreveu: diz isso com o endereço, no lugar do "Para:". */
  otherRecipient: boolean;
  /** Como o texto de uma resposta que falhou aparece (o painel da vaga dobra textos longos). */
  failedText?: ReactNode;
  /** Outra ação da tela em curso: os botões esperam. */
  disabled?: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Não foi possível concluir. Tente de novo.');

/**
 * O rascunho de uma resposta, igual no sino e no painel da vaga: o texto numa caixa que cresce, "Salvar edição",
 * "Aprovar e enviar" e "Descartar" com confirmação. "Aprovar e enviar" só liga quando a caixa mostra exatamente o texto
 * guardado e sem lacuna (`draftGate`): o que o dono vê é o que sai.
 */
export function ReplyDraftEditor({ reply, jobId, ids, otherRecipient, failedText, disabled = false }: ReplyDraftEditorProps) {
  const qc = useQueryClient();
  const actions = useReplyActions();
  const hintId = useId();
  /** null: o dono não mexeu, a caixa mostra o texto guardado. */
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const editable = reply.state === 'rascunho';
  // A caixa e a regra olham o mesmo texto, sempre.
  const value = editable ? (text ?? reply.body) : reply.body;
  const gate = draftGate(reply.body, value);
  const busy = disabled || actions.edit.isPending || actions.approve.isPending || actions.discard.isPending;

  /** Uma recusa costuma querer dizer que o estado mudou: a conversa é relida e o erro fica à vista. */
  const fail = (e: unknown) => {
    void qc.invalidateQueries({ queryKey: ['email', 'job'] });
    setError(messageOf(e));
  };

  const save = async () => {
    setError(null);
    try {
      const saved = await actions.edit.mutateAsync({ id: reply.id, body: value });
      // O texto guardado entra no cache antes de a caixa largar o texto local: ela nunca volta ao texto antigo.
      qc.setQueryData<JobEmailsDto>(EMAIL_KEYS.job(jobId), (old) =>
        old && { ...old, replies: old.replies.map((r) => (r.id === saved.id ? saved : r)) });
      setText(null);
    } catch (e) {
      fail(e);
    }
  };
  const approve = async () => {
    setError(null);
    try {
      await actions.approve.mutateAsync(reply.id);
    } catch (e) {
      fail(e);
    }
  };
  const discard = async () => {
    setError(null);
    try {
      await actions.discard.mutateAsync(reply.id);
    } catch (e) {
      fail(e);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        {otherRecipient ? (
          <p data-testid={ids.recipient} className="flex items-start gap-1.5 break-words text-xs leading-snug text-warn">
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
      {editable ? (
        <Textarea
          value={value} onChange={(e) => setText(e.target.value)} maxLength={MAIL_LIMITS.draftChars} disabled={busy}
          aria-label="Texto da resposta" aria-describedby={gate.hint ? hintId : undefined} aria-invalid={gate.gap || undefined}
          data-testid={ids.text} className="min-h-28 bg-bg/40"
        />
      ) : (
        failedText ?? <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{reply.body}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="primary" size="sm" data-testid={ids.approve}
          disabled={busy || !gate.canApprove} aria-describedby={gate.hint ? hintId : undefined} onClick={approve}
        >
          {actions.approve.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />} Aprovar e enviar
        </Button>
        {editable && (
          <Button type="button" size="sm" data-testid={ids.save} disabled={busy || !gate.unsaved || gate.empty} onClick={save}>
            {actions.edit.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Save aria-hidden />} Salvar edição
          </Button>
        )}
        <Button type="button" variant="danger" size="sm" data-testid={ids.discard} disabled={busy} onClick={() => setConfirming(true)}>
          Descartar
        </Button>
        {gate.hint && <p id={hintId} className="min-w-40 flex-1 text-xs leading-snug text-faint">{gate.hint}</p>}
      </div>
      {error && <Notice tone="bad" role="alert" data-testid={ids.error}>{error}</Notice>}
      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} title="Descartar esta resposta?" confirmLabel="Descartar"
        onConfirm={discard} busy={actions.discard.isPending} testId={ids.discardDialog}
      >
        <p>Nada é enviado à empresa. Para responder depois, escreva do seu próprio e-mail.</p>
      </ConfirmDialog>
    </div>
  );
}

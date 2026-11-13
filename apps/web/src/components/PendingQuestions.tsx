import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LoaderCircle, Undo2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import type { AnswerScope, AnswerValue, ApplicationDto, PendingQuestion, Question } from '@kv/shared/client';
import {
  ANSWER_SOURCE_LABELS, PENDING_KIND_LABELS, PROPOSAL_HINTS, SCOPE_LABELS, answerText, editPendingDraft, emptyAnswerValue,
  initialPendingDraft, pendingErrorFor, toPendingAnswersBody, validatePendingDrafts, type PendingDraft,
} from '../lib/apply';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { APPLY_KEYS, useApplyActions } from '../useApply';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { Input, Textarea, fieldClass } from './ui/input';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';

const SCOPES: readonly AnswerScope[] = ['always', 'company', 'job'];
const fieldId = (applicationId: number, questionId: string) => `pending-${applicationId}-${questionId}`;

interface FieldProps {
  id: string;
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  labelledBy: string;
  describedBy?: string;
  invalid: boolean;
}

/** O campo certo para o tipo da pergunta. Texto cresce com o conteúdo (nunca rola por dentro). */
function AnswerField({ id, question, value, onChange, labelledBy, describedBy, invalid }: FieldProps) {
  const testId = `pending-answer-${question.id}`;
  const common = { id, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined, 'data-testid': testId };
  const text = typeof value === 'string' ? value : '';

  if (question.kind === 'file') {
    return <p className="text-[13px] text-muted">Esta pergunta pede um arquivo: responda direto no site da vaga.</p>;
  }
  if (question.kind === 'multiselect') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div role="group" {...common} tabIndex={-1} className="flex flex-wrap gap-1.5 rounded-lg focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45">
        {question.options.map((o) => (
          <CheckChip
            key={o} label={o} checked={picked.includes(o)}
            onCheckedChange={(on) => onChange(on ? [...picked, o] : picked.filter((x) => x !== o))}
          />
        ))}
      </div>
    );
  }
  if (question.options.length > 0) {
    return (
      <select {...common} value={text} onChange={(e) => onChange(e.target.value)} className={cn(fieldClass, 'h-10 cursor-pointer px-3')}>
        <option value="" disabled>Escolha uma opção</option>
        {question.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (question.kind === 'boolean') {
    const current = value === true ? 'yes' : value === false ? 'no' : '';
    return (
      <div data-testid={testId} id={id} aria-describedby={describedBy} tabIndex={-1} className="w-44 max-w-full rounded-xl focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45">
        <Segmented<'yes' | 'no' | ''>
          aria-labelledby={labelledBy} value={current} onValueChange={(v) => onChange(v === 'yes')}
          options={[{ value: 'yes', label: 'Sim' }, { value: 'no', label: 'Não' }]}
          className={cn('w-full', invalid && 'border-bad/60')}
        />
      </div>
    );
  }
  if (question.kind === 'number') {
    return (
      <Input
        {...common} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => onChange(e.target.value)}
        placeholder="Só os dígitos, por exemplo 8000" className="max-w-60 tabular-nums"
      />
    );
  }
  if (question.kind === 'date') {
    return <Input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} className="max-w-52" />;
  }
  return (
    <Textarea
      {...common} value={text} onChange={(e) => onChange(e.target.value)} maxLength={question.maxLength ?? undefined}
      rows={question.kind === 'longtext' ? 3 : 1}
      className={question.kind === 'longtext' ? 'min-h-24' : 'min-h-10 py-2'}
    />
  );
}

function ScopeChoice({ questionId, value, onChange }: { questionId: string; value: AnswerScope; onChange: (s: AnswerScope) => void }) {
  const labelId = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid={`pending-scope-${questionId}`}>
      <span id={labelId} className="text-xs text-muted">Guardar esta resposta para</span>
      <Segmented
        aria-labelledby={labelId} value={value} onValueChange={onChange}
        options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))}
        className="p-0.5 [&>button]:h-8 [&>button]:px-2.5 [&>button]:text-xs"
      />
    </div>
  );
}

/** Um bloco rotulado de "resposta salva" / "resposta para esta pergunta". */
function Quote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{children}</div>
    </div>
  );
}

interface ItemProps {
  applicationId: number;
  pending: PendingQuestion;
  draft: PendingDraft;
  onDraft: (draft: PendingDraft) => void;
  error: string | undefined;
}

function PendingItem({ applicationId, pending, draft, onDraft, error }: ItemProps) {
  const labelId = useId();
  const helpId = useId();
  const errorId = useId();
  const q = pending.question;
  const proposal = pending.proposal;
  const id = fieldId(applicationId, q.id);
  const describedBy = [q.help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const field = (
    <AnswerField
      id={id} question={q} value={draft.value} labelledBy={labelId} describedBy={describedBy} invalid={!!error}
      onChange={(value) => onDraft(editPendingDraft(pending, draft, value))}
    />
  );
  // Em `confirm_match`, "Não é; responder" troca o aceite por uma resposta do dono, como numa pergunta sem resposta.
  const answering = pending.kind === 'unanswered' || (pending.kind === 'confirm_match' && !draft.accept);

  return (
    <div role="group" aria-labelledby={labelId} data-testid={`pending-${q.id}`} className="space-y-3 rounded-2xl border border-line bg-surface-2/50 p-3.5">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p id={labelId} className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-snug text-ink">
            {q.label}
            {!q.required && <span className="ml-1.5 font-normal text-muted">(opcional)</span>}
          </p>
          <Badge tone={pending.kind === 'unanswered' ? 'warn' : 'accent'}>{PENDING_KIND_LABELS[pending.kind]}</Badge>
        </div>
        {q.help && <p id={helpId} className="mt-0.5 break-words text-xs leading-snug text-muted">{q.help}</p>}
      </div>

      {pending.kind === 'confirm_match' && proposal && (
        <>
          <div className="grid gap-3 rounded-xl border border-line bg-bg/40 p-3 sm:grid-cols-2">
            <Quote label="Sua resposta salva">
              <span className="block text-muted">{proposal.bankQuestion ?? '—'}</span>
              {proposal.bankAnswer?.trim() || '—'}
            </Quote>
            <Quote label="Resposta para esta pergunta">{answerText(proposal.value)}</Quote>
          </div>
          <div data-testid={`pending-match-${q.id}`}>
            <Segmented<'accept' | 'answer'>
              aria-labelledby={labelId} value={draft.accept ? 'accept' : 'answer'}
              onValueChange={(v) => onDraft(v === 'accept'
                ? initialPendingDraft(pending)
                : { questionId: q.id, accept: false, value: emptyAnswerValue(q), scope: 'always' })}
              options={[{ value: 'accept', label: 'É a mesma' }, { value: 'answer', label: 'Não é; responder' }]}
              className="w-full max-w-80"
            />
          </div>
        </>
      )}

      {pending.kind === 'confirm_proposal' && proposal && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Origem:</span>
          <Badge tone="outline">{ANSWER_SOURCE_LABELS[proposal.source]}</Badge>
          {!draft.accept && (
            <Button
              type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs"
              onClick={() => onDraft(initialPendingDraft(pending))}
            >
              <Undo2 aria-hidden /> Voltar à proposta
            </Button>
          )}
        </div>
      )}

      {(answering || pending.kind === 'confirm_proposal') && field}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key="error" id={errorId} role="alert" data-testid={`pending-error-${q.id}`}
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}
            className="-mt-1.5 text-xs font-medium text-bad"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {pending.kind === 'confirm_proposal' && proposal && (
        <p className="text-xs leading-snug text-faint">{proposal.source === 'written' ? PROPOSAL_HINTS.written : PROPOSAL_HINTS.profile}</p>
      )}
      {answering && q.kind !== 'file' && <ScopeChoice questionId={q.id} value={draft.scope} onChange={(scope) => onDraft({ ...draft, scope })} />}
    </div>
  );
}

/** As pendências de uma candidatura, com resposta ali mesmo. Usado na aba e no painel da vaga. */
export function PendingQuestions({ application }: { application: ApplicationDto }) {
  const qc = useQueryClient();
  const { answer } = useApplyActions();
  const [drafts, setDrafts] = useState<Record<string, PendingDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = application.pendingQuestions;
  const draftFor = (p: PendingQuestion) => drafts[p.question.id] ?? initialPendingDraft(p);

  function setDraft(draft: PendingDraft) {
    setDrafts((prev) => ({ ...prev, [draft.questionId]: draft }));
    setErrors((prev) => {
      if (!(draft.questionId in prev)) return prev;
      const { [draft.questionId]: _, ...rest } = prev;
      return rest;
    });
    setFormError(null);
    setSaved(false);
  }

  function submit() {
    const list = pending.map(draftFor);
    const found = validatePendingDrafts(pending, list);
    setErrors(found);
    setFormError(null);
    const first = pending.find((p) => found[p.question.id]);
    if (first) {
      document.getElementById(fieldId(application.id, first.question.id))?.focus();
      return;
    }
    answer.mutate({ id: application.id, body: toPendingAnswersBody(list) }, {
      // A candidatura devolvida é a verdade: se ainda falta alguma obrigatória, o formulário segue com o que resta.
      onSuccess: (dto) => {
        qc.setQueryData(APPLY_KEYS.job(dto.jobId), dto);
        setDrafts({});
        setSaved(true);
      },
      onError: (e) => {
        const hit = pendingErrorFor(pending, e.message);
        if (hit) setErrors({ [hit.questionId]: hit.text });
        else setFormError(e.message);
      },
    });
  }

  if (pending.length === 0) return null;

  return (
    <form
      noValidate data-testid="pending-questions" className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        {pending.length === 1
          ? 'Uma pergunta do formulário espera você.'
          : `${pending.length} perguntas do formulário esperam você.`}{' '}
        As respostas ficam salvas para as próximas candidaturas no alcance que você escolher.
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        {pending.map((p) => (
          <motion.div
            key={p.question.id} layout="position"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={spring}
          >
            <PendingItem applicationId={application.id} pending={p} draft={draftFor(p)} onDraft={setDraft} error={errors[p.question.id]} />
          </motion.div>
        ))}
      </AnimatePresence>
      {formError && <Notice tone="bad" role="alert">{formError}</Notice>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <Button type="submit" variant="primary" data-testid="pending-submit" disabled={answer.isPending}>
          {answer.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <CircleCheck aria-hidden />}
          Responder e continuar
        </Button>
        <p aria-live="polite" className="text-xs text-muted">
          {saved && 'Respostas salvas. Falta responder o que ficou acima.'}
        </p>
      </div>
    </form>
  );
}

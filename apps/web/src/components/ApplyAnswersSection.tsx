import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, CloudOff, Plus, RotateCw, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { ApplyAnswerDto } from '@kv/shared/client';
import type { ApplyAnswerInput } from '../applyApi';
import {
  ANSWER_LIMITS, BOOLEAN_LABELS, EMPTY_NEW_ANSWER, NEW_ANSWER_KIND_LABELS, answerField, answerInput, answerProblem, answerToStore,
  booleanAnswer, booleanChoice, counterVisible, countryLabel, kindHint, newAnswerInput, saveStateLabel, scopeLabel, splitAnswers, usedLabel,
  validateNewAnswer, type BooleanChoice, type NewAnswerDraft, type NewAnswerKind, type SaveStatus,
} from '../lib/apply';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { APPLY_KEYS, useApplyActions, useApplyAnswers } from '../useApply';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { Input, Textarea } from './ui/input';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';

const CARD = 'rounded-3xl border border-line bg-surface/85 shadow-raised';
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
/** Linha de pergunta + campo: a pergunta à esquerda, a resposta à direita (empilhadas em tela estreita). */
const ROW_GRID = 'grid gap-x-8 gap-y-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]';
const FIELD_TEXT = 'min-h-10 py-2';

const messageOf = (e: unknown) => {
  const text = e instanceof Error && e.message ? e.message : 'Não foi possível salvar. Tente de novo.';
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

type SaveFn = (id: number | undefined, input: ApplyAnswerInput) => Promise<ApplyAnswerDto>;

/**
 * O campo de uma resposta já guardada: guarda sozinho ao sair do campo (ou ao escolher Sim/Não), só se mudou, e mostra
 * o estado como as notas da vaga. Com erro o texto digitado continua no campo.
 */
function useAnswerEditor(row: ApplyAnswerDto, save: SaveFn) {
  /** O que está no campo; `null` enquanto ele só mostra o que o servidor tem. */
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sending = useRef<string | null>(null);
  const value = draft ?? row.answer;
  const dirty = draft !== null && answerToStore(row.kind, draft) !== row.answer;

  async function commit(next: string = value) {
    const problem = answerProblem(row.kind, next);
    if (problem) {
      setStatus('error');
      setError(problem);
      return;
    }
    const stored = answerToStore(row.kind, next);
    if (stored === row.answer) {
      // Nada mudou (ou voltou ao que estava): não há o que enviar.
      setDraft(null);
      if (status === 'error') setStatus('idle');
      setError(null);
      return;
    }
    if (sending.current === stored) return;
    sending.current = stored;
    setStatus('saving');
    setError(null);
    try {
      await save(row.id, answerInput(row, stored));
      // Se a pessoa já digitou mais, o que ela digitou fica.
      setDraft((d) => (d === next ? null : d));
      setStatus('saved');
    } catch (e) {
      setStatus('error');
      setError(messageOf(e));
    } finally {
      sending.current = null;
    }
  }

  return {
    value, status, error, dirty, commit,
    edit: (text: string) => {
      setDraft(text);
      if (status === 'error') {
        setStatus('idle');
        setError(null);
      }
    },
    choose: (choice: BooleanChoice) => {
      const text = booleanAnswer(choice);
      setDraft(text);
      void commit(text);
    },
  };
}

type Editor = ReturnType<typeof useAnswerEditor>;

interface FieldProps {
  kind: ApplyAnswerDto['kind'];
  value: string;
  onChange: (value: string) => void;
  onChoose?: (choice: BooleanChoice) => void;
  onBlur?: () => void;
  id: string;
  /** Rótulo de quem não tem `<label>` própria (o grupo Sim/Não). */
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** O campo certo para o tipo: Sim/Não/sem resposta, número ou texto que cresce com o conteúdo. */
function AnswerFieldInput({ kind, value, onChange, onChoose, onBlur, id, labelledBy, describedBy, invalid, testId, disabled, placeholder }: FieldProps) {
  const field = answerField(kind);
  if (field === 'boolean') {
    return (
      <div data-testid={testId} id={id} className={cn(disabled && 'pointer-events-none opacity-50')}>
        <Segmented
          aria-labelledby={labelledBy} value={booleanChoice(value)} onValueChange={(choice) => onChoose?.(choice)}
          options={(['yes', 'no', 'none'] as const).map((c) => ({ value: c, label: BOOLEAN_LABELS[c], ariaLabel: BOOLEAN_LABELS[c] }))}
        />
      </div>
    );
  }
  if (field === 'number') {
    return (
      <Input
        id={id} data-testid={testId} type="text" inputMode="decimal" autoComplete="off" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        maxLength={24} placeholder={placeholder ?? 'ex.: 8000'} aria-invalid={invalid || undefined} aria-describedby={describedBy}
        className="tabular-nums"
      />
    );
  }
  return (
    <Textarea
      id={id} data-testid={testId} value={value} disabled={disabled} rows={1} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
      maxLength={ANSWER_LIMITS.answer} placeholder={placeholder} aria-invalid={invalid || undefined} aria-describedby={describedBy}
      className={FIELD_TEXT}
    />
  );
}

/** Sob o campo: o erro (com o texto preservado) à esquerda; o estado do salvamento e o contador à direita. */
function FieldFoot({ editor, id, kind }: { editor: Editor; id: string; kind: ApplyAnswerDto['kind'] }) {
  const failed = editor.status === 'error';
  const length = editor.value.length;
  const showCounter = answerField(kind) === 'text' && counterVisible(length, ANSWER_LIMITS.answer);
  const label = saveStateLabel(editor.status, editor.dirty);
  return (
    <div className="mt-1.5 flex min-h-4 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {failed && (
          <p id={id} role="alert" className="text-xs leading-snug text-bad">
            {editor.error} <span className="text-muted">Seu texto continua aqui.</span>{' '}
            {!answerProblem(kind, editor.value) && (
              <button type="button" onClick={() => void editor.commit()} className="cursor-pointer rounded-sm font-medium text-accent underline-offset-2 hover:underline">
                Tentar de novo
              </button>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 text-[11px] tabular-nums">
        {showCounter && (
          <span className={length >= ANSWER_LIMITS.answer ? 'text-warn' : 'text-faint'}>
            {length.toLocaleString('pt-BR')} / {ANSWER_LIMITS.answer.toLocaleString('pt-BR')}
            {length >= ANSWER_LIMITS.answer && ' (limite)'}
          </span>
        )}
        <span aria-live="polite" className={failed ? 'text-bad' : 'text-faint'}>{label}</span>
      </div>
    </div>
  );
}

/** O campo editável de uma resposta guardada, com o estado do salvamento. */
function AnswerEditor({ row, save, labelId, testId, fieldId }: { row: ApplyAnswerDto; save: SaveFn; labelId: string; testId: string; fieldId: string }) {
  const editor = useAnswerEditor(row, save);
  const errorId = useId();
  const failed = editor.status === 'error';
  return (
    <div className="min-w-0">
      <AnswerFieldInput
        kind={row.kind} value={editor.value} id={fieldId} labelledBy={labelId} testId={testId}
        onChange={editor.edit} onChoose={editor.choose} onBlur={() => void editor.commit()}
        invalid={failed} describedBy={failed ? errorId : undefined}
      />
      <FieldFoot editor={editor} id={errorId} kind={row.kind} />
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="text-xs text-faint">{children}</span>;
}

/** Uma pergunta comum: a pergunta e o campo da resposta. Vazio quer dizer "ainda não respondida". */
function CommonRow({ row, save }: { row: ApplyAnswerDto; save: SaveFn }) {
  const labelId = useId();
  const fieldId = useId();
  const country = countryLabel(row.country);
  const hint = kindHint(row.kind);
  const Label = answerField(row.kind) === 'boolean' ? 'p' : 'label';
  return (
    <li data-testid={`apply-answer-row-${row.key}`} className={cn(ROW_GRID, 'py-4')}>
      <div className="min-w-0">
        <Label id={labelId} {...(Label === 'label' ? { htmlFor: fieldId } : {})} className="block break-words text-sm font-medium leading-snug text-ink">
          {row.question}
        </Label>
        {(country || hint) && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {country && <Badge tone="outline">{country}</Badge>}
            {hint && <Meta>{hint}</Meta>}
          </p>
        )}
      </div>
      <AnswerEditor row={row} save={save} labelId={labelId} fieldId={fieldId} testId={`apply-answer-${row.key}`} />
    </li>
  );
}

/** Uma resposta aprendida: pergunta, alcance, uso, a resposta editável, as variações confirmadas e o apagar com confirmação. */
function LearnedRow({ row, save }: { row: ApplyAnswerDto; save: SaveFn }) {
  const { deleteAnswer, removeAlias } = useApplyActions();
  const labelId = useId();
  const fieldId = useId();
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const country = countryLabel(row.country);
  const hint = kindHint(row.kind);
  const Label = answerField(row.kind) === 'boolean' ? 'p' : 'label';

  async function remove() {
    setDeleteError(null);
    try {
      await deleteAnswer.mutateAsync(row.id);
    } catch (e) {
      setDeleteError(messageOf(e));
    }
  }

  async function undo(normalized: string) {
    setAliasError(null);
    try {
      await removeAlias.mutateAsync({ id: row.id, normalized });
    } catch (e) {
      setAliasError(messageOf(e));
    }
  }

  return (
    <motion.li
      layout="position" data-testid={`apply-learned-${row.id}`}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, overflow: 'hidden' }} transition={spring}
      className={cn(ROW_GRID, 'py-4')}
    >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <Label id={labelId} {...(Label === 'label' ? { htmlFor: fieldId } : {})} className="block min-w-0 flex-1 break-words text-sm font-medium leading-snug text-ink">
            {row.question}
          </Label>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Badge tone="neutral">{scopeLabel(row.scope, row.scopeValue)}</Badge>
          {country && <Badge tone="outline">{country}</Badge>}
          <Meta>{usedLabel(row.usedCount)}</Meta>
        </p>
        {hint && <p className="mt-1.5 text-xs text-faint">{hint}</p>}
        <Button
          type="button" variant="ghost" size="sm" data-testid={`apply-learned-delete-${row.id}`} disabled={confirming}
          aria-label={`Apagar a resposta para: ${row.question}`} onClick={() => setConfirming(true)}
          className="-ml-2 mt-2 text-muted hover:bg-bad/12 hover:text-bad"
        >
          <Trash2 aria-hidden /> Apagar
        </Button>
      </div>
      <AnswerEditor row={row} save={save} labelId={labelId} fieldId={fieldId} testId={`apply-learned-answer-${row.id}`} />

      <AnimatePresence initial={false}>
        {row.aliases.length > 0 && (
          <motion.div
            key="aliases" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring}
            className="rounded-2xl border border-line bg-bg/40 px-3.5 py-3 md:col-span-2"
          >
            <p className={EYEBROW}>Variações confirmadas</p>
            <ul className="mt-1 divide-y divide-line/70">
              {row.aliases.map((a) => (
                <li key={a.normalized} data-testid={`apply-alias-${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-1.5 last:pb-0.5">
                  <p className="min-w-48 flex-1 break-words text-[13px] leading-snug text-ink-2">
                    <span className="text-muted">“{a.normalized}”</span> recebe <span className="font-medium text-ink">{a.value || 'sem resposta'}</span>
                    {a.options.length > 0 && <span className="text-faint"> · opções: {a.options.join(', ')}</span>}
                  </p>
                  <Button
                    type="button" variant="ghost" size="sm" disabled={removeAlias.isPending} onClick={() => void undo(a.normalized)}
                    aria-label={`Desfazer a variação “${a.normalized}”`}
                    className="-mr-1.5"
                  >
                    <RotateCw aria-hidden /> Desfazer
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs leading-snug text-faint">Se você mudar a resposta, as variações precisam ser confirmadas de novo.</p>
            {aliasError && <p role="alert" className="mt-1.5 text-xs leading-snug text-bad">{aliasError}</p>}
          </motion.div>
        )}
        {confirming && (
          <motion.div
            key="confirm" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}
            className="-mx-1 overflow-hidden px-1 md:col-span-2"
          >
            <Notice
              tone="warn" role="alert" data-testid={`apply-learned-confirm-${row.id}`} title="Apagar esta resposta?"
              action={
                <>
                  <Button type="button" variant="danger" size="sm" disabled={deleteAnswer.isPending} onClick={() => void remove()} data-testid={`apply-learned-confirm-delete-${row.id}`}>
                    <Trash2 aria-hidden /> {deleteAnswer.isPending ? 'Apagando…' : 'Apagar'}
                  </Button>
                  <Button type="button" size="sm" autoFocus onClick={() => { setConfirming(false); setDeleteError(null); }}>Cancelar</Button>
                </>
              }
            >
              <p>A próxima candidatura que pedir isso vai parar e perguntar a você de novo. As variações confirmadas também somem.</p>
              {deleteError && <p className="mt-1 text-bad">{deleteError}</p>}
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** Rótulo + controle do formulário de nova resposta. */
function FormField({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">{label}</label>
      <div className="mt-1.5">{children}</div>
      {error ? <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs leading-snug text-bad">{error}</p> : hint}
    </div>
  );
}

function NewAnswerForm({ save, onDone }: { save: SaveFn; onDone: () => void }) {
  const [draft, setDraft] = useState<NewAnswerDraft>(EMPTY_NEW_ANSWER);
  const [errors, setErrors] = useState<ReturnType<typeof validateNewAnswer>>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const ids = { question: useId(), answer: useId(), kind: useId(), scope: useId(), company: useId() };
  const set = (patch: Partial<NewAnswerDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k as keyof typeof next];
      if ('kind' in patch) delete next.answer;
      return next;
    });
  };

  async function submit() {
    const found = validateNewAnswer(draft);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await save(undefined, newAnswerInput(draft));
      onDone();
    } catch (e) {
      setServerError(messageOf(e));
      setSaving(false);
    }
  }

  return (
    <motion.form
      key="new" data-testid="apply-answer-new" noValidate aria-label="Adicionar resposta"
      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="-mx-1 overflow-hidden px-1"
    >
      <div className="mb-1 mt-3 grid gap-4 rounded-2xl border border-line bg-bg/40 p-4 sm:p-5">
        <FormField id={ids.question} label="Pergunta" error={errors.question}
          hint={counterVisible(draft.question.length, ANSWER_LIMITS.question) && (
            <p className="mt-1.5 text-right text-[11px] tabular-nums text-faint">{draft.question.length} / {ANSWER_LIMITS.question}</p>
          )}>
          <Textarea
            id={ids.question} data-testid="apply-answer-new-question" rows={1} value={draft.question} maxLength={ANSWER_LIMITS.question}
            onChange={(e) => set({ question: e.target.value })} placeholder="Como o formulário pergunta, por exemplo: Você tem CNH?"
            aria-invalid={!!errors.question || undefined} aria-describedby={errors.question ? `${ids.question}-error` : undefined} className={FIELD_TEXT}
          />
        </FormField>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <p id={ids.kind} className="block text-[13px] font-medium text-ink-2">Tipo de resposta</p>
            <Segmented
              aria-labelledby={ids.kind} value={draft.kind} className="mt-1.5"
              onValueChange={(kind: NewAnswerKind) => set({ kind, answer: '' })}
              options={(Object.keys(NEW_ANSWER_KIND_LABELS) as NewAnswerKind[]).map((k) => ({ value: k, label: NEW_ANSWER_KIND_LABELS[k] }))}
            />
          </div>
          <div className="min-w-0">
            <p id={ids.scope} className="block text-[13px] font-medium text-ink-2">Vale para</p>
            <Segmented
              aria-labelledby={ids.scope} value={draft.scope} className="mt-1.5"
              onValueChange={(scope: NewAnswerDraft['scope']) => set({ scope })}
              options={[{ value: 'always', label: 'Sempre' }, { value: 'company', label: 'Só uma empresa' }]}
            />
          </div>
        </div>

        <AnimatePresence initial={false}>
          {draft.scope === 'company' && (
            <motion.div key="company" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="-mx-1 -my-1 overflow-hidden px-1 py-1">
              <FormField id={ids.company} label="Nome da empresa" error={errors.company}>
                <Input
                  id={ids.company} data-testid="apply-answer-new-company" value={draft.company} maxLength={ANSWER_LIMITS.company} autoComplete="off"
                  onChange={(e) => set({ company: e.target.value })} placeholder="Como aparece na vaga"
                  aria-invalid={!!errors.company || undefined} aria-describedby={errors.company ? `${ids.company}-error` : undefined}
                />
              </FormField>
            </motion.div>
          )}
        </AnimatePresence>

        <FormField
          id={ids.answer} label="Resposta" error={errors.answer}
          hint={kindHint(draft.kind) ? <p className="mt-1.5 text-xs text-faint">{kindHint(draft.kind)}</p> : undefined}
        >
          <AnswerFieldInput
            kind={draft.kind} value={draft.answer} id={ids.answer} labelledBy={ids.answer} testId="apply-answer-new-answer"
            onChange={(answer) => set({ answer })} onChoose={(choice) => set({ answer: booleanAnswer(choice) })}
            invalid={!!errors.answer} describedBy={errors.answer ? `${ids.answer}-error` : undefined}
          />
        </FormField>

        <div>
          <CheckChip
            label="Só para vagas no Brasil" checked={draft.brazilOnly} onCheckedChange={(brazilOnly) => set({ brazilOnly })}
            testId="apply-answer-new-brazil"
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-line pt-4">
          {serverError && <p role="alert" className="min-w-0 flex-1 text-xs leading-snug text-bad">{serverError}</p>}
          <Button type="button" variant="ghost" onClick={onDone} disabled={saving}>Cancelar</Button>
          <Button type="submit" variant="primary" data-testid="apply-answer-new-save" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar resposta'}
          </Button>
        </div>
      </div>
    </motion.form>
  );
}

function Loaded({ rows }: { rows: ApplyAnswerDto[] }) {
  const { saveAnswer } = useApplyActions();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { common, learned } = splitAnswers(rows);
  const learnedId = useId();

  /** Salva e já põe a resposta devolvida na lista, para o campo não voltar ao texto antigo até a releitura chegar. */
  const save: SaveFn = async (id, input) => {
    const saved = await saveAnswer.mutateAsync({ id, input });
    qc.setQueryData<ApplyAnswerDto[]>(APPLY_KEYS.answers, (old) =>
      old ? (old.some((r) => r.id === saved.id) ? old.map((r) => (r.id === saved.id ? saved : r)) : [...old, saved]) : old,
    );
    return saved;
  };

  return (
    <>
      <div className="px-5 pt-4 sm:px-6">
        <h4 className={EYEBROW}>Perguntas comuns</h4>
        <ul className="divide-y divide-line">
          {common.map((row) => <CommonRow key={row.id} row={row} save={save} />)}
        </ul>
      </div>

      <div className="border-t border-line px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h4 id={learnedId} className={cn(EYEBROW, 'flex-1')}>Respostas aprendidas{learned.length > 0 && ` (${learned.length})`}</h4>
          <Button type="button" size="sm" data-testid="apply-answer-add" aria-expanded={adding} onClick={() => setAdding((v) => !v)} disabled={adding}>
            <Plus aria-hidden /> Adicionar resposta
          </Button>
        </div>
        <AnimatePresence initial={false}>
          {adding && <NewAnswerForm save={save} onDone={() => setAdding(false)} />}
        </AnimatePresence>
        {learned.length === 0 ? (
          <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-muted">
            Nenhuma resposta aprendida ainda. Quando você responder uma pergunta durante uma candidatura, ela aparece aqui.
          </p>
        ) : (
          <ul aria-labelledby={learnedId} className="mt-1 divide-y divide-line">
            <AnimatePresence initial={false}>
              {learned.map((row) => <LearnedRow key={row.id} row={row} save={save} />)}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </>
  );
}

/** O bloco "Respostas para candidaturas" da página Meu perfil: o banco de respostas que o app pode dar em nome do dono. */
export function ApplyAnswersSection() {
  const answers = useApplyAnswers();
  const titleId = useId();
  return (
    <motion.section
      aria-labelledby={titleId} data-testid="apply-answers-section"
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.18 }}
      className={CARD}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-line px-5 py-4 sm:px-6">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/14 text-accent ring-1 ring-inset ring-accent/25">
          <ClipboardList className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-display text-lg font-semibold leading-tight">Respostas para candidaturas</h3>
          <p className="mt-0.5 max-w-3xl text-[13px] leading-snug text-muted">
            É daqui que saem as respostas para perguntas pessoais dos formulários (pretensão salarial, visto, disponibilidade, dados demográficos).
            A IA nunca inventa essas respostas: sem uma resposta salva, a candidatura para e pergunta a você. O que você responder em uma
            candidatura também fica salvo aqui.
          </p>
        </div>
      </div>

      {answers.data ? (
        <Loaded rows={answers.data} />
      ) : answers.isPending ? (
        <div aria-busy="true" aria-label="Carregando as respostas" className="space-y-3 px-5 py-5 sm:px-6">
          <Skeleton className="h-10 rounded-xl" />
          <Skeleton className="h-10 rounded-xl" />
          <Skeleton className="h-10 rounded-xl" />
        </div>
      ) : (
        <div className="px-5 py-5 sm:px-6">
          <Notice
            tone="bad" role="alert" title="Não foi possível carregar as respostas"
            action={<Button size="sm" onClick={() => void answers.refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}
            icon={<CloudOff />}
          >
            {answers.error?.message}
          </Notice>
        </div>
      )}
    </motion.section>
  );
}

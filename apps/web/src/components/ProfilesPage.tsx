import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Radar, SearchX, Trash2, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { LEVELS, LIMITS, MAX_AGES, REGIONS, type Level, type MaxAge, type ProfileDto, type ProfileInput, type Region } from '@kv/shared/client';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import {
  EMPTY_FORM, canSubmit, collectStacks, formFromProfile, isDirty, toInput, toPatch, unavailableSources, validateForm,
  type ProfileForm,
} from '../profileForm';
import { showToast } from '../toast';
import { SourceMark } from './SourceMark';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { Input } from './ui/input';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';
import { Switch } from './ui/switch';
import { TagInput } from './ui/tag-input';

const LEVEL_LABEL: Record<Level, string> = { junior: 'Júnior', pleno: 'Pleno', senior: 'Sênior' };
const REGION_LABEL: Record<Region, string> = { brasil: 'Brasil', exterior: 'Exterior', remoto: 'Remoto' };
const AGE_LABEL: Record<MaxAge, string> = { 1: 'Últimas 24 h', 3: 'Últimos 3 dias', 7: 'Últimos 7 dias', 30: 'Últimos 30 dias' };
/** Versão curta para o controle segmentado, lida junto com o rótulo "Vaga aberta há no máximo". */
const AGE_SHORT: Record<MaxAge, string> = { 1: '24 h', 3: '3 dias', 7: '7 dias', 30: '30 dias' };

const LABEL = 'block text-[13px] font-medium text-ink-2';
const HINT = 'text-xs text-faint';
const ERROR = 'text-xs text-bad';
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
/** A partir de quantos caracteres/itens do limite o contador aparece. */
const NAME_COUNTER_FROM = LIMITS.profileName - 15;
const STACKS_COUNTER_FROM = LIMITS.stacks - 5;

/**
 * Formulário em andamento quando o usuário sai da tela de perfis (vai ao quadro, por exemplo): fica
 * guardado e volta como estava, em vez de se perder em silêncio. Vale para criação e para edição.
 */
let keptDraft: { editingId: number | null; form: ProfileForm } | null = null;

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function Checks<T extends string>(props: {
  legend: string; hint?: string; options: readonly T[]; label: (o: T) => string; value: T[]; onChange: (v: T[]) => void;
  adornment?: (o: T) => ReactNode; grid?: boolean; action?: ReactNode;
}) {
  const legendId = useId();
  return (
    <div role="group" aria-labelledby={legendId} className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span id={legendId} className={LABEL}>{props.legend}</span>
        {props.hint && <span className={HINT}>{props.hint}</span>}
        {props.action && <span className="ml-auto">{props.action}</span>}
      </div>
      {/* Na grade, cada célula tem largura mínima para o nome da fonte caber inteiro: nunca trunca. */}
      <div className={props.grid ? 'grid grid-cols-[repeat(auto-fill,minmax(9.75rem,1fr))] gap-1.5' : 'flex flex-wrap gap-1.5'}>
        {props.options.map((o) => (
          <CheckChip
            key={o}
            label={props.label(o)}
            shape={props.grid ? 'block' : 'pill'}
            adornment={props.adornment?.(o)}
            checked={props.value.includes(o)}
            onCheckedChange={() => props.onChange(toggle(props.value, o))}
          />
        ))}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={EYEBROW}>{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

const ANY = 'text-[13px] italic text-muted';

export function ProfilesPage({ onRunQueued }: { onRunQueued: () => void }) {
  const qc = useQueryClient();
  const { data: profiles = [], isPending: profilesPending, isSuccess: profilesLoaded } = useQuery({
    queryKey: ['profiles'], queryFn: api.profiles,
  });
  const { data: sources = [], isSuccess: sourcesLoaded } = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const [editingId, setEditingId] = useState<number | null>(() => keptDraft?.editingId ?? null);
  const [form, setForm] = useState<ProfileForm>(() => keptDraft?.form ?? EMPTY_FORM);
  const nameId = useId();
  const nameHelpId = useId();
  const stacksId = useId();
  const stacksHelpId = useId();
  const ageId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['profiles'] });

  const editing: ProfileDto | null = editingId === null ? null : (profiles.find((p) => p.id === editingId) ?? null);
  /** Ids das fontes que existem hoje; null enquanto `/sources` não respondeu (nada é tido como indisponível). */
  const known = sourcesLoaded ? sources.map((s) => s.id) : null;
  const gone = unavailableSources(form, known);
  const errors = validateForm(form, known);
  const dirty = isDirty(editing, form);
  const patch = editing ? toPatch(editing, form, known) : null;
  const ready = canSubmit(form, known) && (patch === null || Object.keys(patch).length > 0);

  // Sair da tela com o formulário mexido guarda o rascunho (ver `keptDraft`).
  const latest = useRef({ editingId, form, dirty });
  latest.current = { editingId, form, dirty };
  useEffect(
    () => () => {
      const { dirty: wasDirty, ...draft } = latest.current;
      keptDraft = wasDirty ? draft : null;
    },
    [],
  );

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    create.reset();
    update.reset();
  }

  // O perfil em edição foi apagado (aqui ou em outra aba): volta ao formulário de criação.
  useEffect(() => {
    if (editingId !== null && profilesLoaded && !profiles.some((p) => p.id === editingId)) resetForm();
  });

  const create = useMutation({
    mutationFn: api.createProfile,
    onSuccess: () => {
      resetForm();
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: number; patch: Partial<ProfileInput> }) => api.updateProfile(v.id, v.patch),
    onSuccess: () => {
      showToast('Perfil atualizado', 'info');
      resetForm();
      refresh();
    },
  });
  const setActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => api.updateProfile(v.id, { active: v.active }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: api.deleteProfile,
    onSuccess: (_data, id) => {
      if (id === editingId) resetForm();
      refresh();
    },
  });
  const runNow = useMutation({
    mutationFn: api.runNow,
    onSuccess: (r) => {
      if (r.queued === 0) return showToast('Já existe uma busca em andamento', 'info');
      showToast(`Busca enfileirada em ${r.queued} ${r.queued === 1 ? 'fonte' : 'fontes'}`, 'info');
      onRunQueued();
    },
  });
  const saving = create.isPending || update.isPending;
  const saveError = (editing ? update.error : create.error)?.message;

  function change(next: Partial<ProfileForm>) {
    setForm((f) => ({ ...f, ...next }));
    // O erro do último envio valia para o que estava no formulário; mexeu, some.
    if (create.isError) create.reset();
    if (update.isError) update.reset();
  }

  function startEdit(profile: ProfileDto) {
    if (profile.id !== editingId) {
      // Alterações não salvas (de outra edição ou de um perfil novo) não se perdem sem perguntar.
      const what = editing ? `as alterações não salvas em "${editing.name}"` : 'o perfil novo que você começou a preencher';
      if (dirty && !confirm(`Descartar ${what}?`)) return;
      create.reset();
      update.reset();
      setEditingId(profile.id);
      setForm(formFromProfile(profile));
    }
    // Em telas estreitas o formulário fica depois da lista: traz para a vista. O foco vai para o nome.
    requestAnimationFrame(() => {
      if (!window.matchMedia('(min-width: 64rem)').matches) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        formRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      }
      nameRef.current?.focus({ preventScroll: true });
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || saving) return;
    if (editing && patch) update.mutate({ id: editing.id, patch });
    else create.mutate(toInput(form, known));
  }

  /** Esc dentro do formulário, em edição, descarta as alterações (o mesmo que "Cancelar"). */
  function onFormKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Escape' || editingId === null || e.defaultPrevented) return;
    e.preventDefault();
    resetForm();
  }

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  const marked = form.sources.length - gone.length;
  const allSources = sources.length > 0 && marked === sources.length;
  const stackCount = collectStacks(form).length;
  const nameLength = form.name.length;

  let footerHint: string;
  if (errors.name || errors.stacks || errors.sources) footerHint = 'Corrija os campos destacados para salvar.';
  else if (editing) footerHint = ready ? 'Salvar não dispara uma busca.' : dirty ? 'Dê um nome e marque ao menos uma fonte.' : 'Nenhuma alteração ainda.';
  else footerHint = marked === 0 ? 'Dê um nome e marque ao menos uma fonte para salvar.' : 'Pronto para salvar.';

  return (
    // Em telas largas, formulário e lista rolam cada um por si e o rodapé do formulário (Salvar) fica sempre
    // à vista. Em telas estreitas a página inteira rola, com a lista antes do formulário.
    <div className="flex h-full flex-col overflow-y-auto lg:grid lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(27rem,1fr)_minmax(0,1fr)] lg:gap-6 lg:overflow-hidden lg:p-6 2xl:grid-cols-[42rem_minmax(0,1fr)]">
      <motion.form
        ref={formRef}
        onSubmit={submit}
        onKeyDown={onFormKeyDown}
        aria-label={editing ? `Editar perfil de busca ${editing.name}` : 'Novo perfil de busca'}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring}
        className={cn(
          '@container m-4 flex shrink-0 scroll-mt-4 flex-col self-stretch rounded-3xl border bg-surface/85 shadow-raised transition-[border-color,box-shadow] duration-200 ease-out-soft max-lg:order-last sm:m-6 lg:m-0 lg:max-h-full lg:min-h-0 lg:self-start',
          editing ? 'border-accent/45 ring-[3px] ring-accent/12' : 'border-line',
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/14 text-accent ring-1 ring-inset ring-accent/25">
            {editing ? <Pencil aria-hidden className="size-5" /> : <Radar aria-hidden className="size-5" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight">{editing ? 'Editar perfil de busca' : 'Novo perfil de busca'}</h2>
            <p className="mt-0.5 truncate text-[13px] leading-snug text-muted">
              {editing
                ? <>Alterando <span className="text-ink-2">{editing.name}</span>. Esc ou Cancelar descarta.</>
                : 'Diga o que procurar e onde. O worker repete a busca sozinho.'}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 px-5 py-5 sm:px-6 lg:overflow-y-auto">
          <div className="grid gap-4 @xl:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={nameId} className={LABEL}>Nome</label>
              <Input
                ref={nameRef}
                id={nameId} required value={form.name} onChange={(e) => change({ name: e.target.value })}
                placeholder="React Pleno remoto" maxLength={LIMITS.profileName}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name || nameLength >= NAME_COUNTER_FROM ? nameHelpId : undefined}
              />
              {errors.name ? (
                <p id={nameHelpId} className={ERROR}>{errors.name}</p>
              ) : nameLength >= NAME_COUNTER_FROM && (
                <p id={nameHelpId} className={cn(HINT, 'tabular-nums', nameLength >= LIMITS.profileName && 'text-warn')}>
                  {nameLength}/{LIMITS.profileName} caracteres{nameLength >= LIMITS.profileName && ' (limite atingido)'}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor={stacksId} className={LABEL}>Stacks (separadas por vírgula)</label>
              <TagInput
                id={stacksId} tags={form.stacks} onTagsChange={(stacks) => change({ stacks })}
                draft={form.stacksDraft} onDraftChange={(stacksDraft) => change({ stacksDraft })}
                placeholder="react, node, typescript"
                invalid={!!errors.stacks} describedBy={stacksHelpId}
              />
              <p id={stacksHelpId} aria-live="polite" className={errors.stacks ? ERROR : HINT}>
                {errors.stacks ?? (
                  <>
                    Enter ou vírgula adiciona. Vazio = qualquer stack.
                    {stackCount >= STACKS_COUNTER_FROM && <span className="tabular-nums"> {stackCount}/{LIMITS.stacks} stacks.</span>}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="grid gap-x-6 gap-y-4 border-t border-line pt-4 @[34rem]:grid-cols-2">
            <Checks
              legend="Nível" hint="vazio = qualquer" options={LEVELS} label={(l) => LEVEL_LABEL[l]}
              value={form.levels} onChange={(levels) => change({ levels })}
            />
            <Checks
              legend="Região" hint="vazio = qualquer" options={REGIONS} label={(r) => REGION_LABEL[r]}
              value={form.regions} onChange={(regions) => change({ regions })}
            />
            <div className="@[34rem]:col-span-2">
              <span id={ageId} className={cn(LABEL, 'mb-2')}>Vaga aberta há no máximo</span>
              <Segmented
                aria-labelledby={ageId}
                value={String(form.maxAgeDays)}
                onValueChange={(v) => change({ maxAgeDays: Number(v) as MaxAge })}
                options={MAX_AGES.map((a) => ({ value: String(a), label: AGE_SHORT[a], ariaLabel: AGE_LABEL[a] }))}
              />
            </div>
          </div>

          <div className="border-t border-line pt-4">
            <Checks
              grid legend="Fontes" hint={`${marked} de ${sources.length} marcadas`}
              options={sources.map((s) => s.id)} label={sourceName}
              value={form.sources} onChange={(s) => change({ sources: s })}
              adornment={(o) => <SourceMark source={o} />}
              action={
                sources.length > 1 && (
                  <button
                    type="button"
                    onClick={() => change({ sources: allSources ? gone : [...gone, ...sources.map((s) => s.id)] })}
                    className="cursor-pointer rounded-md px-1 text-xs font-medium text-accent transition-colors hover:text-ink"
                  >
                    {allSources ? 'Limpar' : 'Marcar todas'}
                  </button>
                )
              }
            />
            {gone.length > 0 && (
              <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-snug text-warn">
                <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>
                  {gone.length === 1 ? 'Fonte indisponível' : 'Fontes indisponíveis'}: <strong className="font-semibold">{gone.join(', ')}</strong>.{' '}
                  {gone.length === 1 ? 'Ela sai' : 'Elas saem'} do perfil ao salvar.
                </span>
              </p>
            )}
            {errors.sources && <p role="alert" className={cn(ERROR, 'mt-2')}>{errors.sources}</p>}
          </div>
        </div>

        {/* Sem `sticky`: em telas estreitas a página inteira rola e um rodapé grudado cobria os campos. Em
            telas largas ele já fica sempre à vista, porque só o miolo do formulário rola. */}
        <div className="shrink-0 rounded-b-3xl border-t border-line bg-surface-2 px-5 py-3.5 sm:px-6">
          {saveError && (
            <p role="alert" className={cn(ERROR, 'mb-2.5 flex items-start gap-1.5 leading-snug')}>
              <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>Não foi possível salvar. {saveError}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className={cn(HINT, 'min-w-0')}>{footerHint}</p>
            <div className="ml-auto flex items-center gap-2">
              {editing && (
                <Button type="button" variant="ghost" size="lg" onClick={resetForm}>
                  Cancelar
                </Button>
              )}
              <Button type="submit" variant="primary" size="lg" disabled={saving || !ready} className="min-w-36">
                {editing ? 'Salvar alterações' : 'Salvar perfil'}
              </Button>
            </div>
          </div>
        </div>
      </motion.form>

      <section className="min-w-0 space-y-3 p-4 pb-0 sm:p-6 sm:pb-0 lg:overflow-y-auto lg:p-0 lg:pr-1">
        <div className="flex items-baseline gap-2.5 pt-1">
          <h2 className="text-lg font-semibold">Perfis</h2>
          {profiles.length > 0 && <span className="text-xs tabular-nums text-muted">{profiles.length}</span>}
        </div>
        {profilesPending && (
          <div aria-busy="true" className="rounded-3xl border border-line bg-surface/85 p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-3 h-5 w-3/4" />
            <Skeleton className="mt-3 h-5 w-1/2" />
          </div>
        )}
        {!profilesPending && profiles.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-line px-6 py-12 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
              <SearchX aria-hidden className="size-5" />
            </span>
            <p className="text-sm text-muted">Nenhum perfil ainda.</p>
          </div>
        )}
        {profiles.map((p, i) => {
          const isEditing = p.id === editingId;
          return (
            <motion.article
              key={p.id} data-testid="profile" data-editing={isEditing || undefined} layout="position"
              initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: Math.min(i, 8) * 0.04 }}
              className={cn(
                'rounded-3xl border bg-surface/85 transition-[border-color,box-shadow] duration-200 ease-out-soft',
                isEditing
                  ? 'border-accent/55 shadow-raised ring-[3px] ring-accent/15'
                  : 'border-line shadow-card hover:border-line-strong hover:shadow-raised',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-4 sm:px-6">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden className={cn('relative size-2 shrink-0 rounded-full', p.active ? 'bg-ok' : 'bg-faint')}>
                    {p.active && <span className="absolute inset-0 animate-pulse-dot rounded-full bg-ok" />}
                  </span>
                  <h3 className="truncate text-base font-semibold text-ink">{p.name}</h3>
                  {isEditing && <Badge tone="accent" size="md">Editando</Badge>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <label className="mr-1 flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-muted">
                    <Switch checked={p.active} onCheckedChange={(active) => setActive.mutate({ id: p.id, active })} />
                    Ativo
                  </label>
                  <Button variant="primary" onClick={() => runNow.mutate(p.id)}>
                    <Radar aria-hidden /> Buscar agora
                  </Button>
                  <Button onClick={() => startEdit(p)} aria-pressed={isEditing}>
                    <Pencil aria-hidden /> Editar
                  </Button>
                  <Button variant="danger" onClick={() => confirm(`Excluir o perfil "${p.name}"?`) && remove.mutate(p.id)}>
                    <Trash2 aria-hidden /> Excluir
                  </Button>
                </div>
              </div>
              <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-4 px-5 sm:px-6">
                <Fact label="Stacks">
                  {p.stacks.length > 0 ? p.stacks.map((s) => <Badge key={s} size="md">{s}</Badge>) : <span className={ANY}>qualquer stack</span>}
                </Fact>
                <Fact label="Nível">
                  {p.levels.length > 0
                    ? p.levels.map((l) => <Badge key={l} size="md">{LEVEL_LABEL[l]}</Badge>)
                    : <span className={ANY}>qualquer nível</span>}
                </Fact>
                <Fact label="Região">
                  {p.regions.length > 0
                    ? p.regions.map((r) => <Badge key={r} size="md">{REGION_LABEL[r]}</Badge>)
                    : <span className={ANY}>qualquer região</span>}
                </Fact>
                <Fact label="Abertas há">
                  <Badge size="md">{AGE_LABEL[p.maxAgeDays]}</Badge>
                </Fact>
              </dl>
              <div className="mt-4 rounded-b-3xl border-t border-line bg-bg/30 px-5 py-3.5 sm:px-6">
                <p className={EYEBROW}>Fontes: <span className="tabular-nums">{p.sources.length}</span></p>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 text-[13px] text-ink-2">
                  {p.sources.map((s) => (
                    <li key={s} className="flex items-center gap-2">
                      <SourceMark source={s} /> {sourceName(s)}
                    </li>
                  ))}
                </ul>
              </div>
            </motion.article>
          );
        })}
        <div aria-hidden className="h-4 sm:h-6 lg:h-2" />
      </section>
    </div>
  );
}

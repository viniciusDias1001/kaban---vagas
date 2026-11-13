import { useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCw, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LIMITS, type CandidateProfileDto, type ProfileOrigin, type ProfileWire, type ResumeLang } from '@kv/shared/client';
import { ApiError } from '../apiError';
import { blankItem, editableProfile, profileDirty, rebaseDraft } from '../lib/ai';
import { cn } from '../lib/utils';
import { showToast } from '../toast';
import { AI_KEYS, useSaveProfile } from '../useAi';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input, Textarea } from './ui/input';
import { Notice } from './ui/notice';

const LABEL = 'block text-xs font-medium text-muted';
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';

const ORIGIN: Record<ProfileOrigin, { label: string; tone: 'accent' | 'warn' | 'ok' }> = {
  extraido: { label: 'extraído', tone: 'accent' },
  traduzido: { label: 'traduzido por IA', tone: 'warn' },
  editado: { label: 'editado', tone: 'ok' },
};

/**
 * Rascunhos não salvos de quem saiu da tela, por idioma: voltam como estavam (como em Perfis de busca). `version` é
 * a versão do perfil em que o rascunho se baseia; se o servidor já tem outra quando o editor volta, o rascunho
 * continua lá e a tela avisa (ver `rebaseDraft`).
 */
const kept: Partial<Record<ResumeLang, { version: number; data: ProfileWire }>> = {};

/** Esquece o rascunho guardado de um idioma (ou de todos): o perfil foi apagado. */
export function forgetProfileDraft(lang?: ResumeLang): void {
  for (const key of Object.keys(kept) as ResumeLang[]) if (!lang || key === lang) delete kept[key];
}

function Field({ label, value, onChange, hint, className, type, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; className?: string; type?: string; placeholder?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <label htmlFor={id} className={LABEL}>{label}</label>
      <Input
        id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} maxLength={LIMITS.profileShort}
        placeholder={placeholder} aria-describedby={hint ? hintId : undefined} className="h-9"
      />
      {hint && <p id={hintId} className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

function RemoveButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={onClick} className={cn('text-faint hover:bg-bad/12 hover:text-bad', className)}>
      <Trash2 aria-hidden />
    </Button>
  );
}

function AddButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" size="sm" variant="ghost" onClick={onClick} disabled={disabled} className="border border-dashed border-line text-muted hover:border-line-strong">
      <Plus aria-hidden /> {children}
    </Button>
  );
}

function Group({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="border-t border-line pt-5">
      <div className="mb-3 flex items-center gap-2">
        <h4 id={id} className={EYEBROW}>{title}</h4>
        {count !== undefined && count > 0 && <span className="text-[11px] tabular-nums text-faint">{count}</span>}
      </div>
      {children}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

const ITEM = 'rounded-2xl border border-line bg-surface-2/50 p-3.5';
const named = (kind: string, name: string, index: number) => `Remover ${kind} ${name.trim() || index + 1}`;

interface Props {
  profile: CandidateProfileDto;
  /** Só o editor ativo é mostrado e desenha o rodapé; os outros ficam montados para não perder o que foi digitado. */
  active: boolean;
  /** Onde o rodapé (dica + Salvar) é desenhado: a barra fixa no pé da tela. */
  footer: HTMLElement | null;
}

export function ProfileEditor({ profile, active, footer }: Props) {
  const lang = profile.lang;
  const qc = useQueryClient();
  const [data, setData] = useState<ProfileWire>(() => kept[lang]?.data ?? editableProfile(profile.data));
  /** Versão do perfil em que o rascunho se baseia: é ela que vai no PUT, e a API recusa (409) se já houver outra. */
  const [draftVersion, setDraftVersion] = useState(() => kept[lang]?.version ?? profile.version);
  /** O servidor tem uma versão mais nova que a do rascunho, e há alterações não salvas: o usuário decide. */
  const [conflict, setConflict] = useState(false);
  const dirty = profileDirty(data, profile.data);
  // Versão nova no servidor (currículo reenviado, tradução refeita, outra aba): sem edição pendente o editor
  // acompanha; com edição pendente o rascunho fica e a tela pergunta o que fazer.
  const [base, setBase] = useState<CandidateProfileDto | null>(null);
  if (profile !== base) {
    const action = rebaseDraft({ dirty: base ? profileDirty(data, base.data) : dirty, version: draftVersion }, profile.version);
    if (action === 'adopt') {
      setData(editableProfile(profile.data));
      setDraftVersion(profile.version);
      setConflict(false);
    } else if (action === 'conflict') {
      setConflict(true);
    }
    setBase(profile);
  }
  const save = useSaveProfile();
  const formId = useId();
  const summaryId = useId();
  const origin = ORIGIN[profile.origin];
  const blocked = conflict && dirty;

  const latest = useRef({ data, dirty, version: draftVersion });
  latest.current = { data, dirty, version: draftVersion };
  useEffect(() => () => {
    const { dirty: wasDirty, ...draft } = latest.current;
    if (wasDirty) kept[lang] = draft;
    else delete kept[lang];
  }, [lang]);

  const set = <K extends keyof ProfileWire>(key: K, value: ProfileWire[K]) => setData((d) => ({ ...d, [key]: value }));
  /** Troca campos do item `index` de uma lista do perfil; o `id` do item vai junto, intocado. */
  function patch<K extends 'experiences' | 'education' | 'skills' | 'languages' | 'certifications' | 'links'>(
    key: K, index: number, next: Partial<ProfileWire[K][number]>,
  ) {
    setData((d) => ({ ...d, [key]: d[key].map((item, i) => (i === index ? { ...item, ...next } : item)) }));
  }
  const drop = (key: 'experiences' | 'education' | 'skills' | 'languages' | 'certifications' | 'links', index: number) =>
    setData((d) => ({ ...d, [key]: d[key].filter((_, i) => i !== index) }));
  const full = (list: unknown[]) => list.length >= LIMITS.profileItems;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || blocked || save.isPending) return;
    save.mutate({ lang, data, version: draftVersion }, {
      onSuccess: (saved) => {
        // A resposta traz os ids que a API criou para os itens novos.
        setBase(saved);
        setData(editableProfile(saved.data));
        setDraftVersion(saved.version);
        setConflict(false);
        showToast('Perfil salvo. Notas e análises antigas ficam marcadas como desatualizadas.', 'info');
      },
      onError: (e) => {
        // 409: o perfil mudou no servidor depois que este rascunho começou. Busca a versão nova e mostra as opções.
        if (e instanceof ApiError && e.status === 409) {
          void qc.invalidateQueries({ queryKey: AI_KEYS.profile }).finally(() => setConflict(true));
        } else {
          showToast(e.message);
        }
      },
    });
  }

  /** "Recarregar": descarta o rascunho e mostra a versão do servidor. */
  function reload() {
    setData(editableProfile(profile.data));
    setDraftVersion(profile.version);
    setConflict(false);
  }
  /** "Continuar editando": o rascunho passa a se basear na versão do servidor; salvar grava por cima dela. */
  function keepEditing() {
    setDraftVersion(profile.version);
    setConflict(false);
  }

  return (
    <form
      id={formId} data-testid={`profile-editor-${lang}`} onSubmit={submit} noValidate hidden={!active}
      aria-label={`Perfil estruturado em ${lang === 'pt-BR' ? 'português' : 'inglês'}`}
      className="@container space-y-5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={origin.tone} size="md" data-testid={`profile-origin-${lang}`}>{origin.label}</Badge>
        <p className="text-xs text-muted">
          {profile.origin === 'traduzido' && 'Revise e salve para confirmar a tradução. '}
          Atualizado em <span className="tabular-nums">{new Date(profile.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>.
          {' '}É a partir deste perfil que a IA dá notas e escreve: ela não pode acrescentar nada que não esteja aqui.
        </p>
      </div>

      {blocked && (
        <Notice
          tone="warn" role="alert" data-testid={`profile-conflict-${lang}`} title="O perfil mudou no servidor"
          action={
            <>
              <Button type="button" size="sm" data-testid={`profile-conflict-reload-${lang}`} onClick={reload}><RotateCw aria-hidden /> Recarregar</Button>
              <Button type="button" size="sm" variant="ghost" data-testid={`profile-conflict-keep-${lang}`} onClick={keepEditing}>Continuar editando</Button>
            </>
          }
        >
          <p>
            Uma versão mais nova deste perfil foi gravada enquanto você editava (por uma tradução, pela leitura de um currículo ou em outra aba).
            Suas alterações continuam aqui, mas ainda não foram salvas.
          </p>
          <p className="mt-1 text-muted">
            Recarregar descarta as suas alterações e mostra a versão nova. Continuar editando mantém o seu texto: ao salvar, ele substitui a versão nova.
          </p>
        </Notice>
      )}

      <div role="group" aria-label="Contato" className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        <Field label="Nome" value={data.contact.name} onChange={(name) => set('contact', { ...data.contact, name })} />
        <Field label="E-mail" type="email" value={data.contact.email} onChange={(email) => set('contact', { ...data.contact, email })} />
        <Field label="Telefone" value={data.contact.phone} onChange={(phone) => set('contact', { ...data.contact, phone })} />
        <Field label="Local" value={data.contact.location} onChange={(location) => set('contact', { ...data.contact, location })} />
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={summaryId} className={LABEL}>Resumo</label>
          {data.summary.length >= LIMITS.profileLong * 0.9 && (
            <span className="text-[11px] tabular-nums text-faint">{data.summary.length}/{LIMITS.profileLong}</span>
          )}
        </div>
        <Textarea
          id={summaryId} data-testid={`profile-summary-${lang}`} value={data.summary} rows={4}
          onChange={(e) => set('summary', e.target.value)} maxLength={LIMITS.profileLong}
        />
      </div>

      <Group
        title="Experiências" count={data.experiences.length}
        action={<AddButton disabled={full(data.experiences)} onClick={() => set('experiences', [...data.experiences, blankItem.experience()])}>Adicionar experiência</AddButton>}
      >
        <div className="space-y-3">
          {data.experiences.map((exp, i) => (
            <div key={i} role="group" aria-label={`Experiência ${exp.company.trim() || i + 1}`} className={ITEM}>
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-[1.4fr_1.4fr_0.7fr_0.7fr_1fr]">
                  <Field label="Cargo" value={exp.title} onChange={(title) => patch('experiences', i, { title })} />
                  <Field label="Empresa" value={exp.company} onChange={(company) => patch('experiences', i, { company })} />
                  <Field label="Início" value={exp.start} placeholder="2021-03" onChange={(start) => patch('experiences', i, { start })} />
                  <Field label="Fim" value={exp.end} hint="vazio = atual" onChange={(end) => patch('experiences', i, { end })} />
                  <Field label="Local" value={exp.location} onChange={(location) => patch('experiences', i, { location })} className="@md:max-@4xl:col-span-2" />
                </div>
                <RemoveButton label={named('experiência', exp.company, i)} onClick={() => drop('experiences', i)} className="mt-5" />
              </div>
              <div className="mt-3 space-y-2">
                <p className={LABEL}>Realizações</p>
                {exp.achievements.map((ach, n) => (
                  <div key={n} className="flex items-start gap-2">
                    <Textarea
                      value={ach.text} rows={2} maxLength={LIMITS.profileLong}
                      aria-label={`Realização ${n + 1} de ${exp.title.trim() || exp.company.trim() || `experiência ${i + 1}`}`}
                      onChange={(e) => patch('experiences', i, { achievements: exp.achievements.map((a, k) => (k === n ? { ...a, text: e.target.value } : a)) })}
                      className="min-h-[3.75rem] py-2"
                    />
                    <RemoveButton
                      label={`Remover realização ${n + 1} de ${exp.company.trim() || `experiência ${i + 1}`}`}
                      onClick={() => patch('experiences', i, { achievements: exp.achievements.filter((_, k) => k !== n) })}
                    />
                  </div>
                ))}
                <AddButton
                  disabled={exp.achievements.length >= LIMITS.achievements}
                  onClick={() => patch('experiences', i, { achievements: [...exp.achievements, blankItem.achievement()] })}
                >
                  Adicionar realização
                </AddButton>
              </div>
            </div>
          ))}
          {data.experiences.length === 0 && <p className="text-[13px] italic text-muted">Nenhuma experiência.</p>}
        </div>
      </Group>

      <Group
        title="Formação" count={data.education.length}
        action={<AddButton disabled={full(data.education)} onClick={() => set('education', [...data.education, blankItem.education()])}>Adicionar formação</AddButton>}
      >
        <div className="space-y-2">
          {data.education.map((edu, i) => (
            <div key={i} role="group" aria-label={`Formação ${edu.degree.trim() || i + 1}`} className={cn(ITEM, 'flex items-start gap-2')}>
              <div className="grid min-w-0 flex-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-[1.5fr_1.5fr_0.7fr_0.7fr]">
                <Field label="Curso" value={edu.degree} onChange={(degree) => patch('education', i, { degree })} />
                <Field label="Instituição" value={edu.institution} onChange={(institution) => patch('education', i, { institution })} />
                <Field label="Início" value={edu.start} onChange={(start) => patch('education', i, { start })} />
                <Field label="Fim" value={edu.end} onChange={(end) => patch('education', i, { end })} />
              </div>
              <RemoveButton label={named('formação', edu.degree, i)} onClick={() => drop('education', i)} className="mt-5" />
            </div>
          ))}
        </div>
      </Group>

      <Group
        title="Habilidades" count={data.skills.length}
        action={<AddButton disabled={full(data.skills)} onClick={() => set('skills', [...data.skills, blankItem.skill()])}>Adicionar habilidade</AddButton>}
      >
        <div className="grid gap-2 @md:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4">
          {data.skills.map((skill, i) => (
            <div key={i} className="relative">
              <Input
                value={skill.name} aria-label={`Habilidade ${i + 1}`} maxLength={LIMITS.profileShort}
                onChange={(e) => patch('skills', i, { name: e.target.value })} className="h-9 pr-9"
              />
              <button
                type="button" aria-label={named('habilidade', skill.name, i)} onClick={() => drop('skills', i)}
                className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-lg text-faint transition-colors hover:bg-bad/12 hover:text-bad"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Group>

      <div className="grid gap-x-6 @3xl:grid-cols-2">
        <Group
          title="Idiomas" count={data.languages.length}
          action={<AddButton disabled={full(data.languages)} onClick={() => set('languages', [...data.languages, blankItem.language()])}>Adicionar idioma</AddButton>}
        >
          <div className="space-y-2">
            {data.languages.map((l, i) => (
              <div key={i} role="group" aria-label={`Idioma ${l.name.trim() || i + 1}`} className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                  <Field label="Idioma" value={l.name} onChange={(name) => patch('languages', i, { name })} />
                  <Field label="Nível" value={l.level} onChange={(level) => patch('languages', i, { level })} />
                </div>
                <RemoveButton label={named('idioma', l.name, i)} onClick={() => drop('languages', i)} className="mt-5" />
              </div>
            ))}
          </div>
        </Group>

        <Group
          title="Links" count={data.links.length}
          action={<AddButton disabled={full(data.links)} onClick={() => set('links', [...data.links, blankItem.link()])}>Adicionar link</AddButton>}
        >
          <div className="space-y-2">
            {data.links.map((l, i) => (
              <div key={i} role="group" aria-label={`Link ${l.label.trim() || i + 1}`} className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-[1fr_1.6fr] gap-2">
                  <Field label="Rótulo" value={l.label} onChange={(label) => patch('links', i, { label })} />
                  <Field label="URL" value={l.url} placeholder="https://" onChange={(url) => patch('links', i, { url })} />
                </div>
                <RemoveButton label={named('link', l.label, i)} onClick={() => drop('links', i)} className="mt-5" />
              </div>
            ))}
          </div>
        </Group>
      </div>

      <Group
        title="Certificações" count={data.certifications.length}
        action={<AddButton disabled={full(data.certifications)} onClick={() => set('certifications', [...data.certifications, blankItem.certification()])}>Adicionar certificação</AddButton>}
      >
        <div className="space-y-2">
          {data.certifications.map((c, i) => (
            <div key={i} role="group" aria-label={`Certificação ${i + 1}`} className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-2 @md:grid-cols-[1.6fr_1.2fr_0.7fr]">
                <Field label="Certificação" value={c.name} onChange={(name) => patch('certifications', i, { name })} />
                <Field label="Emissor" value={c.issuer} onChange={(issuer) => patch('certifications', i, { issuer })} />
                <Field label="Data" value={c.date} onChange={(date) => patch('certifications', i, { date })} />
              </div>
              <RemoveButton label={named('certificação', c.name, i)} onClick={() => drop('certifications', i)} className="mt-5" />
            </div>
          ))}
        </div>
      </Group>

      {active && footer && createPortal(
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p aria-live="polite" className={cn('min-w-0 text-xs', dirty && !save.isPending ? 'text-warn' : 'text-faint')}>
            {save.isPending ? 'Salvando…' : blocked ? 'O perfil mudou no servidor: escolha recarregar ou continuar editando.'
              : dirty ? 'Há alterações não salvas no perfil.' : 'Nenhuma alteração para salvar.'}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="lg" disabled={save.isPending} onClick={reload}>
                Descartar
              </Button>
            )}
            <Button type="submit" form={formId} variant="primary" size="lg" data-testid={`profile-save-${lang}`} disabled={!dirty || blocked || save.isPending} className="min-w-44">
              Salvar meu perfil
            </Button>
          </div>
        </div>,
        footer,
      )}
    </form>
  );
}

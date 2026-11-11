import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Eye, LoaderCircle, Lock, X } from 'lucide-react';
import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { LIMITS, draftOf, type TailoredDto, type TailoredResume, type TailoredSaveDto, type Violation } from '@kv/shared/client';
import { tailoredPdfUrl } from '../aiApi';
import { cn } from '../lib/utils';
import { useSaveTailored } from '../useAi';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Notice } from './ui/notice';

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
const LABEL = 'block text-xs font-medium text-muted';

/** O limite do verificador, dito ao lado da revisão: ele confere fatos copiados, não o texto livre. */
export const VERIFIER_LIMIT =
  'A verificação automática confere empresas, cargos, datas, formações e habilidades com o seu perfil. Ela não substitui a sua leitura: revise o resumo e as realizações antes de enviar.';

type ListKey = 'experiences' | 'education' | 'skills' | 'languages' | 'certifications' | 'links';
const signature = (resume: TailoredResume) => JSON.stringify(draftOf(resume));
const period = (start: string, end: string) => [start, end || (start ? 'atual' : '')].filter(Boolean).join(' – ');

function move<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={cn(
        'grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-faint transition-colors duration-150 [&_svg]:size-3.5',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-35',
        danger ? 'hover:bg-bad/12 hover:text-bad' : 'hover:bg-surface-3 hover:text-ink disabled:hover:bg-transparent disabled:hover:text-faint',
      )}
    >
      {children}
    </button>
  );
}

/** Subir, descer e tirar do currículo: os três controles de qualquer item. `what` completa o nome acessível. */
function ItemControls({ what, index, count, onMove, onRemove }: { what: string; index: number; count: number; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton label={`Subir ${what}`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp aria-hidden /></IconButton>
      <IconButton label={`Descer ${what}`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown aria-hidden /></IconButton>
      <IconButton label={`Remover ${what} do currículo`} danger onClick={onRemove}><X aria-hidden /></IconButton>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <h5 id={id} className={cn(EYEBROW, 'mb-2')}>{title}</h5>
      {children}
    </div>
  );
}

/** Lista de itens somente leitura (vêm do perfil), que só podem ser reordenados ou removidos. */
function ReadonlyRows<T extends { id: string }>({ items, kind, text, sub, onMove, onRemove }: {
  items: T[]; kind: string; text: (item: T) => string; sub?: (item: T) => string;
  onMove: (index: number, by: -1 | 1) => void; onRemove: (index: number) => void;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2/40">
      {items.map((item, i) => (
        <li key={item.id} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] text-ink">{text(item)}</p>
            {sub?.(item) && <p className="break-words text-xs tabular-nums text-muted">{sub(item)}</p>}
          </div>
          <ItemControls what={`${kind} ${text(item)}`} index={i} count={items.length} onMove={(by) => onMove(i, by)} onRemove={() => onRemove(i)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Editor do currículo adaptado. Só o resumo e o texto de cada realização são editáveis; todo o resto é
 * cópia do perfil, mostrada como texto (nunca como marcação) e que só pode ser reordenada ou removida.
 * O que vai para a API é o rascunho (`draftOf`): ids e textos. O servidor refaz a cópia dos campos do perfil.
 */
export function TailoredResumeEditor({ jobId, tailored }: { jobId: number; tailored: TailoredDto }) {
  const [content, setContent] = useState<TailoredResume>(tailored.content);
  // Chegou outra versão do servidor (gerado de novo): o editor acompanha, a menos que haja edição pendente.
  const [base, setBase] = useState(tailored);
  if (tailored !== base) {
    if (signature(content) === signature(base.content)) setContent(tailored.content);
    setBase(tailored);
  }
  const [warnings, setWarnings] = useState<Violation[] | null>(null);
  const save = useSaveTailored(jobId);
  const pending = useRef<Promise<TailoredSaveDto> | null>(null);
  const summaryId = useId();
  const dirty = signature(content) !== signature(tailored.content);

  const setList = <K extends ListKey>(key: K, next: TailoredResume[K]) => setContent((c) => ({ ...c, [key]: next }));
  const moveIn = <K extends ListKey>(key: K) => (index: number, by: -1 | 1) =>
    setList(key, move(content[key] as readonly unknown[], index, by) as TailoredResume[K]);
  const dropFrom = <K extends ListKey>(key: K) => (index: number) =>
    setList(key, (content[key] as readonly unknown[]).filter((_, i) => i !== index) as TailoredResume[K]);
  const patchExperience = (index: number, achievements: TailoredResume['experiences'][number]['achievements']) =>
    setList('experiences', content.experiences.map((e, i) => (i === index ? { ...e, achievements } : e)));

  /** Um salvamento por vez: quem pedir outro enquanto um está em curso espera o mesmo. */
  function saveNow(): Promise<TailoredSaveDto> {
    if (pending.current) return pending.current;
    const run = save.mutateAsync(draftOf(content)).then((saved) => {
      setBase(saved.tailored);
      setContent(saved.tailored.content);
      setWarnings(saved.warnings);
      return saved;
    }).finally(() => {
      pending.current = null;
    });
    pending.current = run;
    return run;
  }

  // O erro já vira aviso pelo MutationCache global; aqui só evita a rejeição sem tratamento.
  const onSave = () => void saveNow().catch(() => {});

  /** Com alterações não salvas, "baixar" salva primeiro e só então navega para o PDF (mesma origem). */
  async function onDownload(e: MouseEvent<HTMLAnchorElement>) {
    if (!dirty && !pending.current) return; // segue o link normalmente
    e.preventDefault();
    try {
      await saveNow();
      window.location.assign(tailoredPdfUrl(jobId));
    } catch {
      // o aviso com o motivo já apareceu; nada é baixado
    }
  }

  return (
    <div data-testid="tailored-editor" className="space-y-4 rounded-2xl border border-line bg-surface-2/35 p-4">
      <Notice tone="info" icon={<Eye />} title="Leia antes de enviar">{VERIFIER_LIMIT}</Notice>

      {tailored.stale && <Notice tone="warn">Seu perfil mudou depois que este currículo foi gerado.</Notice>}

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={summaryId} className={LABEL}>Resumo</label>
          <span className="text-[11px] text-faint">{tailored.lang === 'pt-BR' ? 'em português' : 'em inglês'}</span>
        </div>
        <Textarea
          id={summaryId} data-testid="tailored-summary" value={content.summary} rows={5} maxLength={LIMITS.profileLong}
          onChange={(e) => setContent((c) => ({ ...c, summary: e.target.value }))}
        />
      </div>

      <p className="flex items-start gap-2 text-xs leading-snug text-muted">
        <Lock aria-hidden className="mt-px size-3.5 shrink-0 text-faint" />
        Estes dados vêm do seu perfil. Para mudá-los, edite o perfil em Meu perfil. Aqui você só reordena ou tira itens deste currículo.
      </p>

      {content.experiences.length > 0 && (
        <Group title="Experiências">
          <div className="space-y-2.5">
            {content.experiences.map((exp, i) => (
              <div key={exp.id} className="rounded-xl border border-line bg-surface-2/60 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[13px] font-semibold text-ink">{exp.title}</p>
                    <p className="break-words text-[13px] text-ink-2">{exp.company}</p>
                    <p className="text-xs tabular-nums text-muted">{[period(exp.start, exp.end), exp.location].filter(Boolean).join(' · ')}</p>
                  </div>
                  <ItemControls
                    what={`experiência ${exp.company || exp.title}`} index={i} count={content.experiences.length}
                    onMove={(by) => moveIn('experiences')(i, by)} onRemove={() => dropFrom('experiences')(i)}
                  />
                </div>
                {exp.achievements.length > 0 && (
                  <ul className="mt-2.5 space-y-2">
                    {exp.achievements.map((ach, n) => (
                      <li key={ach.sourceId} className="flex items-start gap-1.5">
                        <Textarea
                          value={ach.text} rows={2} maxLength={LIMITS.profileLong} aria-label={`Realização ${n + 1} de ${exp.title || exp.company}`}
                          onChange={(e) => patchExperience(i, exp.achievements.map((a, k) => (k === n ? { ...a, text: e.target.value } : a)))}
                          className="min-h-[3.75rem] py-2 text-[13px]"
                        />
                        <ItemControls
                          what={`realização ${n + 1} de ${exp.title || exp.company}`} index={n} count={exp.achievements.length}
                          onMove={(by) => patchExperience(i, move(exp.achievements, n, by))}
                          onRemove={() => patchExperience(i, exp.achievements.filter((_, k) => k !== n))}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Group>
      )}

      {content.education.length > 0 && (
        <Group title="Formação">
          <ReadonlyRows
            items={content.education} kind="formação" text={(e) => e.degree || e.institution}
            sub={(e) => [e.degree ? e.institution : '', period(e.start, e.end)].filter(Boolean).join(' · ')}
            onMove={moveIn('education')} onRemove={dropFrom('education')}
          />
        </Group>
      )}

      {content.skills.length > 0 && (
        <Group title="Habilidades">
          <ul className="flex flex-wrap gap-1.5">
            {content.skills.map((skill, i) => (
              <li key={skill.id} className="inline-flex h-8 items-center rounded-lg border border-line bg-surface-2/60 pl-0.5 pr-0.5">
                <IconButton label={`Subir habilidade ${skill.name}`} disabled={i === 0} onClick={() => moveIn('skills')(i, -1)}><ChevronLeft aria-hidden /></IconButton>
                <span className="px-0.5 text-[13px] text-ink">{skill.name}</span>
                <IconButton label={`Descer habilidade ${skill.name}`} disabled={i === content.skills.length - 1} onClick={() => moveIn('skills')(i, 1)}><ChevronRight aria-hidden /></IconButton>
                <IconButton label={`Remover habilidade ${skill.name} do currículo`} danger onClick={() => dropFrom('skills')(i)}><X aria-hidden /></IconButton>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {content.languages.length > 0 && (
        <Group title="Idiomas">
          <ReadonlyRows items={content.languages} kind="idioma" text={(l) => l.name} sub={(l) => l.level} onMove={moveIn('languages')} onRemove={dropFrom('languages')} />
        </Group>
      )}

      {content.certifications.length > 0 && (
        <Group title="Certificações">
          <ReadonlyRows
            items={content.certifications} kind="certificação" text={(c) => c.name} sub={(c) => [c.issuer, c.date].filter(Boolean).join(' · ')}
            onMove={moveIn('certifications')} onRemove={dropFrom('certifications')}
          />
        </Group>
      )}

      {content.links.length > 0 && (
        <Group title="Links">
          {/* A URL é mostrada como texto: nada vindo do currículo vira `href` aqui. */}
          <ReadonlyRows items={content.links} kind="link" text={(l) => l.label || l.url} sub={(l) => (l.label ? l.url : '')} onMove={moveIn('links')} onRemove={dropFrom('links')} />
        </Group>
      )}

      {warnings !== null && warnings.length > 0 && (
        <Notice tone="warn" role="status" data-testid="tailored-warnings" title="Salvo, com avisos (confira se é isso mesmo):">
          <ul className="mt-1 space-y-1">
            {warnings.map((w, i) => <li key={i} className="break-words">{w.message}</li>)}
          </ul>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="button" variant="primary" data-testid="tailored-save" disabled={!dirty || save.isPending} onClick={onSave}>
          {save.isPending && <LoaderCircle aria-hidden className="animate-spin" />}
          {save.isPending ? 'Salvando…' : 'Salvar currículo'}
        </Button>
        <Button asChild>
          <a href={tailoredPdfUrl(jobId)} download data-testid="tailored-download" onClick={onDownload}>
            <Download aria-hidden /> {dirty ? 'Salvar e baixar PDF' : 'Baixar PDF'}
          </a>
        </Button>
        {dirty && !save.isPending && (
          <Button type="button" variant="ghost" onClick={() => setContent(tailored.content)}>Descartar</Button>
        )}
        <span aria-live="polite" className={cn('text-xs', dirty ? 'text-warn' : 'text-faint')}>
          {dirty ? 'Há alterações não salvas.' : warnings !== null && warnings.length === 0 ? 'Salvo.' : ''}
        </span>
      </div>
      <p className="text-xs text-faint">PDF de uma coluna, com texto selecionável, sem tabelas nem imagens.</p>
    </div>
  );
}

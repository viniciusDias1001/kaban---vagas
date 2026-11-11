import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { LEVELS, MAX_AGES, REGIONS, type Level, type MaxAge, type ProfileInput, type Region } from '@kv/shared';
import { api } from '../api';
import { showToast } from '../toast';

const LEVEL_LABEL: Record<Level, string> = { junior: 'Júnior', pleno: 'Pleno', senior: 'Sênior' };
const REGION_LABEL: Record<Region, string> = { brasil: 'Brasil', exterior: 'Exterior', remoto: 'Remoto' };
const AGE_LABEL: Record<MaxAge, string> = { 1: 'Últimas 24 h', 3: 'Últimos 3 dias', 7: 'Últimos 7 dias', 30: 'Últimos 30 dias' };

const EMPTY: ProfileInput = { name: '', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources: [], active: true };

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function Checks<T extends string>(props: {
  legend: string; options: readonly T[]; label: (o: T) => string; value: T[]; onChange: (v: T[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs text-muted">{props.legend}</legend>
      <div className="flex flex-wrap gap-2">
        {props.options.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-1.5 rounded border border-line bg-surface-2 px-2 py-1 text-sm">
            <input type="checkbox" checked={props.value.includes(o)} onChange={() => props.onChange(toggle(props.value, o))} />
            {props.label(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ProfilesPage({ onRunQueued }: { onRunQueued: () => void }) {
  const qc = useQueryClient();
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const [form, setForm] = useState<ProfileInput>(EMPTY);
  const [stacksText, setStacksText] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['profiles'] });

  const create = useMutation({
    mutationFn: api.createProfile,
    onSuccess: () => {
      setForm(EMPTY);
      setStacksText('');
      refresh();
    },
  });
  const setActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => api.updateProfile(v.id, { active: v.active }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteProfile, onSuccess: refresh });
  const runNow = useMutation({
    mutationFn: api.runNow,
    onSuccess: (r) => {
      if (r.queued === 0) return showToast('Já existe uma busca em andamento', 'info');
      showToast(`Busca enfileirada em ${r.queued} ${r.queued === 1 ? 'fonte' : 'fontes'}`, 'info');
      onRunQueued();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const stacks = stacksText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    create.mutate({ ...form, stacks });
  }

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="grid h-full grid-cols-[24rem_1fr] gap-6 overflow-y-auto p-6">
      <form onSubmit={submit} className="space-y-4 self-start rounded-xl border border-line bg-surface p-5">
        <h2 className="font-semibold">Novo perfil de busca</h2>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Nome</span>
          <input
            required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="React Pleno remoto"
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Stacks (separadas por vírgula)</span>
          <input
            value={stacksText} onChange={(e) => setStacksText(e.target.value)} placeholder="react, node, typescript"
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <Checks legend="Nível" options={LEVELS} label={(l) => LEVEL_LABEL[l]} value={form.levels} onChange={(levels) => setForm({ ...form, levels })} />
        <Checks legend="Região" options={REGIONS} label={(r) => REGION_LABEL[r]} value={form.regions} onChange={(regions) => setForm({ ...form, regions })} />
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Vaga aberta há no máximo</span>
          <select
            value={form.maxAgeDays} onChange={(e) => setForm({ ...form, maxAgeDays: Number(e.target.value) as MaxAge })}
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm"
          >
            {MAX_AGES.map((a) => (
              <option key={a} value={a}>{AGE_LABEL[a]}</option>
            ))}
          </select>
        </label>
        <Checks
          legend="Fontes" options={sources.map((s) => s.id)} label={sourceName}
          value={form.sources} onChange={(s) => setForm({ ...form, sources: s })}
        />
        <button
          type="submit" disabled={create.isPending || form.sources.length === 0}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
        >
          Salvar perfil
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="font-semibold">Perfis</h2>
        {profiles.length === 0 && <p className="text-sm text-muted">Nenhum perfil ainda.</p>}
        {profiles.map((p) => (
          <article key={p.id} data-testid="profile" className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="font-medium">{p.name}</h3>
                <p className="text-xs text-muted">
                  {p.stacks.join(', ') || 'qualquer stack'} · {p.levels.map((l) => LEVEL_LABEL[l]).join(', ') || 'qualquer nível'} ·{' '}
                  {p.regions.map((r) => REGION_LABEL[r]).join(', ') || 'qualquer região'} · {AGE_LABEL[p.maxAgeDays]}
                </p>
                <p className="mt-1 text-xs text-muted">Fontes: {p.sources.map(sourceName).join(', ')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox" checked={p.active}
                    onChange={(e) => setActive.mutate({ id: p.id, active: e.target.checked })}
                  />
                  Ativo
                </label>
                <button
                  onClick={() => runNow.mutate(p.id)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg"
                >
                  Buscar agora
                </button>
                <button
                  onClick={() => confirm(`Excluir o perfil "${p.name}"?`) && remove.mutate(p.id)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-bad"
                >
                  Excluir
                </button>
              </div>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

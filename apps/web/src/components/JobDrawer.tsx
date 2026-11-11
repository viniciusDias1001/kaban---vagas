import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { COLUMN_LABELS } from '@kv/shared';
import { api } from '../api';

const ACTOR_LABEL = { ia: 'IA', humano: 'Você', sistema: 'Sistema' } as const;

function DrawerContent({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['job', id], queryFn: () => api.job(id) });
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (data) setNotes(data.job.notes);
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.patchJob(id, { notes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }),
  });

  if (!data) return <p className="p-6 text-muted">Carregando…</p>;
  const { job, events } = data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-line p-5">
        <div>
          <h2 className="text-lg font-semibold">{job.title}</h2>
          <p className="text-sm text-muted">
            {job.company} · {job.remote ? 'Remoto' : job.location || 'Local n/d'} · {job.source}
          </p>
        </div>
        <button onClick={onClose} aria-label="Fechar" className="rounded px-2 py-1 text-muted hover:text-ink">✕</button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <a
          href={job.url} target="_blank" rel="noreferrer"
          className="inline-block rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          Abrir vaga original ↗
        </a>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Análise IA</h3>
          <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">
            Disponível quando o módulo de IA for instalado: pontos fortes do seu perfil para esta vaga e o que revisar antes da entrevista.
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Notas</h3>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== job.notes && save.mutate()}
            rows={4}
            aria-label="Notas"
            className="w-full rounded-lg border border-line bg-surface-2 p-3 text-sm outline-none focus:border-accent"
          />
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Descrição</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/90">
            {job.description || 'Esta fonte não entrega a descrição na busca. Abra a vaga original para ler.'}
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Histórico</h3>
          <ul className="space-y-1 text-sm text-muted">
            {events.map((e) => (
              <li key={e.id}>
                {new Date(e.createdAt).toLocaleString('pt-BR')} — {ACTOR_LABEL[e.actor]}:{' '}
                {e.fromColumn ? `${COLUMN_LABELS[e.fromColumn]} → ` : ''}
                {COLUMN_LABELS[e.toColumn]}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function JobDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {id !== null && (
        <>
          <motion.div
            key="backdrop" className="fixed inset-0 bg-black/50" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          />
          <motion.aside
            key="drawer" role="dialog" aria-label="Detalhe da vaga"
            className="fixed right-0 top-0 h-full w-full max-w-xl border-l border-line bg-surface shadow-2xl"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
          >
            <DrawerContent id={id} onClose={onClose} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

const STATUS = {
  ok: { label: 'OK', tone: 'bg-ok/20 text-ok' },
  error: { label: 'Erro', tone: 'bg-bad/20 text-bad' },
  never: { label: 'Nunca rodou', tone: 'bg-surface-2 text-muted' },
} as const;

export function HealthPanel() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-1 font-semibold">Saúde das fontes</h2>
      <p className="mb-4 text-sm text-muted">
        Última execução de cada conector. LinkedIn e Indeed dependem de páginas públicas e podem falhar por bloqueio.
      </p>
      <table className="w-full max-w-4xl overflow-hidden rounded-xl border border-line bg-surface text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2">Fonte</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Encontradas</th>
            <th className="px-4 py-2">Novas</th>
            <th className="px-4 py-2">Última execução</th>
            <th className="px-4 py-2">Erro</th>
          </tr>
        </thead>
        <tbody>
          {(data?.sources ?? []).map((s) => (
            <tr key={s.source} className="border-t border-line" data-testid={`health-${s.source}`}>
              <td className="px-4 py-2 font-medium">{s.name}</td>
              <td className="px-4 py-2">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
              </td>
              <td className="px-4 py-2 tabular-nums">{s.found}</td>
              <td className="px-4 py-2 tabular-nums">{s.inserted}</td>
              <td className="px-4 py-2 text-muted">
                {s.finishedAt ? new Date(s.finishedAt).toLocaleString('pt-BR') : '—'}
              </td>
              <td className="px-4 py-2 text-bad">{s.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { SourceMark } from './SourceMark';
import { Badge } from './ui/badge';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

const STATUS = {
  ok: { label: 'OK', tone: 'ok', dot: 'bg-ok' },
  error: { label: 'Erro', tone: 'bad', dot: 'bg-bad' },
  never: { label: 'Nunca rodou', tone: 'outline', dot: 'bg-faint' },
} as const;

const MotionRow = motion.create(TableRow);

export function HealthPanel() {
  const { data, isPending } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });
  const sources = data?.sources ?? [];
  const count = (status: keyof typeof STATUS) => sources.filter((s) => s.status === status).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}
          className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
        >
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">Saúde das fontes</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Última execução de cada conector. LinkedIn e Indeed dependem de páginas públicas e podem falhar por bloqueio.
            </p>
          </div>
          {sources.length > 0 && (
            <div className="flex gap-1.5">
              <Badge size="md" tone="ok">{count('ok')} OK</Badge>
              {count('error') > 0 && <Badge size="md" tone="bad">{count('error')} com erro</Badge>}
              {count('never') > 0 && <Badge size="md" tone="outline">{count('never')} sem rodar</Badge>}
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 }}
          className="overflow-hidden rounded-3xl border border-line bg-surface/85 shadow-raised"
        >
          <Table className="min-w-[44rem]">
            <TableHeader className="bg-surface-2/60">
              <tr>
                <TableHead>Fonte</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Encontradas</TableHead>
                <TableHead className="text-right">Novas</TableHead>
                <TableHead>Última execução</TableHead>
                <TableHead>Erro</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden className="border-t border-line">
                    {[28, 14, 8, 8, 32, 0].map((w, c) => (
                      <td key={c} className="px-4 py-3.5">
                        {w > 0 && <Skeleton className="h-4" style={{ width: `${w * 4}px` }} />}
                      </td>
                    ))}
                  </tr>
                ))}
              {sources.map((s, i) => (
                <MotionRow
                  key={s.source} data-testid={`health-${s.source}`}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, delay: 0.08 + i * 0.025 }}
                >
                  <TableCell>
                    <span className="flex items-center gap-2.5 font-medium text-ink">
                      <SourceMark source={s.source} size="md" /> {s.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge size="md" tone={STATUS[s.status].tone} className="gap-1.5">
                      <span aria-hidden className={cn('size-1.5 rounded-full', STATUS[s.status].dot)} />
                      {STATUS[s.status].label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-ink-2">{s.found}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', s.inserted > 0 ? 'font-semibold text-ok' : 'text-muted')}>
                    {s.inserted}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted">
                    {s.finishedAt ? new Date(s.finishedAt).toLocaleString('pt-BR') : '—'}
                  </TableCell>
                  <TableCell className="max-w-72 text-[13px] leading-snug text-bad">{s.error ?? ''}</TableCell>
                </MotionRow>
              ))}
              {!isPending && sources.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">Nenhuma fonte para mostrar.</td>
                </tr>
              )}
            </TableBody>
          </Table>
        </motion.div>
      </div>
    </div>
  );
}

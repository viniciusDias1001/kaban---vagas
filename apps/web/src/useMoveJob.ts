import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { Column, JobDetailDto, JobListItemDto } from '@kv/shared/client';
import { api } from './api';
import { applyMove, groupByColumn, mergeServerJob } from './lib/board';
import { dropPosition, isNoopMove } from './position';

/** A única consulta do quadro: todas as vagas, sem filtro (o filtro de texto é aplicado no cliente). */
export const JOBS_KEY = ['jobs'] as const;
/** Chave comum a todos os movimentos de card, para saber se ainda há outro em andamento. */
export const MOVE_KEY = ['jobs', 'move'] as const;

interface MoveVars {
  id: number;
  column: Column;
  /** Ausente só quando o quadro não está em cache (não dá para calcular): a API mantém a posição atual. */
  position?: number;
}

/**
 * Move uma vaga de coluna/posição. É o mesmo caminho para o arraste no quadro e para o "Mover para" do
 * detalhe da vaga: a posição sai sempre da coluna real e completa que está no cache (nunca da lista
 * filtrada ou da fatia renderizada).
 *
 * - otimista: o card muda de lugar na hora; se o PATCH falhar, volta para onde estava (o aviso com a
 *   mensagem da API sai pelo `onError` global do MutationCache);
 * - depois do PATCH vale o servidor: a vaga é atualizada com a resposta e o quadro é consultado de novo
 *   (uma renumeração pode ter mudado a posição dos vizinhos);
 * - dois movimentos seguidos: o quadro só é consultado de novo quando o ÚLTIMO termina. Um refetch
 *   disparado pelo primeiro chegaria sem o segundo movimento e faria o segundo card voltar por um instante.
 */
export function useMoveJob() {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationKey: MOVE_KEY,
    mutationFn: (v: MoveVars) => api.patchJob(v.id, { column: v.column, position: v.position }),
    onMutate: async (v) => {
      // Um refetch em andamento traria o quadro de antes do movimento e desfaria a mudança otimista.
      await qc.cancelQueries({ queryKey: JOBS_KEY });
      const before = qc.getQueryData<JobListItemDto[]>(JOBS_KEY)?.find((j) => j.id === v.id);
      qc.setQueryData<JobListItemDto[]>(JOBS_KEY, (old) => old && applyMove(old, v.id, v.column, v.position ?? before?.position ?? 0));
      return { before: before && { column: before.column, position: before.position } };
    },
    onError: (_err, v, ctx) => {
      const before = ctx?.before;
      if (before) qc.setQueryData<JobListItemDto[]>(JOBS_KEY, (old) => old && applyMove(old, v.id, before.column, before.position));
    },
    onSuccess: (job) => {
      qc.setQueryData<JobListItemDto[]>(JOBS_KEY, (old) => old && mergeServerJob(old, job));
      qc.setQueryData<JobDetailDto>(['job', job.id], (old) => old && { ...old, job });
    },
    onSettled: (_data, _err, v) => {
      void qc.invalidateQueries({ queryKey: ['job', v.id] }); // o histórico ganhou um evento
      // Este movimento ainda conta como pendente aqui; mais de um = há outro PATCH a caminho.
      if (qc.isMutating({ mutationKey: MOVE_KEY }) > 1) return;
      void qc.invalidateQueries({ queryKey: JOBS_KEY });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
  const { mutate } = mutation;

  /** Move para antes de `beforeId` na ordem real da coluna, ou para o fim de verdade dela (`null`). */
  const moveTo = useCallback(
    (id: number, column: Column, beforeId: number | null) => {
      const jobs = qc.getQueryData<JobListItemDto[]>(JOBS_KEY);
      if (!jobs) return mutate({ id, column });
      const target = groupByColumn(jobs)[column];
      if (isNoopMove(target, id, beforeId)) return;
      mutate({ id, column, position: dropPosition(target, id, beforeId) });
    },
    [qc, mutate],
  );

  return { moveTo, isPending: mutation.isPending };
}

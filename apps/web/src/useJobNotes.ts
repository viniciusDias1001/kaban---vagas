import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { LIMITS, type JobDetailDto, type JobListItemDto } from '@kv/shared';
import { api } from './api';
import { NotesController, NotesStore, type NotesSnapshot } from './notes';
import { showToast } from './toast';
import { JOBS_KEY } from './useMoveJob';

const store = new NotesStore();

function createController(jobId: number, qc: QueryClient): NotesController {
  return new NotesController({
    maxLength: LIMITS.notes,
    save: async (text) => {
      const job = await api.patchJob(jobId, { notes: text });
      // Os caches passam a ter o texto salvo: reabrir a vaga não semeia o campo com o texto antigo.
      qc.setQueryData<JobDetailDto>(['job', jobId], (old) => old && { ...old, job: { ...old.job, notes: job.notes } });
      qc.setQueryData<JobListItemDto[]>(JOBS_KEY, (old) => old?.map((j) => (j.id === jobId ? { ...j, notes: job.notes } : j)));
    },
    onDetachedError: (message) =>
      showToast(`As notas não foram salvas: ${message} O texto ficou guardado; abra a vaga para tentar de novo.`),
  });
}

/**
 * Notas da vaga aberta no painel. `serverNotes` (do detalhe da vaga) só semeia o campo uma vez por vaga;
 * salvar acontece no blur e quando o painel fecha/desmonta com texto pendente. Ver `NotesController`.
 */
export function useJobNotes(jobId: number, serverNotes: string | undefined): NotesSnapshot & {
  edit: (text: string) => void;
  flush: () => void;
} {
  const qc = useQueryClient();
  const controller = useMemo(() => store.acquire(jobId, () => createController(jobId, qc)), [jobId, qc]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (serverNotes !== undefined) controller.seed(serverNotes);
  }, [controller, serverNotes]);

  // Painel fechado (ou outra vaga aberta) com texto pendente: salva. O controlador só sai da memória
  // quando o servidor tem o texto; se o salvamento falhar, ele fica para a próxima vez que a vaga abrir.
  useEffect(
    () => () => {
      const saving = controller.flush();
      store.release(jobId, controller);
      void saving.finally(() => store.release(jobId, controller));
    },
    [controller, jobId],
  );

  return useMemo(
    () => ({ ...snapshot, edit: (text: string) => controller.edit(text), flush: () => void controller.flush() }),
    [snapshot, controller],
  );
}

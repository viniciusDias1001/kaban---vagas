import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

const CATCH_UP_EVERY_MS = 2_000;
const CATCH_UP_FOR_MS = 30_000;
const KEYS = ['jobs', 'stats', 'health', 'jobs-ai'] as const;

/**
 * Depois de "Buscar agora", o worker leva alguns segundos para pegar a fila e as vagas novas só apareceriam
 * no próximo refetch normal (15 s). Quem chama `start()` faz o quadro, os contadores e a saúde das fontes
 * refazerem a consulta a cada 2 s durante 30 s; depois disso volta tudo ao intervalo normal de cada tela.
 * Vive no App (e não na tela de perfis) para continuar valendo quando o usuário vai para o quadro.
 */
export function useRunCatchUp(): () => void {
  const qc = useQueryClient();
  const [until, setUntil] = useState(0);

  useEffect(() => {
    if (until === 0) return;
    const id = setInterval(() => {
      if (Date.now() >= until) {
        clearInterval(id);
        setUntil(0);
        return;
      }
      for (const key of KEYS) void qc.invalidateQueries({ queryKey: [key] });
    }, CATCH_UP_EVERY_MS);
    return () => clearInterval(id);
  }, [until, qc]);

  return useCallback(() => setUntil(Date.now() + CATCH_UP_FOR_MS), []);
}

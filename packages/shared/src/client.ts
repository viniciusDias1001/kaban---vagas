/**
 * Entrada de `@kv/shared` para o navegador: só constantes, helpers puros e tipos, sem Zod no bundle.
 * Regra: nada aqui pode importar `zod` nem `./schemas` em tempo de execução (só `export type`, apagado no
 * build). O teste `apps/web/src/bundle.test.ts` falha se isso for quebrado.
 */
export * from './constants';
export type * from './dto';
export type { SearchFilters, ProfileInput, ProfilePatch, NormalizedJob, JobPatch } from './schemas';

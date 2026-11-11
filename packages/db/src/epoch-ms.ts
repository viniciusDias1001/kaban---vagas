import { customType } from 'drizzle-orm/pg-core';

/**
 * `timestamp with time zone` no banco (legível no Supabase), epoch em milissegundos no TypeScript.
 * O resto do código e os DTOs do web continuam trabalhando com `number`.
 * O driver pode devolver string (postgres-js e PGlite sob Drizzle) ou Date — aceitamos os dois.
 */
export const epochMs = customType<{ data: number; driverData: string | Date }>({
  dataType: () => 'timestamp with time zone',
  toDriver: (ms) => new Date(ms).toISOString(),
  fromDriver: (value) => (value instanceof Date ? value : new Date(value)).getTime(),
});

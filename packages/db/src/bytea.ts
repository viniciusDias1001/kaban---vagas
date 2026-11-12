import { customType } from 'drizzle-orm/pg-core';

/**
 * Coluna `bytea`: Buffer no TypeScript. O postgres-js devolve Buffer e o PGlite devolve Uint8Array;
 * `Buffer.from` aceita os dois.
 */
export const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

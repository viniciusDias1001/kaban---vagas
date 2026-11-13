import { eq } from 'drizzle-orm';
import type { SecretName } from '@kv/shared';
import type { Db } from './client';
import { appSecrets } from './schema';

/**
 * Linhas de `app_secrets`. O banco só guarda o texto já cifrado (`sealed`); quem cifra e decifra é
 * `@kv/settings`. Nada aqui recebe nem devolve o valor em texto puro.
 */

export async function saveSecretRow(db: Db, name: SecretName, sealed: Buffer, now: number = Date.now()): Promise<void> {
  await db
    .insert(appSecrets)
    .values({ name, sealed, updatedAt: now })
    .onConflictDoUpdate({ target: appSecrets.name, set: { sealed, updatedAt: now } });
}

export async function secretRow(db: Db, name: SecretName): Promise<{ sealed: Uint8Array; updatedAt: number } | null> {
  const [row] = await db.select().from(appSecrets).where(eq(appSecrets.name, name));
  return row ? { sealed: row.sealed, updatedAt: row.updatedAt } : null;
}

export async function deleteSecretRow(db: Db, name: SecretName): Promise<void> {
  await db.delete(appSecrets).where(eq(appSecrets.name, name));
}

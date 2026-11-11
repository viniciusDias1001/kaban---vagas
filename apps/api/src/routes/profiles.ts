import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { searchProfiles, type Db } from '@kv/db';
import { ProfileInputSchema, ProfilePatchSchema } from '@kv/shared';
import { idParam } from './ids';

const notFound = { error: 'not_found', message: 'perfil não encontrado' };

/**
 * Mensagem de erro se `sources` tem alguma fonte que não existe (um run dela falharia a cada hora), ou
 * null. As fontes válidas são as de `getConnectors()`: `fake` só existe com FAKE_CONNECTORS=1.
 */
function unknownSources(sources: string[] | undefined): string | null {
  if (!sources) return null;
  const known = getConnectors().map((c) => c.id);
  const unknown = [...new Set(sources.filter((s) => !known.includes(s)))];
  if (unknown.length === 0) return null;
  const which = unknown.map((s) => `"${s}"`).join(', ');
  const label = unknown.length === 1 ? 'fonte desconhecida' : 'fontes desconhecidas';
  return `sources: ${label}: ${which}. Fontes disponíveis: ${known.join(', ')}`;
}

export function profileRoutes(app: FastifyInstance, db: Db) {
  app.get('/profiles', () => db.select().from(searchProfiles).orderBy(desc(searchProfiles.id)));

  app.post('/profiles', async (req, reply) => {
    const input = ProfileInputSchema.parse(req.body);
    const invalid = unknownSources(input.sources);
    if (invalid) return reply.code(400).send({ error: 'validation', message: invalid });
    const [row] = await db.insert(searchProfiles).values({ ...input, createdAt: Date.now() }).returning();
    return reply.code(201).send(row);
  });

  app.patch('/profiles/:id', async (req, reply) => {
    const id = idParam(req);
    const patch = ProfilePatchSchema.parse(req.body);
    const invalid = unknownSources(patch.sources);
    if (invalid) return reply.code(400).send({ error: 'validation', message: invalid });
    if (id === null) return reply.code(404).send(notFound);
    const [row] =
      Object.keys(patch).length > 0
        ? await db.update(searchProfiles).set(patch).where(eq(searchProfiles.id, id)).returning()
        : await db.select().from(searchProfiles).where(eq(searchProfiles.id, id));
    if (!row) return reply.code(404).send(notFound);
    return row;
  });

  // As vagas do perfil continuam no quadro (FK ON DELETE SET NULL); os runs dele são removidos (CASCADE).
  app.delete('/profiles/:id', async (req, reply) => {
    const id = idParam(req);
    if (id !== null) await db.delete(searchProfiles).where(eq(searchProfiles.id, id));
    return reply.code(204).send();
  });
}

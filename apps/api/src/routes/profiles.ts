import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { searchProfiles, type Db } from '@kv/db';
import { ProfileInputSchema, ProfilePatchSchema } from '@kv/shared';
import { idParam } from './ids';

const notFound = { error: 'not_found', message: 'perfil não encontrado' };

export function profileRoutes(app: FastifyInstance, db: Db) {
  app.get('/profiles', () => db.select().from(searchProfiles).orderBy(desc(searchProfiles.id)));

  app.post('/profiles', async (req, reply) => {
    const input = ProfileInputSchema.parse(req.body);
    const [row] = await db.insert(searchProfiles).values({ ...input, createdAt: Date.now() }).returning();
    return reply.code(201).send(row);
  });

  app.patch('/profiles/:id', async (req, reply) => {
    const id = idParam(req);
    const patch = ProfilePatchSchema.parse(req.body);
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

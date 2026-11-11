import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { searchProfiles, type Db } from '@kv/db';
import { ProfileInputSchema, ProfilePatchSchema } from '@kv/shared';

const notFound = { error: 'not_found', message: 'perfil não encontrado' };
const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

export function profileRoutes(app: FastifyInstance, db: Db) {
  app.get('/profiles', () => db.select().from(searchProfiles).orderBy(desc(searchProfiles.id)).all());

  app.post('/profiles', (req, reply) => {
    const input = ProfileInputSchema.parse(req.body);
    const row = db.insert(searchProfiles).values({ ...input, createdAt: Date.now() }).returning().get();
    return reply.code(201).send(row);
  });

  app.patch('/profiles/:id', (req, reply) => {
    const id = idOf(req);
    const patch = ProfilePatchSchema.parse(req.body);
    const existing = db.select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
    if (!existing) return reply.code(404).send(notFound);
    if (Object.keys(patch).length > 0) {
      db.update(searchProfiles).set(patch).where(eq(searchProfiles.id, id)).run();
    }
    return db.select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
  });

  app.delete('/profiles/:id', (req, reply) => {
    db.delete(searchProfiles).where(eq(searchProfiles.id, idOf(req))).run();
    return reply.code(204).send();
  });
}

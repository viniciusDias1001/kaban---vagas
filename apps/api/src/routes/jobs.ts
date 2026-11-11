import { and, asc, eq, like, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { jobEvents, jobs, type Db } from '@kv/db';
import { ColumnSchema, JobPatchSchema } from '@kv/shared';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };
const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

export function jobRoutes(app: FastifyInstance, db: Db) {
  app.get('/jobs', (req) => {
    const query = req.query as { column?: string; profile?: string; source?: string; q?: string };
    const where: SQL[] = [];
    if (query.column) where.push(eq(jobs.column, ColumnSchema.parse(query.column)));
    if (query.profile) where.push(eq(jobs.profileId, Number(query.profile)));
    if (query.source) where.push(eq(jobs.source, query.source));
    if (query.q) {
      const term = `%${query.q}%`;
      where.push(or(like(jobs.title, term), like(jobs.company, term))!);
    }
    return db.select().from(jobs).where(and(...where)).orderBy(asc(jobs.position)).all();
  });

  app.get('/jobs/:id', (req, reply) => {
    const id = idOf(req);
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return reply.code(404).send(notFound);
    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(asc(jobEvents.id)).all();
    return { job, events };
  });

  app.patch('/jobs/:id', (req, reply) => {
    const id = idOf(req);
    const patch = JobPatchSchema.parse(req.body);
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return reply.code(404).send(notFound);

    const set: Partial<typeof jobs.$inferInsert> = {};
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.column && patch.column !== job.column) {
      set.column = patch.column;
      if (patch.column === 'aplicada' && !job.appliedBy) set.appliedBy = 'humano';
      db.insert(jobEvents)
        .values({ jobId: id, fromColumn: job.column, toColumn: patch.column, actor: 'humano', createdAt: Date.now() })
        .run();
    }
    if (Object.keys(set).length > 0) db.update(jobs).set(set).where(eq(jobs.id, id)).run();
    return db.select().from(jobs).where(eq(jobs.id, id)).get();
  });
}

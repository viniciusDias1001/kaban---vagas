import { and, asc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { jobEvents, jobs, type Db } from '@kv/db';
import { ColumnSchema, JobPatchSchema } from '@kv/shared';
import { idParam, parseId } from './ids';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };

export function jobRoutes(app: FastifyInstance, db: Db) {
  app.get('/jobs', async (req) => {
    const query = req.query as { column?: string; profile?: string; source?: string; q?: string };
    const where: SQL[] = [];
    if (query.column) where.push(eq(jobs.column, ColumnSchema.parse(query.column)));
    if (query.profile) {
      const profileId = parseId(query.profile);
      if (profileId === null) return [];
      where.push(eq(jobs.profileId, profileId));
    }
    if (query.source) where.push(eq(jobs.source, query.source));
    if (query.q) {
      const term = `%${query.q}%`;
      where.push(or(ilike(jobs.title, term), ilike(jobs.company, term))!);
    }
    return db.select().from(jobs).where(and(...where)).orderBy(asc(jobs.position), asc(jobs.id));
  });

  app.get('/jobs/:id', async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send(notFound);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!job) return reply.code(404).send(notFound);
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(asc(jobEvents.id));
    return { job, events };
  });

  app.patch('/jobs/:id', async (req, reply) => {
    const id = idParam(req);
    const patch = JobPatchSchema.parse(req.body);
    if (id === null) return reply.code(404).send(notFound);

    const updated = await db.transaction(async (tx) => {
      // FOR UPDATE: dois PATCH simultâneos na mesma vaga não gravam eventos com `fromColumn` errado.
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!job) return null;

      const set: Partial<typeof jobs.$inferInsert> = {};
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.column && patch.column !== job.column) {
        set.column = patch.column;
        if (patch.column === 'aplicada' && !job.appliedBy) set.appliedBy = 'humano';
        await tx
          .insert(jobEvents)
          .values({ jobId: id, fromColumn: job.column, toColumn: patch.column, actor: 'humano', createdAt: Date.now() });
      }
      if (Object.keys(set).length === 0) return job;
      const [row] = await tx.update(jobs).set(set).where(eq(jobs.id, id)).returning();
      return row;
    });
    if (!updated) return reply.code(404).send(notFound);
    return updated;
  });
}

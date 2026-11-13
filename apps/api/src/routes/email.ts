import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  alertById, approveReply, discardReply, dismissAlert, editReply, forceClassifyAll, jobEmails, jobs, linkThreadToJob, listIgnored,
  listMailMessages, mailMessageById, mailReplies, moveCardByEmail, openAlerts, reopenMessage, replyById, requestPromote, resolveAlerts,
  toMailReplyDto, undoEmailMove, unlinkThread, type AlertRow, type Db,
} from '@kv/db';
import {
  AlertMoveSchema, DRAFT_PLACEHOLDER, LinkMessageSchema, MailMessagesQuerySchema, ReplyApproveSchema, ReplyEditSchema, emailAvailability,
  type AlertKind,
} from '@kv/shared';
import type { AiContext } from '../ai-context';
import { idParam } from './ids';

const jobNotFound = { error: 'not_found', message: 'vaga não encontrada' };
const messageNotFound = { error: 'not_found', message: 'e-mail não encontrado' };
const ignoredNotFound = { error: 'not_found', message: 'e-mail ignorado não encontrado' };
const replyNotFound = { error: 'not_found', message: 'resposta não encontrada' };
const alertNotFound = { error: 'not_found', message: 'alerta não encontrado' };

const wrongState = { error: 'wrong_state', message: 'Esta resposta não pode mais ser aprovada ou descartada.' };
const replyChanged = { error: 'reply_changed', message: 'O texto desta resposta mudou. Confira o texto atual antes de enviar.' };
const alertClosed = { error: 'alert_closed', message: 'Este alerta já foi resolvido ou dispensado.' };

/**
 * Mensagens, respostas e alertas do e-mail. Nada aqui chama a IA nem envia: aprovar só põe a resposta na fila do worker.
 * As rotas que mudam estado respondem 409 `email_unavailable` fora de host local; as de leitura continuam respondendo.
 */
export function emailRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  /** Fora de host local responde 409 `email_unavailable` com o motivo. Devolve true se respondeu. */
  async function refuseOffLocalHost(reply: FastifyReply): Promise<boolean> {
    const { available, reason } = emailAvailability(process.env);
    if (available) return false;
    await reply.code(409).send({ error: 'email_unavailable', message: reason });
    return true;
  }

  const jobExists = async (id: number) => (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id))).length > 0;

  // ---------------------------------------------------------------- mensagens

  app.get('/email/messages', async (req) => {
    const { kind, unmatched, since } = MailMessagesQuerySchema.parse(req.query);
    return listMailMessages(db, { kind, unmatched: unmatched === '1', since });
  });

  app.get('/jobs/:id/emails', async (req, reply) => {
    const id = idParam(req);
    if (id === null || !(await jobExists(id))) return reply.code(404).send(jobNotFound);
    return jobEmails(db, id);
  });

  /** O dono liga o e-mail (e o fio dele) a um card: o aviso de "e-mail sem vaga" some e o worker age de novo sobre ele. */
  app.post('/email/messages/:id/link', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const { jobId } = LinkMessageSchema.parse(req.body);
    const id = idParam(req);
    if (id === null || !(await mailMessageById(db, id))) return reply.code(404).send(messageNotFound);
    if (!(await jobExists(jobId))) return reply.code(404).send(jobNotFound);
    await linkThreadToJob(db, id, jobId, ctx.now());
    await resolveAlerts(db, { kind: 'unmatched', mailMessageId: id }, ctx.now());
    return { ok: true };
  });

  /**
   * "Não é desta vaga": o movimento que o fio fez no card é desfeito (se ainda é o último), os alertas do fio somem e um
   * alerta de "e-mail sem vaga" pede o card certo.
   */
  app.post('/email/messages/:id/unlink', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    if (id === null || !(await unlinkThread(db, id, ctx.now()))) return reply.code(404).send(messageNotFound);
    return { ok: true };
  });

  app.post('/email/messages/:id/undo-move', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    if (id === null || !(await mailMessageById(db, id))) return reply.code(404).send(messageNotFound);
    if (!(await undoEmailMove(db, id, ctx.now()))) {
      return reply.code(409).send({ error: 'cannot_undo', message: 'Este movimento não pode mais ser desfeito: o card já mudou depois dele.' });
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- ignorados

  app.get('/email/ignored', () => listIgnored(db));

  /** "Era de vaga": o worker busca o texto na caixa e o guarda como e-mail de vaga. */
  app.post('/email/ignored/:id/promote', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    if (id === null || !(await requestPromote(db, id))) return reply.code(404).send(ignoredNotFound);
    return { ok: true };
  });

  // ---------------------------------------------------------------- respostas

  app.patch('/email/replies/:id', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const { body } = ReplyEditSchema.parse(req.body);
    const id = idParam(req);
    if (id === null || !(await replyById(db, id))) return reply.code(404).send(replyNotFound);
    if (!(await editReply(db, id, body))) {
      return reply.code(409).send({ error: 'not_a_draft', message: 'Só um rascunho pode ser editado.' });
    }
    return toMailReplyDto((await replyById(db, id))!);
  });

  /**
   * "Aprovar e enviar": a resposta passa a `aprovada` e o worker a envia. Um rascunho que ainda tem lacuna (`[[...]]`)
   * nunca sai do rascunho: 422 até o dono preencher. O pedido traz o texto que o dono vê; se o guardado for outro
   * (mudado em outra aba), 409 `reply_changed` e nada é aprovado.
   */
  app.post('/email/replies/:id/approve', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const { body } = ReplyApproveSchema.parse(req.body);
    const id = idParam(req);
    if (id === null) return reply.code(404).send(replyNotFound);
    // A conferência da lacuna e a aprovação na mesma transação, com a linha travada: uma edição que chegue no meio
    // espera, e o texto aprovado é sempre o texto conferido.
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(mailReplies).where(eq(mailReplies.id, id)).for('update');
      if (!row) return 'not_found' as const;
      if (row.body !== body) return 'changed' as const;
      if (DRAFT_PLACEHOLDER.test(row.body)) return 'gaps' as const;
      return (await approveReply(tx, id, 'owner', ctx.now())) ? ('approved' as const) : ('wrong_state' as const);
    });
    if (outcome === 'not_found') return reply.code(404).send(replyNotFound);
    if (outcome === 'changed') return reply.code(409).send(replyChanged);
    if (outcome === 'gaps') {
      return reply.code(422).send({ error: 'draft_has_gaps', message: 'Preencha as partes entre [[ ]] antes de aprovar.' });
    }
    if (outcome === 'wrong_state') return reply.code(409).send(wrongState);
    await resolveAlerts(db, { replyId: id }, ctx.now());
    return toMailReplyDto((await replyById(db, id))!);
  });

  app.post('/email/replies/:id/discard', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    if (id === null || !(await replyById(db, id))) return reply.code(404).send(replyNotFound);
    if (!(await discardReply(db, id, null, ctx.now()))) return reply.code(409).send(wrongState);
    await resolveAlerts(db, { replyId: id }, ctx.now());
    return toMailReplyDto((await replyById(db, id))!);
  });

  // ---------------------------------------------------------------- alertas

  app.get('/alerts', async () => ({ alerts: await openAlerts(db) }));

  app.post('/alerts/:id/dismiss', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const id = idParam(req);
    if (id === null || !(await alertById(db, id))) return reply.code(404).send(alertNotFound);
    if (!(await dismissAlert(db, id, ctx.now()))) return reply.code(409).send(alertClosed);
    return { ok: true };
  });

  /**
   * O alerta aberto de id dado e do tipo esperado. Responde (e devolve null) quando ele não existe (404), é de outro tipo
   * (409 `wrong_kind`) ou já foi resolvido ou dispensado (409 `alert_closed`).
   */
  async function openAlertOfKind(req: { params: unknown }, reply: FastifyReply, kind: AlertKind): Promise<AlertRow | null> {
    const id = idParam(req);
    const alert = id === null ? null : await alertById(db, id);
    if (!alert) {
      await reply.code(404).send(alertNotFound);
      return null;
    }
    if (alert.kind !== kind) {
      await reply.code(409).send({ error: 'wrong_kind', message: 'Esta ação não vale para este alerta.' });
      return null;
    }
    if (alert.resolvedAt !== null || alert.dismissedAt !== null) {
      await reply.code(409).send(alertClosed);
      return null;
    }
    return alert;
  }

  /** Resolve o alerta dado: só um fica aberto por tipo e mensagem (ou resposta), e por tipo nos alertas da caixa. */
  const resolve = (alert: AlertRow) =>
    resolveAlerts(
      db,
      { kind: alert.kind, mailMessageId: alert.mailMessageId ?? undefined, replyId: alert.replyId ?? undefined },
      ctx.now(),
    );

  /** "Mover" ou "Não mover" um movimento que esperava confirmação. Nos dois casos o alerta é resolvido. */
  app.post('/alerts/:id/move', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const { accept } = AlertMoveSchema.parse(req.body);
    const alert = await openAlertOfKind(req, reply, 'move_confirm');
    if (!alert) return reply;
    let moved = false;
    const to = alert.payload.moveTo;
    if (accept && to && alert.mailMessageId !== null) {
      const message = await mailMessageById(db, alert.mailMessageId);
      const jobId = alert.jobId ?? message?.jobId ?? null;
      // Card em Arquivada ou já na coluna: não move, e o alerta é resolvido do mesmo jeito.
      if (jobId !== null) moved = await moveCardByEmail(db, { jobId, to, messageId: alert.mailMessageId }, ctx.now());
    }
    await resolve(alert);
    return { moved };
  });

  /** O dono salvou a resposta que faltava: a mensagem volta a esperar ação e o worker age de novo, agora com o valor. */
  app.post('/alerts/:id/retry', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const alert = await openAlertOfKind(req, reply, 'missing_fact');
    if (!alert) return reply;
    if (alert.mailMessageId !== null) await reopenMessage(db, alert.mailMessageId);
    await resolve(alert);
    return { ok: true };
  });

  /** "Classificar mesmo assim": as mensagens presas pelo limite diário são classificadas apesar dele. */
  app.post('/alerts/:id/classify-anyway', async (req, reply) => {
    if (await refuseOffLocalHost(reply)) return reply;
    const alert = await openAlertOfKind(req, reply, 'budget_waiting');
    if (!alert) return reply;
    const released = await forceClassifyAll(db);
    await resolve(alert);
    return { released };
  });
}

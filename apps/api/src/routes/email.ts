import type { FastifyInstance } from 'fastify';
import type { Db } from '@kv/db';
import type { AiContext } from '../ai-context';

/** Mensagens, respostas e alertas do e-mail. Preenchida na próxima tarefa. */
export function emailRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {}

import { z } from 'zod';
import { EMAIL_KINDS, MAIL_LIMITS } from './email-constants';

/** Schemas Zod do e-mail. O navegador não importa este arquivo (só `email-constants.ts`). */

// Saídas do modelo: só campos obrigatórios, strings, inteiros e listas (mesma regra de `ai.ts`).
/** `jobId` 0 = nenhuma candidata. */
export const EmailClassifyWireSchema = z.object({
  kind: z.string(), jobId: z.number().int(),
  requests: z.array(z.object({ fact: z.string(), note: z.string() })),
  lang: z.string(), summary: z.string(),
});
export const EmailDraftWireSchema = z.object({ text: z.string() });

/** O Google mostra a senha de app em grupos: tira todo espaço em branco antes de validar. */
export const MailAccountInputSchema = z.strictObject({
  address: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().transform((s) => s.replace(/\s+/g, '')).pipe(z.string().min(8).max(64).regex(/^[\x21-\x7e]+$/)),
});
export const ReplyEditSchema = z.strictObject({ body: z.string().trim().min(1).max(MAIL_LIMITS.draftChars) });
export const LinkMessageSchema = z.strictObject({ jobId: z.number().int().positive() });
export const AlertMoveSchema = z.strictObject({ accept: z.boolean() });
export const MailMessagesQuerySchema = z.object({
  kind: z.enum(EMAIL_KINDS).optional(), unmatched: z.literal('1').optional(), since: z.coerce.number().optional(),
});
export const DisconnectQuerySchema = z.object({ messages: z.enum(['keep', 'delete']).default('keep') });

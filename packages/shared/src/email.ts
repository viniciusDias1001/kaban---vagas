import { z } from 'zod';
import { EMAIL_KINDS, MAIL_LIMITS, PHONE_ALERT_LIMITS, TELEGRAM_TOKEN_PATTERN } from './email-constants';

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
/** PUT /email/phone-token. O token é aparado (colar costuma trazer espaço ou quebra de linha); a mensagem de erro nunca o repete. */
export const PhoneTokenInputSchema = z.strictObject({
  token: z
    .string()
    .trim()
    .min(PHONE_ALERT_LIMITS.tokenMin, `o token tem pelo menos ${PHONE_ALERT_LIMITS.tokenMin} caracteres`)
    .max(PHONE_ALERT_LIMITS.tokenMax, `o token tem no máximo ${PHONE_ALERT_LIMITS.tokenMax} caracteres`)
    .regex(TELEGRAM_TOKEN_PATTERN, 'o token não tem espaços nem acentos'),
});
export const ReplyEditSchema = z.strictObject({ body: z.string().trim().min(1).max(MAIL_LIMITS.draftChars) });
/** POST /email/replies/:id/approve: o texto que o dono vê, comparado sem mudança nenhuma com o guardado. */
export const ReplyApproveSchema = z.strictObject({ body: z.string() });
/** Ids e datas dentro do que o banco guarda (int4; a maior data que um `Date` representa): fora disso, 400 e não 500. */
export const LinkMessageSchema = z.strictObject({ jobId: z.number().int().positive().max(2_147_483_647) });
export const AlertMoveSchema = z.strictObject({ accept: z.boolean() });
export const MailMessagesQuerySchema = z.object({
  kind: z.enum(EMAIL_KINDS).optional(), unmatched: z.literal('1').optional(),
  since: z.coerce.number().int().min(0).max(8.64e15).optional(),
});
export const DisconnectQuerySchema = z.object({ messages: z.enum(['keep', 'delete']).default('keep') });

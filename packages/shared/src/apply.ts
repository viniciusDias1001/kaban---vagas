import { z } from 'zod';

/** Schemas Zod da candidatura automática. O navegador não importa este arquivo (só `apply-constants.ts`). */

/** Tetos do que o navegador manda: valor de texto até 2000 caracteres; lista de até 50 itens de até 300. */
const AnswerValueSchema = z.union([
  z.string().max(2000), z.array(z.string().max(300)).max(50), z.boolean(), z.null(),
]);
const AnswerScopeSchema = z.enum(['always', 'company', 'job']);

/** Corpo de PUT /applications/:id/answers. */
export const PendingAnswersBodySchema = z.strictObject({
  answers: z.array(z.strictObject({
    questionId: z.string().max(200), value: AnswerValueSchema, scope: AnswerScopeSchema, confirmMatch: z.boolean(),
  })).max(60),
});

/** Corpo de POST e PUT /apply/answers. */
export const ApplyAnswerInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(500), answer: z.string().max(2000), kind: z.enum(['text', 'number', 'boolean', 'choice']),
  scope: AnswerScopeSchema, scopeValue: z.string().max(200).nullable(), country: z.string().max(2).nullable(),
});

// Saídas do modelo: só campos obrigatórios, strings, inteiros, booleanos e listas (mesma regra de ProfileWireSchema).
export const GateWireSchema = z.object({
  score: z.number().int(), reason: z.string(), eligible: z.boolean(), ineligibleReason: z.string(),
});
export const ClassifyWireSchema = z.object({
  items: z.array(z.object({ questionId: z.string(), category: z.string() })),
});
/** `bankAnswerId` 0 = nenhuma. */
export const BankMatchWireSchema = z.object({
  items: z.array(z.object({ questionId: z.string(), bankAnswerId: z.number().int(), option: z.string() })),
});
export const ProfileFactWireSchema = z.object({
  items: z.array(z.object({
    questionId: z.string(), answer: z.string(), basis: z.array(z.string()), unknown: z.boolean(),
  })),
});
export const OpenAnswerWireSchema = z.object({ text: z.string() });

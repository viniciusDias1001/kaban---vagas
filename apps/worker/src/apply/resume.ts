import { eq, isNull } from 'drizzle-orm';
import {
  AiError, draftTailored, fullDraftOf, isStructural, resolveTailored, tailoredLangFor, toCorrections, violationCodes,
  type TailoredCorrection,
} from '@kv/ai';
import { jobAi, jobs, profileFor, tailoredResumes, type Db } from '@kv/db';
import { ResumePdfError, renderResumePdf } from '@kv/resume';
import { draftOf, type ApplyResumeMode, type CandidateProfile, type ResumeLang, type TailoredResume } from '@kv/shared';
import type { Billing } from '../ai/billing';
import { isForeignKeyViolation, keywordsOf } from '../ai/job-context';
import { DraftBlockedError } from '../ai/task-errors';

type JobRow = typeof jobs.$inferSelect;

export type ApplicationResume =
  | { ok: true; pdf: Buffer; fileName: string; lang: ResumeLang }
  | { ok: false; reason: 'resume_blocked' | 'budget' | 'cancelled'; detail: string };

const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
const FILE_NAME_MAX = 80;
const blocked = (detail: string): ApplicationResume => ({ ok: false, reason: 'resume_blocked', detail });
const OVER_BUDGET = 'O limite diário de gasto com IA foi atingido; o currículo adaptado fica para o dia seguinte.';
const EDITED_STALE =
  'O currículo que você editou para esta vaga não combina mais com o perfil e precisa da sua revisão. Abra o currículo da vaga, ajuste-o e salve de novo.';

/** `Curriculo_<Nome>_<Empresa>.pdf` em pt-BR, `Resume_<Name>_<Company>.pdf` em inglês; só letras sem acento, dígitos e `_`; até 80 caracteres. */
export function resumeFileName(lang: ResumeLang, name: string, company: string): string {
  const clean = (text: string) =>
    text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const prefix = lang === 'pt-BR' ? 'Curriculo' : 'Resume';
  const body = [prefix, clean(name), clean(company)].filter(Boolean).join('_').slice(0, FILE_NAME_MAX - '.pdf'.length).replace(/_+$/, '');
  return `${body}.pdf`;
}

/** O perfil inteiro, como está, resolvido pelo mesmo caminho de um currículo adaptado (cabeçalho, grupos, seções e notas). */
export function baseResume(profile: CandidateProfile, lang: ResumeLang): TailoredResume {
  return resolveTailored(fullDraftOf(profile), profile, lang).resume;
}

/**
 * O currículo de uma candidatura, em PDF.
 *
 * `tailored`: usa o currículo adaptado em dia da vaga (da versão atual do perfil) ou gera um (com a tentativa de correção
 * da camada 3), grava em `tailored_resumes` e registra o uso em `tier3`. Um currículo que o dono editou à mão
 * (`editedAt`) nunca é sobrescrito: se o perfil mudou, o rascunho dele é verificado de novo contra o perfil atual e usado
 * como está, sem gravar, ou, se já não bate (id inexistente ou repetido, limite de tamanho), volta `resume_blocked` pedindo a
 * revisão dele. Vaga sem descrição não tem o que adaptar: vale primeiro o currículo guardado que serviria (em dia, ou o do dono), e sem ele sai o currículo base, sem chamar o modelo e sem gravar.
 * `base`: o perfil do idioma da vaga como está, sem chamar o modelo.
 *
 * QUEM CHAMA: busca a descrição da vaga ANTES (LinkedIn e Indeed a trazem vazia até a busca) e passa `mayCall`, que diz se o
 * limite diário de gasto ainda permite uma chamada ao modelo. Ela é consultada antes de TODA chamada, a primeira e a de
 * correção; negada, não há chamada, nada é gravado e o resultado é `budget`. Vaga apagada durante a chamada: `cancelled`.
 * Rascunho bloqueado, falta de perfil e texto que o PDF não aceita voltam como `resume_blocked`; tempo esgotado, chave
 * inválida e erro de banco sobem como exceção.
 */
export async function applicationResume(
  deps: { db: Db; billing: Billing; mayCall: () => Promise<boolean>; now?: () => number },
  job: JobRow,
  mode: ApplyResumeMode,
  signal: AbortSignal,
): Promise<ApplicationResume> {
  const { db, billing, mayCall, now = Date.now } = deps;
  const [ai] = await db
    .select({ language: jobAi.language, tier2State: jobAi.tier2State, analysis: jobAi.analysis })
    .from(jobAi)
    .where(eq(jobAi.jobId, job.id));
  const lang = tailoredLangFor(ai?.language, job.country);
  const profile = await profileFor(db, lang);
  if (!profile) return blocked(`Não há perfil em ${LANG_NAMES[lang]}: envie o currículo ou gere o perfil por tradução.`);
  const context = { jobCompany: job.company, jobTitle: job.title, jobKeywords: keywordsOf(ai) };
  /** O currículo que o dono editou: vale o rascunho dele, verificado de novo contra o perfil atual; senão, revisão. */
  const ownerEdited = (stored: typeof tailoredResumes.$inferSelect): TailoredResume | null => {
    if (stored.lang === lang && stored.profileVersion === profile.version) return stored.content;
    const again = resolveTailored(draftOf(stored.content), profile.data, lang, context);
    if (stored.lang !== lang || again.violations.some((v) => isStructural(v) || v.code === 'limit')) return null;
    return again.resume;
  };

  let resume: TailoredResume;
  if (mode === 'base') {
    resume = baseResume(profile.data, lang);
  } else {
    const [stored] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
    if (stored && stored.lang === lang && stored.profileVersion === profile.version) {
      resume = stored.content;
    } else if (stored && stored.editedAt !== null) {
      // Do dono: nunca é sobrescrito.
      const mine = ownerEdited(stored);
      if (!mine) return blocked(EDITED_STALE);
      resume = mine;
    } else if (job.description.trim() === '') {
      // Nada a adaptar e nenhum currículo guardado que sirva: sai o base.
      resume = baseResume(profile.data, lang);
    } else {
      const draft = async (corrections?: TailoredCorrection[]) => {
        const res = await billing.billed('tier3', 'strong', () =>
          draftTailored(billing.provider, profile.data, job, lang, { signal, corrections }),
        );
        return resolveTailored(res.data, profile.data, lang, context);
      };
      if (!(await mayCall())) return { ok: false, reason: 'budget', detail: OVER_BUDGET };
      let result = await draft();
      if (result.violations.length > 0) {
        const codes = violationCodes(result.violations);
        if (!(await mayCall())) return { ok: false, reason: 'budget', detail: OVER_BUDGET };
        try {
          result = await draft(toCorrections(result.violations));
        } catch (e) {
          // Tempo esgotado e chave inválida mantêm o próprio erro; o resto vira "bloqueado".
          if (signal.aborted || (e instanceof AiError && e.kind === 'config')) throw e;
          return blocked(new DraftBlockedError(codes).message);
        }
        if (result.violations.length > 0) return blocked(new DraftBlockedError(violationCodes(result.violations)).message);
      }
      resume = result.resume;
      const values = { lang, content: resume, profileVersion: profile.version, createdAt: now(), editedAt: null };
      let written: { id: number }[];
      try {
        // Uma edição do dono feita durante a chamada ao modelo nunca é sobrescrita (`setWhere`).
        written = await db
          .insert(tailoredResumes)
          .values({ jobId: job.id, ...values })
          .onConflictDoUpdate({ target: tailoredResumes.jobId, set: values, setWhere: isNull(tailoredResumes.editedAt) })
          .returning({ id: tailoredResumes.id });
      } catch (e) {
        // A vaga foi apagada durante a chamada ao modelo (o uso já foi registrado): cancelamento limpo, como no executor.
        if (!isForeignKeyViolation(e)) throw e;
        return { ok: false, reason: 'cancelled', detail: 'A vaga foi apagada durante a preparação do currículo.' };
      }
      if (written.length === 0) {
        // O dono editou o currículo da vaga enquanto o modelo escrevia: vale o dele, nunca o rascunho descartado.
        const [mineRow] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
        const mine = mineRow ? ownerEdited(mineRow) : null;
        if (!mine) return blocked(EDITED_STALE);
        resume = mine;
      }
    }
  }

  try {
    const pdf = await renderResumePdf(resume);
    return { ok: true, pdf, fileName: resumeFileName(lang, profile.data.contact.name, job.company), lang };
  } catch (e) {
    if (e instanceof ResumePdfError) return blocked(e.message);
    throw e;
  }
}

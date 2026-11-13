import { eq } from 'drizzle-orm';
import {
  AiError, draftTailored, fullDraftOf, resolveTailored, tailoredLangFor, toCorrections, violationCodes, type TailoredCorrection,
} from '@kv/ai';
import { jobAi, jobs, profileFor, tailoredResumes, type Db } from '@kv/db';
import { ResumePdfError, renderResumePdf } from '@kv/resume';
import type { ApplyResumeMode, CandidateProfile, ResumeLang, TailoredResume } from '@kv/shared';
import type { Billing } from '../ai/billing';
import { keywordsOf } from '../ai/executors';
import { DraftBlockedError } from '../ai/task-errors';

type JobRow = typeof jobs.$inferSelect;

export type ApplicationResume =
  | { ok: true; pdf: Buffer; fileName: string; lang: ResumeLang }
  | { ok: false; reason: 'resume_blocked'; detail: string };

const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
const FILE_NAME_MAX = 80;
const blocked = (detail: string): ApplicationResume => ({ ok: false, reason: 'resume_blocked', detail });

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
 * O currículo de uma candidatura, em PDF. `tailored`: usa o currículo adaptado em dia da vaga (da versão atual do perfil) ou
 * gera um, com a tentativa de correção da camada 3, grava em `tailored_resumes` e registra o uso em `tier3`. `base`: o
 * perfil do idioma da vaga como está, sem chamar o modelo. Rascunho bloqueado pelo verificador, falta de perfil e texto que
 * o PDF não aceita voltam como `resume_blocked`; tempo esgotado, chave inválida e erro de banco sobem como exceção.
 * O limite diário de gasto é conferido por quem chama, antes da candidatura.
 */
export async function applicationResume(
  deps: { db: Db; billing: Billing; now?: () => number },
  job: JobRow,
  mode: ApplyResumeMode,
  signal: AbortSignal,
): Promise<ApplicationResume> {
  const { db, billing, now = Date.now } = deps;
  const [ai] = await db
    .select({ language: jobAi.language, tier2State: jobAi.tier2State, analysis: jobAi.analysis })
    .from(jobAi)
    .where(eq(jobAi.jobId, job.id));
  const lang = tailoredLangFor(ai?.language, job.country);
  const profile = await profileFor(db, lang);
  if (!profile) return blocked(`Não há perfil em ${LANG_NAMES[lang]}: envie o currículo ou gere o perfil por tradução.`);

  let resume: TailoredResume;
  if (mode === 'base') {
    resume = baseResume(profile.data, lang);
  } else {
    const [stored] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
    if (stored && stored.lang === lang && stored.profileVersion === profile.version) {
      resume = stored.content;
    } else {
      const context = { jobCompany: job.company, jobTitle: job.title, jobKeywords: keywordsOf(ai) };
      const draft = async (corrections?: TailoredCorrection[]) => {
        const res = await billing.billed('tier3', 'strong', () =>
          draftTailored(billing.provider, profile.data, job, lang, { signal, corrections }),
        );
        return resolveTailored(res.data, profile.data, lang, context);
      };
      let result = await draft();
      if (result.violations.length > 0) {
        const codes = violationCodes(result.violations);
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
      await db
        .insert(tailoredResumes)
        .values({ jobId: job.id, ...values })
        .onConflictDoUpdate({ target: tailoredResumes.jobId, set: values });
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

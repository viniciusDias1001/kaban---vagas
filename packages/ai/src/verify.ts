import type { CandidateProfile, ResumeLang, TailoredDraft, TailoredResume, Violation } from '@kv/shared';

/** Minúsculas e sem acentos, para comparar nomes. */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Números citados em um texto, em forma canônica: "1.000" e "1,000" viram "1000"; "1,5" vira "1.5";
 * "40%" vira "40". Anos contam como números (uma data alterada no texto é um número novo).
 * Limite conhecido: números por extenso ("dez") não são detectados.
 */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((raw) =>
    /^\d{1,3}([.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.'),
  );
}

export interface ResolveOptions {
  /** Nome da empresa da vaga: não pode aparecer nos textos reescritos se não estiver no perfil. */
  jobCompany?: string;
}

export interface Resolved {
  /** O currículo com empresa, cargo, datas, formação, habilidades etc. COPIADOS do perfil. */
  resume: TailoredResume;
  /** Vazio = aprovado. Para saída de modelo, qualquer item bloqueia o resultado. */
  violations: Violation[];
}

/**
 * Verificador de não invenção. Recebe o rascunho (referências + textos livres) e o perfil, e:
 *
 * 1. exige que todo id exista no perfil e apareça uma vez só (`unknown_id`, `duplicate_id`); a
 *    realização referenciada tem de pertencer à experiência em que foi posta;
 * 2. monta o currículo copiando do perfil tudo que não é texto livre: o modelo não tem como alterar
 *    empresa, cargo, data, formação, certificação, idioma ou habilidade;
 * 3. exige que todo número de uma realização reescrita exista na realização original, e que todo
 *    número do resumo exista em algum lugar do perfil (`new_number`);
 * 4. recusa o nome da empresa da vaga dentro dos textos, se ele não está no perfil (`foreign_company`).
 *
 * Itens com id inválido ficam fora do currículo devolvido, que só deve ser usado se `violations` estiver
 * vazio (saída de modelo) ou só tiver avisos aceitos por quem chama (edição do usuário).
 */
export function resolveTailored(
  draft: TailoredDraft,
  profile: CandidateProfile,
  lang: ResumeLang,
  opts: ResolveOptions = {},
): Resolved {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  function pick<T extends { id: string }>(items: T[], ids: string[], field: string, what: string): T[] {
    const out: T[] = [];
    ids.forEach((id, i) => {
      const path = `${field}[${i}]`;
      const found = items.find((item) => item.id === id);
      if (!found) violations.push({ code: 'unknown_id', path, message: `${what} "${id}" não existe no perfil` });
      else if (seen.has(id)) violations.push({ code: 'duplicate_id', path, message: `${what} "${id}" aparece mais de uma vez` });
      else {
        seen.add(id);
        out.push(found);
      }
    });
    return out;
  }

  const profileText = JSON.stringify(profile);
  const profileNumbers = new Set(numbersIn(profileText));
  const company = opts.jobCompany ? fold(opts.jobCompany).trim() : '';
  const companyIsForeign = company.length >= 3 && !fold(profileText).includes(company);

  function checkText(text: string, allowed: Set<string>, path: string, where: string) {
    for (const n of new Set(numbersIn(text))) {
      if (!allowed.has(n)) violations.push({ code: 'new_number', path, message: `o número "${n}" não está ${where}` });
    }
    if (companyIsForeign && fold(text).includes(company)) {
      violations.push({ code: 'foreign_company', path, message: `o texto cita "${opts.jobCompany}", que não está no perfil` });
    }
  }

  checkText(draft.summary, profileNumbers, 'summary', 'no perfil');

  const experiences: TailoredResume['experiences'] = [];
  draft.experiences.forEach((item, i) => {
    const path = `experiences[${i}]`;
    const source = profile.experiences.find((e) => e.id === item.id);
    if (!source) {
      violations.push({ code: 'unknown_id', path, message: `experiência "${item.id}" não existe no perfil` });
      return;
    }
    if (seen.has(source.id)) {
      violations.push({ code: 'duplicate_id', path, message: `experiência "${item.id}" aparece mais de uma vez` });
      return;
    }
    seen.add(source.id);
    const achievements: { sourceId: string; text: string }[] = [];
    item.achievements.forEach((a, j) => {
      const aPath = `${path}.achievements[${j}]`;
      const original = source.achievements.find((s) => s.id === a.sourceId);
      if (!original) {
        violations.push({ code: 'unknown_id', path: aPath, message: `realização "${a.sourceId}" não pertence a esta experiência` });
        return;
      }
      if (seen.has(original.id)) {
        violations.push({ code: 'duplicate_id', path: aPath, message: `realização "${a.sourceId}" aparece mais de uma vez` });
        return;
      }
      seen.add(original.id);
      checkText(a.text, new Set(numbersIn(original.text)), `${aPath}.text`, 'na realização original');
      achievements.push({ sourceId: original.id, text: a.text });
    });
    // Empresa, cargo, datas e local vêm do perfil, nunca do rascunho.
    const { achievements: _original, ...copied } = source;
    experiences.push({ ...copied, achievements });
  });

  const resume: TailoredResume = {
    lang,
    contact: profile.contact,
    summary: draft.summary,
    experiences,
    education: pick(profile.education, draft.educationIds, 'educationIds', 'formação'),
    skills: pick(profile.skills, draft.skillIds, 'skillIds', 'habilidade'),
    languages: pick(profile.languages, draft.languageIds, 'languageIds', 'idioma'),
    certifications: pick(profile.certifications, draft.certificationIds, 'certificationIds', 'certificação'),
    links: pick(profile.links, draft.linkIds, 'linkIds', 'link'),
  };
  return { resume, violations };
}

/** Texto curto para `ai_tasks.error` e para a interface: o que divergiu. */
export function describeViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.path}: ${v.message}`).join('; ');
}

/** Violações de estrutura: bloqueiam também a edição manual. As demais viram aviso para o usuário. */
export const isStructural = (v: Violation) => v.code === 'unknown_id' || v.code === 'duplicate_id';

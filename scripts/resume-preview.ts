/**
 * Prévia para o dono: gera o PDF do perfil gravado, em cada idioma que tiver perfil, para conferir ao lado
 * do currículo dele. O PDF tem os dados reais do perfil: sai numa pasta FORA do repositório (padrão:
 * `<tmp>/kanban-vagas-preview`) e este script imprime só os caminhos, nunca texto do perfil.
 *
 *   pnpm resume:preview
 *   pnpm resume:preview -- --out "<pasta fora do repositório>"
 *
 * A raiz do repositório vem do lugar deste arquivo, não da pasta em que o comando roda: um `--out`
 * relativo vale a partir dessa raiz, o `.env` é lido dela, e nada é gravado dentro dela.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTailored } from '../packages/ai/src/index';
import { closeDb, createDb, profileFor } from '../packages/db/src/index';
import { PREVIEW_FILES, ResumePdfError, previewDir, renderResumePdf } from '../packages/resume/src/index';
import { RESUME_LANGS, type TailoredDraft } from '../packages/shared/src/index';

const args = process.argv.slice(2).filter((a) => a !== '--');
const outIndex = args.indexOf('--out');
const requested = outIndex >= 0 ? args[outIndex + 1] : undefined;
if (outIndex >= 0 && !requested) {
  console.error('Use --out "<pasta>".');
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Copie .env.example para .env e ajuste a URL do Postgres.');
  process.exit(1);
}

let dir: string;
try {
  dir = previewDir(requested, repoRoot, tmpdir());
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const db = createDb();
let written = 0;
let failed = false;
try {
  await mkdir(dir, { recursive: true });
  for (const lang of RESUME_LANGS) {
    const row = await profileFor(db, lang);
    if (!row) continue;
    const profile = row.data;
    // Rascunho com todos os itens do perfil, tal como estão.
    const draft: TailoredDraft = {
      summary: profile.summary,
      experiences: profile.experiences.map((e) => ({ id: e.id, achievements: e.achievements.map((a) => ({ sourceId: a.id, text: a.text })) })),
      educationIds: profile.education.map((e) => e.id),
      skillIds: profile.skills.map((k) => k.id),
      languageIds: profile.languages.map((l) => l.id),
      certificationIds: profile.certifications.map((c) => c.id),
      linkIds: profile.links.map((l) => l.id),
    };
    try {
      const { resume } = resolveTailored(draft, profile, lang);
      const file = join(dir, PREVIEW_FILES[lang]);
      await writeFile(file, await renderResumePdf(resume));
      console.log(file);
      written++;
    } catch (e) {
      if (!(e instanceof ResumePdfError)) throw e;
      failed = true;
      console.error(`${lang}: ${e.message}`);
    }
  }
} finally {
  await closeDb(db).catch(() => {});
}

if (failed) process.exit(1);
if (written === 0) {
  console.error('Nenhum perfil gravado. Envie o currículo em Meu perfil.');
  process.exit(1);
}

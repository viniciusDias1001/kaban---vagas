/**
 * Ensaio MANUAL de um roteiro de site contra a vaga de verdade: abre UMA vaga com janela, preenche como o worker
 * faria, fotografa a página inteira e fecha sem enviar. Este comando NÃO TEM caminho que envie a candidatura.
 *
 *   pnpm apply:smoke -- --site <linkedin|greenhouse|lever> --job <endereço da vaga> [--resume <pdf>]
 *
 * Nunca roda na CI. Usa o perfil persistente do navegador do worker (pasta de dados), o perfil e as respostas
 * salvas do dono (banco) e o currículo base. A foto e o currículo gerado ficam em `<pasta de dados>/smoke/`,
 * sempre FORA do repositório: têm dados reais.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseResume, resumeFileName } from '../apps/worker/src/apply/resume';
import { applyDataDir, browserProfileDir } from '../packages/apply/src/data-dir';
import { createBrowserSession, detectBrowserChannel, realLaunch } from '../packages/apply/src/browser';
import { resolveAnswers } from '../packages/apply/src/answers/resolve';
import { assertOutsideRepo, parseSmokeArgs, runSmoke, smokeShotPath, smokeSiteFor } from '../packages/apply/src/smoke';
import type { ApplyJob } from '../packages/apply/src/types';
import { closeDb, createDb, listApplyAnswers, profileFor } from '../packages/db/src/index';
import { renderResumePdf, ResumePdfError } from '../packages/resume/src/index';
import { APPLY_SITE_LABELS, RESUME_LANGS } from '../packages/shared/src/index';

const parsed = parseSmokeArgs(process.argv.slice(2), process.env);
// A trava vem antes de qualquer outra coisa: com erro (inclusive CI), nada é lido nem aberto.
if ('error' in parsed) {
  console.error(parsed.error);
  process.exit(1);
}
const site = smokeSiteFor(parsed.site);
if (!site) {
  console.error(`${parsed.site}: o roteiro deste site ainda não está disponível.`);
  process.exit(1);
}

// As respostas do modelo ficam desligadas: a ligação do resolvedor com o modelo (classificar, propor, fatos do perfil,
// texto aberto, com verificador e cobrança) é a da fila de candidaturas. TODO: reusar essa ligação aqui quando a fila entrar.
console.log('Respostas do modelo: DESLIGADAS neste ensaio (nenhuma chamada paga); só as regras e as respostas salvas respondem.');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const dataDir = applyDataDir();
const choice = detectBrowserChannel();
console.log(`Site: ${parsed.site}`);
console.log(`Vaga: ${parsed.url}`);
console.log(`Pasta de dados: ${dataDir}`);
console.log(`Navegador: ${choice === null ? '(nenhum encontrado)' : typeof choice === 'string' ? choice : choice.executablePath}`);
console.log('ENSAIO: este comando nunca envia a candidatura.');

if (choice === null) {
  console.error('Nenhum navegador encontrado. Instale o Chrome ou o Edge, ou defina APPLY_BROWSER (chrome, msedge ou o caminho do executável).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Copie .env.example para .env e ajuste a URL do Postgres.');
  process.exit(1);
}
const shotPath = smokeShotPath(dataDir, parsed.site, new Date());
try {
  assertOutsideRepo(shotPath, repoRoot);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const db = createDb();
let browser: ReturnType<typeof createBrowserSession> | null = null;
let code = 1;
try {
  const lang = (await Promise.all(RESUME_LANGS.map(async (l) => ((await profileFor(db, l)) ? l : null)))).find((l) => l !== null);
  const row = lang ? await profileFor(db, lang) : null;
  if (!lang || !row) {
    console.error('Nenhum perfil gravado. Envie o currículo em Meu perfil.');
    process.exit(1);
  }
  const profile = row.data;
  const bank = await listApplyAnswers(db);

  const base: ApplyJob = { id: 0, source: parsed.site, url: parsed.url, externalId: '', company: '', title: 'Ensaio' };
  const target = site.match(base);
  if (!target) {
    console.error(`O endereço não é de uma vaga do ${parsed.site}: ${parsed.url}`);
    process.exit(1);
  }
  const job: ApplyJob = { ...base, company: target.ref.company ?? target.ref.board ?? '' };

  await mkdir(join(dataDir, 'smoke'), { recursive: true });
  let resumePath = parsed.resumePath;
  if (resumePath !== null && !existsSync(resumePath)) {
    console.error(`O currículo ${resumePath} não existe.`);
    process.exit(1);
  }
  const fileName = resumeFileName(lang, profile.contact.name, job.company);
  if (resumePath === null) {
    try {
      resumePath = join(dataDir, 'smoke', fileName);
      assertOutsideRepo(resumePath, repoRoot);
      await writeFile(resumePath, await renderResumePdf(baseResume(profile, lang)));
    } catch (e) {
      if (!(e instanceof ResumePdfError)) throw e;
      console.error(`Não consegui gerar o currículo base: ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`Currículo: ${resumePath}`);

  const ruleContext = {
    profile, job, sourceLabel: APPLY_SITE_LABELS[parsed.site], resumeFileName: basename(resumePath),
    company: job.company, jobId: job.id, country: null,
  };
  const deps = {
    classify: async () => new Map(),
    proposeMatches: async () => new Map(),
    profileFacts: async () => new Map(),
    writeOpen: async () => null,
  };

  browser = createBrowserSession({ userDataDir: browserProfileDir(dataDir), launch: realLaunch(choice) });
  const page = await browser.page();
  const report = await runSmoke({
    site, job, page, resumePath, shotPath, print: (line) => console.log(line),
    resolve: async (questions) => {
      const { answers, pending } = await resolveAnswers({ questions, bank, ctx: ruleContext, aiAnswers: 'off', approved: [] }, deps);
      return { answers, pending };
    },
  });
  console.log(`\nResultado: ${report.outcome} (${report.detail}); etapas: ${report.steps}`);
  if (report.shotPath) console.log(`Foto: ${report.shotPath}`);
  code = report.outcome === 'filled' || report.outcome === 'pending' ? 0 : 1;
} catch (e) {
  console.error(`O ensaio falhou: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser?.close().catch(() => {});
  await closeDb(db).catch(() => {});
}
process.exit(code);

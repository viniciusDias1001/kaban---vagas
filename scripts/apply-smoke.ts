/**
 * Ensaio MANUAL de um roteiro de site contra a vaga de verdade: abre UMA vaga com janela, preenche como o worker
 * faria, fotografa a página inteira e fecha sem enviar. Este comando NÃO TEM caminho que envie a candidatura.
 *
 *   pnpm apply:smoke -- --site <linkedin|greenhouse|lever> --job <endereço da vaga> [--resume <pdf>] [--country BR|INT]
 *
 * `--country` é o país da vaga (padrão INT): respostas salvas ligadas a um país só valem para vagas desse país.
 *
 * Nunca roda na CI. As respostas do modelo usam a mesma ligação da fila (`ai-calls.ts`: classificar, casar respostas
 * salvas, fatos do perfil e texto aberto, com verificador, orçamento antes de cada chamada e cobrança na camada `apply`),
 * sempre em modo "review": o que o modelo propõe é IMPRESSO como proposta, nunca digitado. Usa o perfil persistente do
 * navegador do worker (pasta de dados), o perfil e as respostas salvas do dono (banco) e o currículo base. A foto e o
 * currículo gerado ficam em `<pasta de dados>/smoke/`, sempre FORA do repositório: têm dados reais.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplyBudgetError, createApplyAi, resolveDepsFor } from '../apps/worker/src/apply/ai-calls';
import { baseResume, resumeFileName } from '../apps/worker/src/apply/resume';
import { AiError, createProvider } from '../packages/ai/src/index';
import { applyDataDir, browserProfileDir } from '../packages/apply/src/data-dir';
import { createBrowserSession, detectBrowserChannel, realLaunch } from '../packages/apply/src/browser';
import { resolveAnswers } from '../packages/apply/src/answers/resolve';
import { assertOutsideRepo, parseSmokeArgs, runSmoke, smokeAiMode, smokeJobFor, smokeShotPath, smokeSiteFor, type SmokeArgs } from '../packages/apply/src/smoke';
import type { ApplySite } from '../packages/apply/src/types';
import { closeDb, createDb, listApplyAnswers, profileFor } from '../packages/db/src/index';
import { renderResumePdf, ResumePdfError } from '../packages/resume/src/index';
import { createSettingsService } from '../packages/settings/src/index';
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

const args: SmokeArgs = parsed;
const script: ApplySite = site;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Tudo o que abre algo roda aqui dentro; o código de saída é devolvido (nunca `process.exit`), então o `finally` sempre roda. */
async function main(): Promise<number> {
  const fail = (message: string): number => {
    console.error(message);
    return 1;
  };
  if (!process.env.DATABASE_URL) return fail('DATABASE_URL não definida. Copie .env.example para .env e ajuste a URL do Postgres.');
  const db = createDb();
  let browser: ReturnType<typeof createBrowserSession> | null = null;
  try {
    // O modelo só entra com provedor configurado e limite do dia por atingir; a primeira linha impressa diz qual.
    const settings = createSettingsService(db);
    const now = () => Date.now();
    const ai = createApplyAi({
      db, now, log: (m) => console.log(m),
      ai: async () => {
        const { config, problem } = await settings.aiConfig();
        if (!config) throw new AiError('config', problem ?? 'IA não configurada');
        return { provider: createProvider(config), config };
      },
    });
    const configured = Boolean((await settings.aiConfig()).config);
    const withinBudget = configured && (await ai.mayCall());
    const aiMode = smokeAiMode({ configured, withinBudget });
    console.log(aiMode.line);

    const dataDir = applyDataDir();
    const choice = detectBrowserChannel();
    console.log(`Site: ${args.site}`);
    console.log(`Vaga: ${args.url}`);
    console.log(`País da vaga: ${args.country}${args.country === 'INT' ? ' (use --country BR para uma vaga no Brasil)' : ''}`);
    console.log(`Pasta de dados: ${dataDir}`);
    console.log(`Navegador: ${choice === null ? '(nenhum encontrado)' : typeof choice === 'string' ? choice : choice.executablePath}`);
    console.log('Vaga do ensaio: montada só pelo endereço; respostas salvas de uma empresa específica podem não valer num ensaio por endereço.');
    console.log('ENSAIO: este comando nunca envia a candidatura.');
    if (choice === null) return fail('Nenhum navegador encontrado. Instale o Chrome ou o Edge, ou defina APPLY_BROWSER (chrome, msedge ou o caminho do executável).');

    const shotPath = smokeShotPath(dataDir, args.site, new Date());
    try {
      assertOutsideRepo(shotPath, repoRoot);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }

    const lang = (await Promise.all(RESUME_LANGS.map(async (l) => ((await profileFor(db, l)) ? l : null)))).find((l) => l !== null);
    const row = lang ? await profileFor(db, lang) : null;
    if (!lang || !row) return fail('Nenhum perfil gravado. Envie o currículo em Meu perfil.');
    const profile = row.data;
    const bank = await listApplyAnswers(db);

    const base = smokeJobFor(args.site, args.url);
    const target = script.match(base);
    if (!target) return fail(`O endereço não é de uma vaga do ${args.site}: ${args.url}`);
    const job = { ...base, company: target.ref.company ?? target.ref.board ?? '' };

    await mkdir(join(dataDir, 'smoke'), { recursive: true });
    let resumePath = args.resumePath;
    if (resumePath !== null && !existsSync(resumePath)) return fail(`O currículo ${resumePath} não existe.`);
    if (resumePath === null) {
      try {
        resumePath = join(dataDir, 'smoke', resumeFileName(lang, profile.contact.name, job.company));
        assertOutsideRepo(resumePath, repoRoot);
        await writeFile(resumePath, await renderResumePdf(baseResume(profile, lang)));
      } catch (e) {
        if (!(e instanceof ResumePdfError)) throw e;
        return fail(`Não consegui gerar o currículo base: ${e.message}`);
      }
    }
    console.log(`Currículo: ${resumePath}`);

    const ruleContext = {
      profile, job, sourceLabel: APPLY_SITE_LABELS[args.site], resumeFileName: basename(resumePath),
      company: job.company, jobId: job.id, country: args.country,
    };
    const controller = new AbortController();
    const modelDeps = resolveDepsFor(ai, {
      profile, lang, now, signal: controller.signal,
      job: { id: job.id, title: job.title, company: job.company, location: '', description: '' },
    });
    const noModel = {
      classify: async () => new Map(), proposeMatches: async () => new Map(), profileFacts: async () => new Map(), writeOpen: async () => null,
    };
    let mode = aiMode.mode;

    browser = createBrowserSession({ userDataDir: browserProfileDir(dataDir), launch: realLaunch(choice) });
    const page = await browser.page();
    const report = await runSmoke({
      site: script, job, page, resumePath, shotPath, print: (line) => console.log(line),
      resolve: async (questions) => {
        const input = { questions, bank, ctx: ruleContext, approved: [] };
        try {
          const { answers, pending } = await resolveAnswers({ ...input, aiAnswers: mode }, mode === 'review' ? modelDeps : noModel);
          return { answers, pending };
        } catch (e) {
          if (!(e instanceof ApplyBudgetError)) throw e;
          // O limite do dia chegou no meio do ensaio: segue só com regras e respostas salvas.
          mode = 'off';
          console.log('Limite diário de IA atingido durante o ensaio: daqui em diante só as regras e as respostas salvas respondem.');
          const { answers, pending } = await resolveAnswers({ ...input, aiAnswers: 'off' }, noModel);
          return { answers, pending };
        }
      },
    });
    console.log(`\nResultado: ${report.outcome} (${report.detail}); etapas: ${report.steps}`);
    if (report.shotPath) console.log(`Foto: ${report.shotPath}`);
    return report.outcome === 'filled' || report.outcome === 'pending' ? 0 : 1;
  } catch (e) {
    return fail(`O ensaio falhou: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser?.close().catch(() => {});
    await closeDb(db).catch(() => {});
  }
}

process.exitCode = await main();

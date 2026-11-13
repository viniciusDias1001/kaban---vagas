/**
 * Conferência MANUAL da caixa de e-mail de verdade, só de leitura: abre a caixa conectada no app (o endereço e a senha de
 * app gravados no banco de DATABASE_URL, decifrada com APP_SECRET), busca os últimos 30 dias da Caixa de entrada, passa
 * cada mensagem no mesmo filtro local da leitura do app e imprime só contagens e, por mensagem que passa, remetente,
 * assunto e a regra que a deixou passar. Nunca o texto das mensagens.
 *
 *   pnpm mail:smoke                       só o filtro (nenhuma chamada de IA)
 *   pnpm mail:smoke -- --classify 5       também classifica até 5 das que passam e imprime o tipo (GASTA IA)
 *
 * Não grava nada no banco (nem o ponto de leitura, nem gasto de IA), não envia nada, não marca nada como lido: as pastas
 * são abertas só para leitura. Nunca roda na CI nem por agente: abre a caixa de verdade do dono.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEmail, createProvider } from '../packages/ai/src/index';
import { closeDb, createDb, getMailAccount, mailMatchPool, threadJobs } from '../packages/db/src/index';
import { acceptMatch, createGmailMailbox, pickCandidates, type Mailbox } from '../packages/mail/src/index';
import {
  SMOKE_DAYS, checkSmokeFolders, formatSmokeSummary, parseMailSmokeArgs, readRecentInbox, summarizeSmoke, terminalText,
} from '../packages/mail/src/smoke';
import { createSettingsService } from '../packages/settings/src/index';
import { EMAIL_KIND_LABELS } from '../packages/shared/src/index';

const parsed = parseMailSmokeArgs(process.argv.slice(2), process.env);
// A trava vem antes de qualquer outra coisa: com erro (inclusive CI), nada é lido nem aberto.
if ('error' in parsed) {
  console.error(parsed.error);
  process.exit(1);
}
const { classify } = parsed;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const errorText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e));
/** O assunto como o terminal pode mostrar: uma linha, sem caracteres de controle (um assunto hostil pode trazê-los). */
const subjectLine = (subject: string) => terminalText(subject) || '(sem assunto)';

/** Tudo o que abre algo roda aqui dentro; o código de saída é devolvido (nunca `process.exit`), então o `finally` sempre roda. */
async function main(): Promise<number> {
  const fail = (message: string): number => {
    console.error(message);
    return 1;
  };
  if (!process.env.DATABASE_URL) return fail('DATABASE_URL não definida. Copie .env.example para .env e ajuste a URL do Postgres.');
  const db = createDb();
  let mailbox: Mailbox | null = null;
  try {
    const settings = createSettingsService(db);
    const account = await getMailAccount(db);
    if (!account) return fail('Nenhuma caixa conectada. Conecte a caixa em Configurações > E-mail e rode de novo.');
    const secret = await settings.readSecret('mail_password');
    if (secret.value === null) return fail(`A senha da caixa não pôde ser lida: ${secret.problem}`);

    let provider: ReturnType<typeof createProvider> | null = null;
    if (classify > 0) {
      const { config, problem } = await settings.aiConfig();
      if (!config) return fail(`--classify precisa da IA configurada: ${problem ?? 'IA não configurada'}.`);
      provider = createProvider(config);
      console.log(
        `ATENÇÃO: --classify ${classify} faz até ${classify} chamada(s) REAIS ao provedor ${config.provider} (modelo ${config.models.fast}) ` +
          'e gasta dinheiro. O gasto não entra no histórico do app.',
      );
    }

    // O Gmail de verdade, mesmo com FAKE_MAIL no ambiente: é a caixa real que este comando confere.
    mailbox = createGmailMailbox({ address: account.address, password: secret.value });
    console.log(`Abrindo ${account.address} só para leitura…`);
    await mailbox.check();
    const { mails, truncated } = await readRecentInbox(mailbox, Date.now());
    const threads = await threadJobs(db, [...new Set(mails.map((m) => m.threadKey))]);
    const pool = await mailMatchPool(db);
    const summary = summarizeSmoke(
      mails,
      { ownAddress: account.address, knownThreads: new Set(threads.keys()), companies: pool.map(({ company, title }) => ({ company, title })) },
      truncated,
    );
    console.log('');
    for (const line of formatSmokeSummary(summary, SMOKE_DAYS)) console.log(line);
    // A leitura do app busca o fio de cada mensagem que passa ("Todos os e-mails") e confere envios em Enviados.
    const first = summary.passed[0];
    if (first) {
      console.log('');
      for (const line of await checkSmokeFolders(mailbox, first.mail.threadKey)) console.log(line);
    }

    if (provider && summary.passed.length > 0) {
      console.log('', `Classificação (até ${classify}):`);
      for (const { mail } of summary.passed.slice(0, classify)) {
        const candidates = pickCandidates(mail, pool, threads.get(mail.threadKey) ?? null);
        try {
          const { data } = await classifyEmail(provider, {
            mail: { fromName: mail.from.name, fromAddress: mail.from.address, subject: mail.subject, date: mail.date, text: mail.text },
            candidates: candidates.map((c) => ({ id: c.jobId, company: c.company, title: c.title, appliedAt: c.appliedAt })),
          });
          const jobId = acceptMatch(data.jobId, mail, candidates);
          const job = candidates.find((c) => c.jobId === jobId);
          console.log(`- ${subjectLine(mail.subject)} | ${EMAIL_KIND_LABELS[data.kind]} | ${job ? `${job.company} · ${job.title}` : 'sem vaga'}`);
        } catch (e) {
          console.log(`- ${subjectLine(mail.subject)} | a classificação falhou: ${terminalText(errorText(e))}`);
        }
      }
    }
    return 0;
  } catch (e) {
    return fail(`mail:smoke parou: ${errorText(e)}`);
  } finally {
    await mailbox?.close().catch(() => {});
    await closeDb(db);
  }
}

process.exitCode = await main();

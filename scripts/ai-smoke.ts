/**
 * Roteiro MANUAL de conferência dos provedores de IA. GASTA DINHEIRO DE VERDADE: faz chamadas reais
 * (teste de conexão, perfil, tradução do perfil, camada 1 duas vezes, camada 2, camada 3) em cada provedor
 * que tiver chave, com um currículo e uma vaga FICTÍCIOS, e imprime a saída, os tokens e o custo estimado.
 *
 * Nunca roda na CI nem em teste automatizado. Só rode com a chave e o aval do dono do projeto:
 *
 *   pnpm ai:smoke -- --yes                 todos os provedores com chave
 *   pnpm ai:smoke -- --yes anthropic       só um (anthropic | openai | gemini)
 *
 * A chave de cada provedor vem do mesmo lugar que o app usa (serviço de configurações): a variável de
 * ambiente do provedor, se definida; senão a chave gravada pela aba Configurações, decifrada com
 * APP_SECRET (precisa de DATABASE_URL). Sem DATABASE_URL, só as variáveis de ambiente valem. A chave
 * nunca é impressa.
 */
import { existsSync } from 'node:fs';
import {
  AiError, analyzeJob, createProvider, describeViolations, draftTailored, estimateCostUsd, extractProfile,
  resolveAiConfig, resolveTailored, scoreJobs, scrubSecrets, testConnection, translateProfile, type AiTier, type AiUsage,
} from '../packages/ai/src/index';
import { SAMPLE_JOB, SAMPLE_RESUME_TEXT } from '../packages/ai/src/testing';
import { closeDb, createDb } from '../packages/db/src/index';
import { AI_KEY_ENV_VARS, AI_PROVIDER_IDS, type AiProviderId } from '../packages/shared/src/index';
import { createSettingsService } from '../packages/settings/src/index';

const args = process.argv.slice(2).filter((a) => a !== '--');

// As duas travas vêm antes de qualquer outra coisa: nada é lido (nem o .env) e nada é aberto sem elas.
if (process.env.CI) {
  console.error('ai:smoke não roda na CI: ele faz chamadas reais aos provedores de IA e gasta dinheiro.');
  process.exit(1);
}
if (!args.includes('--yes')) {
  console.error(
    'ATENÇÃO: este roteiro faz chamadas REAIS aos provedores de IA e gasta dinheiro (centavos de dólar por provedor).\n' +
      'Rode de novo com --yes para confirmar:  pnpm ai:smoke -- --yes [anthropic|openai|gemini]',
  );
  process.exit(1);
}

const only = args.filter((a) => a !== '--yes');
const unknown = only.filter((a) => !(AI_PROVIDER_IDS as readonly string[]).includes(a));
if (unknown.length > 0) {
  console.error(`Provedor desconhecido: ${unknown.join(', ')}. Use anthropic, openai ou gemini.`);
  process.exit(1);
}
if (existsSync('.env')) process.loadEnvFile('.env');

const selected: AiProviderId[] = AI_PROVIDER_IDS.filter((p) => only.length === 0 || only.includes(p));
let total = 0;
let ran = 0;
let failed = false;
// Com banco, as chaves gravadas pela tela também valem; o serviço decifra na hora e não as guarda.
const db = process.env.DATABASE_URL ? createDb() : null;
const settings = db ? createSettingsService(db) : null;

try {
  for (const name of selected) {
    let resolved;
    try {
      resolved = settings
        ? await settings.aiConfig(name)
        : resolveAiConfig({ AI_PROVIDER: name, [AI_KEY_ENV_VARS[name]]: process.env[AI_KEY_ENV_VARS[name]] });
    } catch (e) {
      // Banco fora do ar ou sem as tabelas: diz o que houve, sem a pilha, e segue para o próximo provedor.
      failed = true;
      console.error(`\n=== ${name}: não foi possível ler a configuração (${scrubSecrets(e instanceof Error ? e.message.split('\n')[0] : String(e))})`);
      continue;
    }
    const { config, problem } = resolved;
    if (!config) {
      console.log(`\n=== ${name}: pulado (${problem})`);
      continue;
    }
    ran++;
    console.log(`\n=== ${name}: fast=${config.models.fast} strong=${config.models.strong}`);
    const provider = createProvider(config);
    let spent = 0;
    const report = (step: string, tier: AiTier, res: { usage: AiUsage; model: string }, data: unknown) => {
      const cost = estimateCostUsd(res.model, res.usage, config.models[tier]);
      spent += cost;
      console.log(`\n--- ${step} | modelo ${res.model} | entrada ${res.usage.inputTokens} | saída ${res.usage.outputTokens} | ~US$ ${cost.toFixed(5)}`);
      console.log(JSON.stringify(data, null, 2));
    };
    try {
      const ping = await testConnection(provider);
      report('teste de conexão', 'fast', ping, ping.data);

      const profile = await extractProfile(provider, SAMPLE_RESUME_TEXT);
      report('perfil (extração)', 'strong', profile, profile.data);

      const scores = await scoreJobs(provider, profile.data, [SAMPLE_JOB]);
      report('camada 1 (nota e título)', 'fast', scores, scores.data);
      // Segunda chamada igual: no Claude, confira o cache de prefixo comparando a entrada cobrada na fatura.
      const again = await scoreJobs(provider, profile.data, [SAMPLE_JOB]);
      report('camada 1 (repetida, para o cache de prompt)', 'fast', again, again.data);

      const analysis = await analyzeJob(provider, profile.data, SAMPLE_JOB);
      report('camada 2 (tradução e análise)', 'strong', analysis, analysis.data);

      // A vaga fictícia é em inglês: como no app, a camada 3 usa o perfil do idioma da vaga (aqui, por tradução).
      const english = await translateProfile(provider, profile.data, 'en');
      report('perfil (tradução para o inglês)', 'strong', english, english.data);

      const draft = await draftTailored(provider, english.data, SAMPLE_JOB, 'en');
      report('camada 3 (rascunho do currículo adaptado)', 'strong', draft, draft.data);
      const { violations } = resolveTailored(draft.data, english.data, 'en', {
        jobCompany: SAMPLE_JOB.company, jobTitle: SAMPLE_JOB.title,
        jobKeywords: [...analysis.data.analysis.keywordsMissing, ...analysis.data.analysis.keywordsPresent],
      });
      console.log(
        violations.length === 0
          ? '\nverificador de não invenção: APROVADO'
          : `\nverificador de não invenção: BLOQUEADO: ${describeViolations(violations)}`,
      );
    } catch (e) {
      failed = true;
      // Custo de uma chamada que o provedor cobrou e depois falhou (recusa, corte, saída inválida).
      if (e instanceof AiError && e.usage) spent += estimateCostUsd(e.model ?? config.models.strong, e.usage, config.models.strong);
      const message = scrubSecrets(e instanceof Error ? e.message : String(e), [config.apiKey]);
      console.error(`\n${name} FALHOU: ${e instanceof AiError ? `[${e.kind}] ` : ''}${message}`);
    }
    console.log(`\n${name}: custo estimado desta execução ~US$ ${spent.toFixed(5)}`);
    total += spent;
  }
} finally {
  if (db) await closeDb(db).catch(() => {});
}

if (ran === 0) {
  console.error(
    '\nNenhum provedor configurado: nada foi chamado e nada foi gasto.\n' +
      'Defina a chave do provedor no .env (ANTHROPIC_API_KEY, OPENAI_API_KEY ou GEMINI_API_KEY) ou grave-a na aba\n' +
      'Configurações (e rode com DATABASE_URL e APP_SECRET definidos), e tente de novo.',
  );
  process.exit(1);
}
console.log(`\nTotal estimado: ~US$ ${total.toFixed(5)}. Confira o valor real no painel de cada provedor.`);
process.exit(failed ? 1 : 0);

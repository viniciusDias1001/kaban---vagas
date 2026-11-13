import { AiError, createProvider } from '@kv/ai';
import {
  applyDataDir, applySites, browserProfileDir, createBrowserSession, detectBrowserChannel, fakeLaunch, realLaunch,
  type LaunchContext,
} from '@kv/apply';
import { fetchJobDescription } from '@kv/connectors';
import type { Db } from '@kv/db';
import type { SettingsService } from '@kv/settings';
import { applyAvailability } from '@kv/shared';
import { createApplyQueue, type ApplyQueue } from './queue';

/** Com o site de teste, a varredura roda a cada 5 s (o e2e não espera 5 min). */
const FAKE_SWEEP_MS = 5_000;
const NO_BROWSER =
  'Nenhum navegador encontrado para a candidatura automática: instale o Chrome ou o Edge, ou aponte APPLY_BROWSER para o executável (ou para "chrome"/"msedge").';

/**
 * Monta a fila para o processo: sites de `applySites(env)`, navegador real (o de `APPLY_BROWSER`, ou Chrome/Edge achados no
 * sistema) ou, com `FAKE_APPLY_SITE=1`, o Chromium do Playwright sem janela e com a rede cortada; pasta de dados de
 * `applyDataDir(env)`; disponibilidade = HOST local e navegador encontrado (relida a cada verificação; a fila a publica
 * para a API e, indisponível, termina os comandos do app com o motivo).
 */
export function createApplyRuntime(
  db: Db,
  settings: SettingsService,
  opts: { env?: NodeJS.ProcessEnv; log?: (msg: string) => void } = {},
): ApplyQueue & { close(): Promise<void> } {
  const env = opts.env ?? process.env;
  const fake = env.FAKE_APPLY_SITE === '1';
  const sites = applySites(env);
  const dataDir = applyDataDir(env);
  const host = applyAvailability(env);
  // O navegador é procurado de novo a cada verificação e a cada abertura: uma atualização que muda o executável de
  // pasta (o Opera GX faz isso) aparece na tela como indisponível e volta sozinha quando o caminho volta a existir.
  const availability = (): { available: boolean; reason: string | null } =>
    !host.available ? host : fake || detectBrowserChannel(env) ? host : { available: false, reason: NO_BROWSER };
  const launch: LaunchContext = fake
    ? fakeLaunch()
    : async (userDataDir) => {
        const choice = detectBrowserChannel(env);
        if (!choice) throw new Error(NO_BROWSER);
        return realLaunch(choice)(userDataDir);
      };
  const browser = createBrowserSession({ userDataDir: browserProfileDir(dataDir), launch });
  const queue = createApplyQueue({
    db, settings, sites: () => sites, browser, dataDir, availability, fetchDescription: fetchJobDescription, log: opts.log,
    ai: async () => {
      const { config, problem } = await settings.aiConfig();
      if (!config) throw new AiError('config', problem ?? 'IA não configurada');
      return { provider: createProvider(config), config };
    },
    ...(fake ? { sweepMs: FAKE_SWEEP_MS } : {}),
  });
  return { ...queue, close: () => browser.close() };
}

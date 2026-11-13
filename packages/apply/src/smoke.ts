import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Page } from 'playwright';
import type { AnswerValue, PendingQuestion, Question, ResolvedAnswer } from '@kv/shared';
import type { ApplyJob, ApplySite } from './types';
import { greenhouseSite } from './sites/greenhouse';
import { leverSite } from './sites/lever';

/*
 * O ensaio do `pnpm apply:smoke`: abre UMA vaga de verdade, preenche como o worker faria, fotografa e para.
 * Este módulo não chama o método de envio do site em nenhum caminho, e o comando não tem opção que o faça.
 */

export type SmokeSite = 'linkedin' | 'greenhouse' | 'lever';
const SMOKE_SITES: readonly SmokeSite[] = ['linkedin', 'greenhouse', 'lever'];
const MAX_STEPS = 12;

export interface SmokeArgs {
  site: SmokeSite; url: string; resumePath: string | null;
  /** O país da vaga (BR ou INT), que decide quais respostas salvas com país valem; INT sem `--country`. */
  country: 'BR' | 'INT';
}

/** Aceita só `--site`, `--job`, `--resume` e `--country` (e ignora o `--` solto que o pnpm repassa). Com `CI` definida, recusa. */
export function parseSmokeArgs(argv: string[], env: NodeJS.ProcessEnv): SmokeArgs | { error: string } {
  if (env.CI) return { error: 'apply:smoke não roda na CI: ele abre um formulário real em um navegador com janela.' };
  const args = argv.filter((a) => a !== '--');
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (flag !== '--site' && flag !== '--job' && flag !== '--resume' && flag !== '--country') {
      return { error: `Argumento não aceito: ${flag}. Use --site <linkedin|greenhouse|lever> --job <url> [--resume <pdf>] [--country BR|INT]. O ensaio nunca envia a candidatura.` };
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `Falta o valor de ${flag}.` };
    values.set(flag, value);
  }
  const site = values.get('--site');
  if (!site || !(SMOKE_SITES as readonly string[]).includes(site)) return { error: 'Use --site linkedin, greenhouse ou lever.' };
  const url = values.get('--job');
  if (!url) return { error: 'Falta --job <endereço da vaga>.' };
  try {
    new URL(url);
  } catch {
    return { error: `O endereço da vaga não é válido: ${url}` };
  }
  const country = (values.get('--country') ?? 'INT').toUpperCase();
  if (country !== 'BR' && country !== 'INT') return { error: 'Use --country BR (vaga no Brasil) ou INT (vaga fora do Brasil).' };
  return { site: site as SmokeSite, url, resumePath: values.get('--resume') ?? null, country };
}

/** `<pasta de dados>/smoke/<site>-AAAAMMDD-HHmmss.png`, na hora local. */
export function smokeShotPath(dataDir: string, site: string, now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return join(dataDir, 'smoke', `${site}-${stamp}.png`);
}

/** A foto mostra dados do dono: nunca pode cair dentro do repositório. */
export function assertOutsideRepo(path: string, repoRoot: string): void {
  const rel = relative(resolve(repoRoot), resolve(path));
  const escapes = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
  if (rel === '' || !escapes) {
    throw new Error(`O caminho ${path} fica dentro do repositório; a foto do ensaio precisa ficar fora do repositório.`);
  }
}

/** Os roteiros que existem hoje; o do LinkedIn entra aqui quando ele for gravado. */
export function smokeSiteFor(id: SmokeSite): ApplySite | null {
  const sites: Partial<Record<SmokeSite, ApplySite>> = { greenhouse: greenhouseSite, lever: leverSite };
  return sites[id] ?? null;
}

/** O que a vaga sintética leva de uma vaga do worker, até onde o endereço permite (a empresa vem do roteiro). */
export function smokeJobFor(site: SmokeSite, url: string): ApplyJob {
  const job: ApplyJob = { id: 0, source: site, url, externalId: '', company: '', title: 'Ensaio' };
  if (site !== 'greenhouse') return job;
  try {
    const parsed = new URL(url);
    const jid = parsed.searchParams.get('gh_jid');
    if (jid && !parsed.hostname.endsWith('greenhouse.io')) {
      // Vaga no domínio da empresa: o quadro vem do nome do domínio (o melhor palpite sem rede); o roteiro confere o `gh_jid`.
      const labels = parsed.hostname.split('.').filter((l) => !['www', 'careers', 'jobs', 'job', 'boards'].includes(l));
      if (labels.length > 1) labels.pop(); // o domínio de topo
      while (labels.length > 1 && ['co', 'com', 'org', 'net'].includes(labels[labels.length - 1]!)) labels.pop(); // `acme.co.uk` -> `acme`
      const slug = labels[labels.length - 1] ?? '';
      if (slug) job.externalId = `${slug}-${jid}`;
    }
  } catch { /* o endereço já foi validado */ }
  return job;
}

/** Com o modelo configurado e o limite do dia por atingir, o ensaio propõe respostas ("review"); senão fica "off". */
export function smokeAiMode(input: { configured: boolean; withinBudget: boolean }): { mode: 'review' | 'off'; line: string } {
  const off = (why: string) => ({ mode: 'off' as const, line: `Respostas do modelo: DESLIGADAS neste ensaio (${why}); só as regras e as respostas salvas respondem.` });
  if (!input.configured) return off('IA não configurada');
  if (!input.withinBudget) return off('limite diário de IA atingido');
  return {
    mode: 'review',
    line: 'Respostas do modelo: LIGADAS em modo de revisão (chamadas pagas, cobradas na camada Candidatura); o que o modelo propõe só é impresso, nunca digitado.',
  };
}

export interface SmokeResolution {answers: ResolvedAnswer[]; pending: PendingQuestion[] }

export interface SmokeDeps {
  site: ApplySite; job: ApplyJob; page: Page;
  /** O que o resolvedor devolve: respostas e pendências (uma proposta do modelo é só pendência). */
  resolve(questions: Question[]): Promise<SmokeResolution>;
  resumePath: string; shotPath: string; print(line: string): void;
}

export interface SmokeReport { outcome: 'filled' | 'pending' | 'unavailable' | 'gate'; detail: string; steps: number; shotPath: string | null }

const show = (value: AnswerValue): string => (value === null ? '(em branco)' : Array.isArray(value) ? value.join(' | ') : String(value));

export async function runSmoke(deps: SmokeDeps): Promise<SmokeReport> {
  const { site, job, page, print } = deps;
  const target = site.match(job);
  if (!target) return { outcome: 'unavailable', detail: 'a vaga não é deste site', steps: 0, shotPath: null };
  let steps = 0;
  const shoot = async (): Promise<string> => {
    await page.screenshot({ path: deps.shotPath, fullPage: true });
    return deps.shotPath;
  };
  try {
    const opened = await site.open(page, target);
    if (opened.kind === 'unavailable') {
      print(`Vaga indisponível: ${opened.reason}`);
      return { outcome: 'unavailable', detail: opened.reason, steps, shotPath: null };
    }
    let unresolved = false;
    for (let n = 1; n <= MAX_STEPS; n++) {
      const gate = await site.humanGate(page);
      if (gate) {
        print(`Portão humano: ${gate}. O ensaio para aqui, sem ler nem preencher.`);
        return { outcome: 'gate', detail: gate, steps, shotPath: await shoot() };
      }
      const read = await site.readStep(page);
      print(`\nEtapa ${n}: ${read.questions.length} pergunta(s)`);
      for (const q of read.questions) {
        print(`  ? ${q.label} [${q.kind}, ${q.required ? 'obrigatória' : 'opcional'}, ${q.options.length} opção(ões)]`);
      }
      const { answers, pending } = await deps.resolve(read.questions);
      for (const q of read.questions) {
        const answer = answers.find((a) => a.questionId === q.id);
        const wait = pending.find((p) => p.question.id === q.id);
        if (answer) print(`  = ${q.label}: ${show(answer.value)} (origem: ${answer.source})`);
        else if (wait?.proposal) print(`  ~ ${q.label}: PROPOSTA (aguarda a sua aprovação): ${show(wait.proposal.value)}`);
        else if (q.required) print(`  ! ${q.label}: SEM RESPOSTA`);
      }
      if (pending.length > 0 || read.questions.some((q) => q.required && !answers.some((a) => a.questionId === q.id))) unresolved = true;
      await site.fillStep(page, answers, { resumePath: deps.resumePath });
      steps = n;
      if (read.isLast) break;
      if (n === MAX_STEPS) {
        // Sem avançar: a foto mostra a etapa preenchida, não a seguinte, ainda em branco.
        print(`Parei na etapa ${MAX_STEPS}: o formulário tem mais etapas do que o ensaio percorre.`);
        break;
      }
      await site.next(page);
    }
    const shot = await shoot();
    return { outcome: unresolved ? 'pending' : 'filled', detail: unresolved ? 'há pergunta obrigatória sem resposta aprovada' : 'preenchido, nada enviado', steps, shotPath: shot };
  } finally {
    await site.discard(page).catch((e: unknown) => print(`Não consegui fechar o formulário: ${e instanceof Error ? e.message : String(e)}`));
  }
}

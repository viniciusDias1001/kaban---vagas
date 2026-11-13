# Candidatura Automática: Sites Reais Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Greenhouse, Lever e LinkedIn viram sites de candidatura de verdade: cada um implementa o contrato `ApplySite` do plano base, é testado contra páginas gravadas, entra em `applySites()` e pode ser conferido à mão com `pnpm apply:smoke`, sempre em ensaio.

**Architecture:** Um arquivo por site em `packages/apply/src/sites/`, cada um com uma fábrica que recebe por parâmetro os tempos e o acesso à rede (o padrão de `createLinkedin(deps)` e `openIndeedSession(launch)` nos conectores). O código conhece os passos de cada site e nenhum passo depende de saída de modelo. As páginas de teste vêm de um gravador novo e passam por um módulo de limpeza antes de entrar no repositório.

**Tech Stack:** o do repositório (Node 24+, pnpm 10, TypeScript, Vitest, Playwright 1.65 já declarado em `@kv/apply` pelo plano base). Nenhuma dependência nova: a limpeza usa expressões regulares e o DOM da própria página.

**Spec:** `docs/superpowers/specs/2026-11-12-candidatura-automatica-design.md`, Parte B: "Restrições", "Navegador e contas", "Sites", "Quando o humano é necessário", "Limites, ritmo e freio" (o que um roteiro informa), "Testes" (roteiros e `pnpm apply:smoke`) e os critérios de aceite 1, 2 e 10.

**Plano irmão:** `docs/superpowers/plans/2026-11-12-candidatura-base.md`, no mesmo branch (`feat/candidatura-automatica`). Este plano começa depois das tasks dele que criam `packages/apply/src/types.ts`, `sites/index.ts`, `testing.ts`, `browser.ts` e `data-dir.ts`; a Task 7 daqui precisa também de `answers/resolve.ts` e de `apps/worker/src/apply/resume.ts`.

## Global Constraints

- O contrato é o do plano base, usado como está: `ApplySite`, `ApplyTarget`, `ApplyJob`, `StepRead`, `Unavailable`, `HumanGate`, `SiteLayoutError`, `SubmitRejectedError` (`packages/apply/src/types.ts`); `applySites()` e `siteFor()` (`sites/index.ts`); `openFixture(routes)` (`testing.ts`); `Question`, `ResolvedAnswer`, `ApplySiteId` (`@kv/shared`). Nenhuma task redefine nem muda a assinatura de nenhum deles.
- Um roteiro nunca navega por saída de modelo. Ele só abre os endereços que `match` monta a partir da vaga, nos hosts fixos `job-boards.greenhouse.io`, `jobs.lever.co` e `www.linkedin.com`.
- Um roteiro nunca resolve nem contorna captcha e não disfarça o navegador. `humanGate` só detecta.
- Um roteiro nunca lê nem preenche campo de página de login. A senha é digitada pelo dono na página do site.
- Nenhum teste automatizado toca a rede. Teste que abre navegador chama-se `*.browser.test.ts`, usa `openFixture` e roda com `pnpm test:browser`; os demais rodam com `pnpm test`.
- Fixtures ficam em `packages/apply/fixtures/<site>/`. Nada entra ali sem passar por `scrubFixture`, e `findLeaks` precisa devolver vazio para todo arquivo (Task 1). Nenhum binário é commitado.
- O gravador e o `pnpm apply:smoke` nunca enviam uma candidatura. O `apply:smoke` recusa rodar com `CI` definida e não tem opção de envio.
- Seletores: papel acessível e texto visível, em português e em inglês, antes de classe CSS.
- O roteiro não espera entre candidaturas, não repete nada por conta própria e não conta limites: ritmo, novas tentativas e freio são da fila (plano base).
- Nenhuma dependência nova. Texto de interface em pt-BR; identificadores e commits em inglês, estilo convencional; toda mensagem de commit termina com a linha `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

Condições que o spec implica e que mais provavelmente atingem o dono. Cada uma tem o teste na task indicada.

1. **Vaga do LinkedIn com endereço de subdomínio de país.** O conector de busca grava `https://br.linkedin.com/jobs/view/<slug>-<id>` (conferido em `packages/connectors/fixtures/linkedin.html`), não `www.linkedin.com`. Esperado: a vaga é reconhecida e aberta em `https://www.linkedin.com/jobs/view/<id>/`. Task 5.
2. **O Lever sobrescreve um campo depois que o roteiro o preencheu**, porque a leitura do currículo termina tarde. Esperado: o valor final é o do perfil; se o campo não firmar, nada é enviado. Task 3.
3. **Board do Greenhouse com hífen no nome, ou vaga cujo endereço público é do site da empresa** (`?gh_jid=`). Esperado: o board é tudo antes do último hífen do `externalId` e o formulário abre no endereço `embed/job_app`. Task 2.
4. **Página de vaga do LinkedIn em estado enganoso**: a sessão expirou (página pública, sem o botão) ou a vaga já recebeu candidatura e ainda mostra o botão. Esperado: `login`, nunca `external` (que descartaria a vaga para sempre); `already_applied`, nunca um segundo formulário. Task 5.
5. **Lista obrigatória cuja resposta resolvida não está entre as opções que a página oferece.** Esperado: nenhuma opção "parecida" é escolhida; o roteiro para com `SiteLayoutError` e o campo fica vazio. Task 2 (o helper é comum aos três sites).

---

## Decisões tomadas no plano

As quatro primeiras vieram prontas e não se reabrem; as demais são deste plano.

1. **`match` decide sem rede**, pela fonte e pelo endereço:

   | Site | Reconhece | `ApplyTarget.url` | `ref` |
   |---|---|---|---|
   | Greenhouse | host `boards.greenhouse.io` ou `job-boards.greenhouse.io` com caminho `/<board>/jobs/<id>` ou `/embed/job_app?for=&token=`; ou fonte `greenhouse` com parâmetro `gh_jid` em qualquer host | `https://job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` | `{ board, jobId }` |
   | Lever | host `jobs.lever.co` com caminho `/<empresa>/<id>`, com ou sem `/apply` | `https://jobs.lever.co/<empresa>/<id>/apply`, sem query | `{ company, postingId }` |
   | LinkedIn | host `linkedin.com` ou subdomínio dele, com caminho `/jobs/view/` terminado em dígitos | `https://www.linkedin.com/jobs/view/<id>/` | `{ jobId }` |

   No Greenhouse com host próprio, board e id vêm do caminho; com `gh_jid`, vêm do `externalId`, partido no **último** hífen. Vaga da fonte `greenhouse` em domínio da empresa **sem** `gh_jid` não é reconhecida (a regra recebida é literal). No LinkedIn a regra recebida dizia só `www.linkedin.com`; foi alargada aos subdomínios porque é isso que o conector grava (Review Focus 1), e o endereço aberto continua sendo sempre o de `www`.
2. **O Greenhouse lê as perguntas da API pública e preenche o formulário `embed/job_app`.** Demográficas opcionais saem com `required: false`, para o resolvedor deixá-las em branco.
3. **Fixtures.** Greenhouse e Lever são gravados dos formulários públicos pelo gravador da Task 1. O LinkedIn só pode ser gravado com o perfil logado do dono (Task 4) e passa pela limpeza antes de qualquer commit; os seletores dele são derivados dessas fixtures (Task 5).
4. **`pnpm apply:smoke -- --site <id> --job <url>`** roda uma candidatura real só em ensaio (Task 7).
5. **Dois tipos de gravação.** `replay` guarda as respostas GET do próprio site (documento, scripts, estilos, dados) para a página rodar o JavaScript dela no teste; "próprio site" é o mesmo domínio registrável do formulário (`*.greenhouse.io`, `*.lever.co`), porque o JavaScript vem de um subdomínio de CDN. `snapshot` guarda o DOM já renderizado, sem scripts. Página que não se grava sem enviar ou sem esperar um acaso (confirmação de envio, verificação de conta) é escrita à mão, leva o sufixo `.synthetic.html` e é trocada pela real quando aparecer no uso.
6. **`Question.id` é o endereço do campo**, estável entre `readStep` e `fillStep` e entre duas aberturas da mesma vaga. Greenhouse: o `name` do campo na API. Lever: o atributo `name` do controle ou do grupo. LinkedIn: o `id` do controle ou do `fieldset`.
7. **Valor por tipo.** `text`, `longtext`, `number`, `date`: o texto é digitado. `select`: texto igual a uma opção. `multiselect`: lista de opções. `boolean`: marca ou desmarca. `file`: valor não nulo manda enviar `files.resumePath`, e **só** no campo de currículo do site; outro campo de arquivo nunca recebe nada. `null`: o campo fica vazio. Resposta cujo `questionId` não está na etapa visível é ignorada.
8. **Opção de lista nunca é aproximada.** A comparação ignora só caixa e espaços repetidos. Sem opção igual, `SiteLayoutError`. Em lista com busca, o roteiro pode digitar para filtrar, mas só vale o clique na opção de texto igual.
9. **Três tipos de falha.** Página carregada e diferente do esperado: `SiteLayoutError`. Envio clicado sem confirmação e sem erro de campo: `SubmitRejectedError` (Nota posterior: uma decisão da Task 11 mudou isto. Depois do clique, `SubmitRejectedError` vira `needs_human` com `confirm_submission`; antes do clique, com `unsupported_form`). Falha de rede ou de carregamento (`page.goto` falha ou passa de 30 s): o erro sobe como veio, porque é passageiro e a fila tenta de novo.
10. **Portão vence layout.** Se a página aberta por `open` é um portão (`humanGate` não nulo), `open` devolve `{ kind: 'form' }` sem clicar em nada, para o motor consultar `humanGate` em seguida. `humanGate` não navega, não clica e não altera a página.
11. **`submit` é idempotente e conservador.** Com a confirmação já na tela, devolve-a sem clicar. Sem ela, clica uma vez e espera `submitMs`. Só há sucesso com o formulário fora da tela **e** um sinal de confirmação. Formulário fora da tela sem sinal: `SiteLayoutError` com a mensagem "confira no site se a candidatura foi enviada". Erro de campo visível depois do clique: `SiteLayoutError`.
12. **`discard`.** Greenhouse e Lever: limpa `localStorage` e `sessionStorage` da origem do formulário e vai para `about:blank`. LinkedIn: fecha o modal e escolhe "Descartar"; nunca limpa armazenamento, porque a sessão mora ali.
13. **Tempos** (o spec não os fixa; todos entram por parâmetro): carregar página `30 s`; aparecer controle ou trocar de etapa `15 s`; confirmação do envio `30 s`; leitura do currículo no Lever `20 s`, com conferência dos campos `1,5 s` depois de preencher.
14. **Sinais de confirmação e textos do LinkedIn são hipóteses**, não verificadas. Greenhouse: caminho com `confirmation` ou texto `Thank you for applying`. Lever: caminho terminado em `/thanks` ou texto `Application submitted`. LinkedIn: `LINKEDIN_TEXT` (Task 5). Onde a página real disser outra coisa, ela manda e a constante é corrigida.

## O que este plano espera do plano base

O contrato não diz como o motor reage nestes pontos. Se o motor fizer diferente, ajuste o motor, não o contrato.

- O motor consulta `humanGate` depois de `open`, antes de cada `readStep` e de `submit`, e ao capturar `SiteLayoutError` ou `SubmitRejectedError`, antes de classificar a falha. Depois de um portão resolvido na abertura, chama `open` de novo; depois de um resolvido no envio, chama `submit` de novo.
- Erro lançado por `submit` depois do clique, que não seja `SubmitRejectedError`, vira `confirm_submission`, nunca nova tentativa.
- `pnpm test:browser` existe na raiz, aceita um caminho de arquivo como filtro, e `pnpm test` não roda `*.browser.test.ts`.
- `browser.ts` exporta como abrir o perfil persistente com janela; `data-dir.ts`, a pasta de dados.

## File Structure

```
packages/apply/scripts/record-fixture.ts   gravador: json, replay, snapshot, profile, scrub
packages/apply/src/recording/scrub.ts      regras de limpeza e detector de vazamento (funções puras)
packages/apply/src/recording/capture.ts    captura na página: replay, snapshot, bloqueio do botão de envio
packages/apply/src/sites/fixtures.ts       helpers dos testes de roteiro
packages/apply/src/sites/shared.ts         comparação de opção, portões comuns, saída do formulário, tempos
packages/apply/src/sites/greenhouse.ts, lever.ts, linkedin.ts     um roteiro por arquivo
packages/apply/src/sites/index.ts          (muda) registra os três sites
packages/apply/src/smoke.ts                núcleo do apply:smoke
packages/apply/fixtures/recording/         página escrita à mão para testar o gravador
packages/apply/fixtures/greenhouse/        job.json, form/, confirmation.synthetic.html
packages/apply/fixtures/lever/             form/, rendered.html, closed.html, confirmation.synthetic.html
packages/apply/fixtures/linkedin/          um arquivo por estado (Task 4)
scripts/apply-smoke.ts                     linha de comando do apply:smoke
apps/web/src/lib/applySites.ts             textos de cada site na tela de Configurações
apps/web/src/components/SettingsApplySection.tsx, package.json, README.md     (mudam)
```

**Ordem.** Task 1; depois 2 e 3, independentes entre si; depois 4 (precisa do dono), 5, 6 e 7. Sem a sessão do dono, o plano para depois da Task 3, com Greenhouse e Lever já registrados.

**Como ler os blocos de teste.** Uma linha `it('…')` dá o nome do teste; as linhas recuadas abaixo dela são as afirmações que ele tem de conter, com os valores exatos. O preparo vem em comentário quando as afirmações não o deixam óbvio. Cada teste de navegador usa uma página nova de `openFixture`. Helpers citados como "do teste" ficam no próprio arquivo de teste.

---

### Task 1: Gravador de fixtures e limpeza

**Files:**
- Create: `packages/apply/src/recording/scrub.ts`, `packages/apply/src/recording/capture.ts`, `packages/apply/src/sites/fixtures.ts`, `packages/apply/scripts/record-fixture.ts`
- Create: `packages/apply/fixtures/recording/page.html`, `app.js`, `site.css` (escritos à mão, dados fictícios)
- Modify: `packages/apply/tsconfig.json` (incluir `scripts`, como `packages/connectors/tsconfig.json`)
- Test: `packages/apply/src/recording/scrub.test.ts`, `clean.test.ts`, `capture.browser.test.ts`

**Interfaces:**
- Consumes: `openFixture` (`packages/apply/src/testing.ts`); `ApplyJob` (`types.ts`); `ResolvedAnswer` (`@kv/shared`).
- Produces:

```ts
// packages/apply/src/recording/scrub.ts
export interface ScrubIdentity { names: string[]; emails: string[]; phones: string[]; extra: string[] }
export const NO_IDENTITY: ScrubIdentity;   // as quatro listas vazias
export const PLACEHOLDER: { name: 'Pessoa Exemplo'; email: 'pessoa@example.com'; phone: '+55 11 90000-0000'; slug: 'pessoa-exemplo'; pixel: string };
export const EMAIL_PATTERN: RegExp;        // /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi
export const PHONE_PATTERN: RegExp;        // /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,5}[\s.-]\d{4}(?!\d)/g
export type FixtureKind = 'markup' | 'asset';   // .html e .json | .js e .css
export interface Leak { rule: 'email' | 'phone' | 'member_id' | 'profile_url' | 'photo' | 'token'; sample: string }
export function scrubFixture(text: string, identity: ScrubIdentity, kind?: FixtureKind): string;   // padrão 'markup'
export function findLeaks(text: string, kind?: FixtureKind): Leak[];
// packages/apply/src/recording/capture.ts
export interface ReplayCapture { routes: Record<string, string>; files: Record<string, Buffer> }   // routes: URL → nome de arquivo relativo
export function captureReplay(page: Page, url: string): Promise<ReplayCapture>;
export function captureSnapshot(page: Page, keep?: string): Promise<string>;   // keep padrão: 'main, [role="main"], [role="dialog"]'
export function blockSubmitClicks(page: Page): Promise<void>;
// packages/apply/src/sites/fixtures.ts (só para testes)
export function fixturePath(site: string, file: string): string;                       // absoluto, em packages/apply/fixtures
export function replayRoutes(site: string, capture: string): Record<string, string>;   // lê <capture>/routes.json; valores absolutos
export function job(over?: Partial<ApplyJob>): ApplyJob;   // { id: 1, source: 'greenhouse', url: '', externalId: '', company: 'Acme', title: 'Dev' }
export function ans(questionId: string, value: ResolvedAnswer['value']): ResolvedAnswer;   // source 'rule', category 'identity', basis [], bankAnswerId null
export function fakeResumePath(): string;                    // PDF mínimo de uma página em branco, escrito em código na pasta temporária
export function watchWrites(page: Page): string[];           // URL de cada requisição que não é GET, à medida que acontece
export function watchClicks(page: Page): Promise<string[]>;  // texto de cada botão ou link clicado; sobrevive a navegações
export function linkSteps(page: Page, links: Array<{ from: string; button: RegExp; to: string }>): Promise<void>;
export function inject(page: Page, html: string): Promise<void>;   // acrescenta HTML ao começo de `main`, ou do `body` se não houver `main`
```

`linkSteps` existe porque um `snapshot` não tem comportamento: na página `from`, o clique em um botão cujo texto casa com `button` leva a página para `to` (que precisa estar nas rotas), no lugar do que o JavaScript do site faria. Ele barra os tratadores da própria página, mas não impede `watchClicks` de registrar o clique.

Regras de `scrubFixture`, nesta ordem. Em `asset` vale só a regra 2.

| # | Alvo | Vira |
|---|---|---|
| 1 | cada texto de `identity.names` e `identity.extra`, sem diferenciar caixa nem acento, os mais longos primeiro | `Pessoa Exemplo` |
| 2 | cada e-mail de `identity.emails` e todo texto que casa `EMAIL_PATTERN`, salvo `@example.com` e final de nome de arquivo (`logo@2x.png`) | `pessoa@example.com` |
| 3 | cada telefone de `identity.phones`, comparado só pelos dígitos (acha `(11) 98765-4321` a partir de `11987654321`), e todo texto que casa `PHONE_PATTERN` | `+55 11 90000-0000` |
| 4 | `urn:li:<tipo>:<id>` cujo tipo contém `member`, `profile` ou `person` | `urn:li:<tipo>:0` |
| 5 | endereço de perfil `/in/<slug>`, absoluto ou relativo | `/in/pessoa-exemplo` |
| 6 | URL em `*.licdn.com` e `data:image/...` com mais de 200 caracteres, em `src`, `srcset`, `href` e `style` | `PLACEHOLDER.pixel` |
| 7 | atributo `value` de `<input>` de texto (sem `type`, ou `text`, `email`, `tel`, `url`, `number`, `search`, `hidden`, `password`) e o corpo de todo `<textarea>` | vazio |
| 8 | `JSESSIONID`, `li_at`, `csrfToken` e todo valor `ajax:<dígitos>` | `ajax:0` |

`findLeaks` acusa o que as regras 2 a 6 e 8 deixariam passar (o próprio texto de substituição não conta). As regras 1 e 7 não têm detector genérico: é para elas que existe a revisão do dono na Task 4.

`captureSnapshot` devolve um documento com `<html lang>` e `<title>` originais e, no corpo, só os elementos de `keep` com seus ancestrais; remove `script`, `code`, `iframe`, `noscript`, `meta`, `link` e comentários; e dá `style="display:none"` a todo elemento que estava com `display: none` ou `visibility: hidden` computado, para o arquivo estático esconder o que a página escondia. Se `keep` não acha nada, lança. `captureReplay` navega até `url`, espera a rede parar e mais 2 s, e guarda toda resposta GET bem-sucedida de documento, script, estilo, `fetch` e `xhr` cujo host tem o mesmo domínio registrável (os dois últimos rótulos) de `url`; aborta toda requisição que não é GET. `blockSubmitClicks` instala, em toda página do contexto, um tratador que barra o clique em botão cujo texto casa `/enviar candidatura|submit application/i`.

Modos do gravador (`pnpm exec tsx packages/apply/scripts/record-fixture.ts <modo> ...`):

| Modo | Argumentos | Faz |
|---|---|---|
| `json` | `--url <api> --out <arquivo.json>` | baixa, formata, limpa e grava |
| `replay` | `--url <url> --out <pasta>` | `captureReplay` em Chromium sem janela; grava `routes.json` e os arquivos (o documento em `document.html`) |
| `snapshot` | `--url <url> --out <arquivo.html> [--keep <seletor>]` | `captureSnapshot` em Chromium sem janela, contexto limpo |
| `profile` | `--staging <pasta fora do repositório>` | abre o perfil persistente (`browser.ts`) com janela e `blockSubmitClicks`; cada linha digitada no terminal grava `captureSnapshot` da aba ativa em `<staging>/<linha>.html`, **sem limpar**; linha vazia encerra |
| `scrub` | `--from <staging> --to <pasta de fixtures> --identity <json fora do repositório>` | aplica `scrubFixture` a cada arquivo e grava |

Regras do gravador: nunca clica em nada; todo arquivo gravado dentro do repositório passa por `scrubFixture` (com `NO_IDENTITY` quando não há `--identity`); se `findLeaks` ainda achar algo, o arquivo **não** é gravado e o processo sai com código 1, listando a regra e o trecho; `--staging` e `--identity` dentro do repositório são recusados; sem modo ou com modo desconhecido, imprime o uso e sai com código 1.

- [ ] **Step 1: Write the failing tests for the scrubber.** `scrub.test.ts`; `DIRTY` é uma página curta, escrita no teste, com um exemplo de cada regra:
  ```ts
  const me: ScrubIdentity = { names: ['Ana Beatriz Souza', 'Ana Souza'], emails: ['ana.souza@gmail.com'], phones: ['11987654321'], extra: ['Rua das Flores, 100'] };
  const LI = '<a href="https://www.linkedin.com/in/ana-souza-1a2b3c/" data-urn="urn:li:fsd_profile:ACoAAB12">x</a><img src="https://media.licdn.com/dms/image/abc/0/1"><b>ajax:1234567890123</b>';
  it('replaces identity strings wherever they appear')
    expect(scrubFixture('<p>ANA BEATRIZ SOUZA mora na Rua das Flores, 100</p>', me)).toBe('<p>Pessoa Exemplo mora na Pessoa Exemplo</p>');
    expect(scrubFixture('<span>11 98765 4321</span>', me)).toBe('<span>+55 11 90000-0000</span>');
    expect(scrubFixture('<input type="tel" value="(11) 98765-4321">', me)).toBe('<input type="tel" value="">');
  it('replaces any e-mail and any formatted phone with an empty identity, and nothing that only looks like one')
    expect(scrubFixture('<a>rh@acme.com</a> <b>+1 (555) 123-4567</b>', NO_IDENTITY)).toBe('<a>pessoa@example.com</a> <b>+55 11 90000-0000</b>');
    expect(scrubFixture('<img src="logo@2x.png"> vaga 8638232002 em 2026-11-12', NO_IDENTITY)).toBe('<img src="logo@2x.png"> vaga 8638232002 em 2026-11-12');
  it('removes member ids, profile addresses, photos and tokens')
    for (const kept of ['/in/pessoa-exemplo', 'urn:li:fsd_profile:0', PLACEHOLDER.pixel]) expect(scrubFixture(LI, NO_IDENTITY)).toContain(kept);
    expect(scrubFixture(LI, NO_IDENTITY)).not.toMatch(/ana-souza|ACoAAB12|licdn\.com|ajax:1234/);
  it('is idempotent and leaves nothing for findLeaks')
    expect(scrubFixture(scrubFixture(DIRTY, me), me)).toBe(scrubFixture(DIRTY, me));
    expect(findLeaks(scrubFixture(DIRTY, me))).toEqual([]);
    expect([...new Set(findLeaks(DIRTY).map((l) => l.rule))].sort()).toEqual(['email', 'member_id', 'phone', 'photo', 'profile_url', 'token']);
  it('touches only e-mails in script and style assets')
    expect(scrubFixture('var a="suporte@site.com",b="555-123-4567";', NO_IDENTITY, 'asset')).toBe('var a="pessoa@example.com",b="555-123-4567";');
  ```
  `clean.test.ts`; `files` é a lista recursiva de todo `.html`, `.json`, `.js` e `.css` de `packages/apply/fixtures`:
  ```ts
  it('finds fixtures to check')
    expect(files.length).toBeGreaterThan(0);
  it.each(files)('%s carries no e-mail, phone, member id, photo or token')
    expect(findLeaks(readFileSync(file, 'utf8'), /\.(js|css)$/.test(file) ? 'asset' : 'markup')).toEqual([]);
  ```
  Escreva também `fixtures/recording/page.html`: `<html lang="pt-BR">`, um `<header>` e um `<nav>` com texto, um `<main>` com o título "Vaga de teste", um `<div role="dialog">`, um `<div id="escondido" class="oculto">` (escondido por `site.css`) e um botão "Enviar candidatura" que faz `window.enviado = true` (em `app.js`). A página carrega `https://form.test/app.js`, `https://cdn.form.test/site.css` e `https://terceiro.test/rastreio.js`.
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/recording` — Expected: FAIL, `Cannot find module './scrub'`.
- [ ] **Step 3: Implement `scrubFixture` and `findLeaks` in `packages/apply/src/recording/scrub.ts`.** As duas usam as mesmas constantes de padrão, para o que uma troca ser exatamente o que a outra procura.
- [ ] **Step 4: Run to see them pass.** Run: `pnpm test packages/apply/src/recording` — Expected: PASS; o varredor cobre `fixtures/recording` e `fixtures/fake`.
- [ ] **Step 5: Write the failing tests for the capture.** `capture.browser.test.ts`, com as rotas `https://form.test/vaga` → `page.html`; `https://form.test/app.js` e `https://terceiro.test/rastreio.js` → `app.js`; `https://cdn.form.test/site.css` → `site.css`:
  ```ts
  it('replay keeps the document and first-party scripts and styles, nothing else')   // cap = await captureReplay(page, 'https://form.test/vaga')
    expect(Object.keys(cap.routes).sort()).toEqual(['https://cdn.form.test/site.css', 'https://form.test/app.js', 'https://form.test/vaga']);
    expect(Object.keys(cap.files).sort()).toEqual(Object.values(cap.routes).sort());
  it('snapshot keeps main and dialogs, drops scripts and page chrome, and freezes what was hidden')   // html = await captureSnapshot(page), em /vaga
    for (const kept of ['lang="pt-BR"', 'Vaga de teste', 'role="dialog"']) expect(html).toContain(kept);
    expect(html).not.toMatch(/<script|<nav|<header|<iframe|<code|<link/i);
    expect(html).toMatch(/id="escondido"[^>]*style="[^"]*display:\s*none/);
    await expect(captureSnapshot(page, '#nao-existe')).rejects.toThrow();
  it('blockSubmitClicks stops a click on the final submit button')   // blockSubmitClicks antes de abrir /vaga; depois clica em "Enviar candidatura"
    expect(await page.evaluate(() => (window as { enviado?: boolean }).enviado)).toBeUndefined();
  ```
- [ ] **Step 6: Run to see them fail.** Run: `pnpm test:browser packages/apply/src/recording/capture.browser.test.ts` — Expected: FAIL, `Cannot find module './capture'`.
- [ ] **Step 7: Implement `capture.ts`, `sites/fixtures.ts` and `scripts/record-fixture.ts`.** O script só junta as peças: lê os argumentos, chama `capture.ts`, aplica `scrub.ts`, grava.
- [ ] **Step 8: Run to see them pass.** Run: `pnpm test:browser packages/apply/src/recording/capture.browser.test.ts && pnpm typecheck` — Expected: PASS e typecheck limpo. Run: `pnpm exec tsx packages/apply/scripts/record-fixture.ts` — Expected: a lista dos cinco modos e código de saída 1.
- [ ] **Step 9: Commit.**
  ```bash
  git add packages/apply/src/recording packages/apply/src/sites/fixtures.ts packages/apply/scripts packages/apply/fixtures/recording packages/apply/tsconfig.json
  git commit -m "feat(apply): add fixture recorder and personal-data scrubber" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 2: Greenhouse

**Files:**
- Create: `packages/apply/src/sites/shared.ts`, `packages/apply/src/sites/greenhouse.ts`
- Create: `packages/apply/fixtures/greenhouse/job.json`, `form/`, `confirmation.synthetic.html`
- Modify: `packages/apply/src/sites/index.ts`, `packages/apply/src/sites/index.test.ts`
- Test: `packages/apply/src/sites/greenhouse.test.ts`, `packages/apply/src/sites/greenhouse.browser.test.ts`

**Interfaces:**
- Consumes: o contrato do plano base; da Task 1, os helpers de `sites/fixtures.ts` e o gravador.
- Produces:

```ts
// packages/apply/src/sites/shared.ts
export const SITE_TIMEOUTS: { pageMs: 30_000; stepMs: 15_000; submitMs: 30_000 };
export function sameText(a: string, b: string): boolean;                         // ignora caixa e espaços repetidos; nada mais
export function matchOption(options: string[], wanted: string): string | null;   // a opção oferecida igual a `wanted` por sameText, ou null
export function visibleCaptcha(page: Page): Promise<boolean>;
export function visibleCodePrompt(page: Page): Promise<boolean>;
export function leaveForm(page: Page): Promise<void>;                            // decisão 12, sites sem login
// packages/apply/src/sites/greenhouse.ts
export interface GreenhouseDeps { fetchJob(board: string, jobId: string): Promise<unknown | null>; stepMs: number; submitMs: number }
export function greenhouseTarget(job: ApplyJob): ApplyTarget | null;
export function mapGreenhouseQuestions(api: unknown): Question[];
export function createGreenhouseSite(deps?: Partial<GreenhouseDeps>): ApplySite;
export const greenhouseSite: ApplySite;   // id 'greenhouse', needsLogin false
```

Comportamento que os testes não deixam óbvio:

- `fetchJob` padrão faz `GET https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true` com limite de 30 s; HTTP 404 devolve `null`; outro status lança (erro passageiro).
- `mapGreenhouseQuestions`: uma `Question` por pergunta. `id` é o `name` do campo; `help`, a `description` sem tags, ou `''`; `maxLength: null`. Tipo do campo para `kind`: `input_text` → `text`; `textarea` → `longtext`; `input_file` → `file`; `multi_value_single_select` → `select`; `multi_value_multi_select` → `multiselect`; as opções são os `label` de `values`. Pergunta com mais de um campo: `input_file` vence, senão o primeiro; `input_hidden` é ignorado. Tipo desconhecido em pergunta obrigatória lança `SiteLayoutError`; em opcional, a pergunta é omitida. Ordem: `questions`, `location_questions`, as perguntas de `compliance`, as de `demographic_questions`, sempre com o `required` que a API informar. Só a forma de `questions` foi verificada: confira os nomes de propriedade dos blocos irmãos no `job.json` gravado antes de mapeá-los.
- `open`: chama `fetchJob`; `null` devolve `closed` sem navegar. Senão navega, aplica a decisão 10, espera o botão `Submit application` por `stepMs` (sem ele, `SiteLayoutError`) e guarda a resposta da API em um `WeakMap<Page, …>`. `readStep` e `fillStep` em página sem essa entrada lançam `SiteLayoutError`.
- `readStep`: as perguntas mapeadas e, depois delas, uma `boolean` obrigatória para cada caixa de marcação obrigatória do formulário que não pertence a nenhum campo da API (os consentimentos de `data_compliance`), com `id` igual ao `name` da caixa e `label` igual ao texto visível dela. `isLast` é sempre `true`. Pergunta obrigatória da API sem controle na página: `SiteLayoutError`.
- Localizar o controle: elemento com `id` igual ao `name` do campo; se não houver, o rótulo acessível. As listas são campos de texto com `role="combobox"` e uma `listbox`, não `<select>`: clique, espere as `option`, clique na igual (decisão 8) e confira que o controle passou a mostrar o texto escolhido. Campo de cidade com sugestões: digite, espere a lista por até 3 s e clique na sugestão que é igual ao valor ou começa por ele; sem lista, o texto digitado fica.
- `humanGate`: `captcha` quando `visibleCaptcha`; `verification_code` quando `visibleCodePrompt`; senão `null`. `visibleCaptcha` é verdadeiro só para **desafio na tela**: um `iframe` de reCAPTCHA (`src` com `recaptcha` e `/bframe`) ou de hCaptcha (`src` com `hcaptcha` e `frame=challenge`), visível, com o topo dentro da janela e pelo menos 100 × 100 px; ou a caixa "não sou um robô" (`/anchor` ou `frame=checkbox`, sem `size=invisible`) com o campo de resposta vazio. O script carregado, o `textarea` `g-recaptcha-response` e o selo invisível **não** são portão: estão em toda página. `visibleCodePrompt`: campo visível cujo rótulo casa `/(verification|security) code|código de (verificação|segurança)/i`.
- `next` lança `SiteLayoutError` sem clicar: o formulário tem uma etapa só. `sessionState` devolve `'logged_in'` sem navegar.

- [ ] **Step 1: Write the failing unit tests.** `greenhouse.test.ts`:
  ```ts
  it.each([
    ['https://job-boards.greenhouse.io/gitlab/jobs/8638232002', 'gitlab-8638232002', 'gitlab', '8638232002'],
    ['https://boards.greenhouse.io/acme-corp/jobs/4012345?gh_jid=4012345', 'acme-corp-4012345', 'acme-corp', '4012345'],
    ['https://job-boards.greenhouse.io/embed/job_app?for=acme-corp&token=4012345', '', 'acme-corp', '4012345'],
    ['https://stripe.com/jobs/search?gh_jid=7001234', 'stripe-7001234', 'stripe', '7001234'],
    ['https://careers.acme.com/open?gh_jid=4012345', 'acme-corp-4012345', 'acme-corp', '4012345'],   // Review Focus 3
  ])('recognises %s')   // (url, externalId, board, jobId)
    expect(greenhouseTarget(job({ url, externalId }))).toEqual({ site: 'greenhouse', url: `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${jobId}`, ref: { board, jobId } });
  it('does not recognise what the rule leaves out')
    expect(greenhouseTarget(job({ source: 'remotive', url: 'https://careers.acme.com/open?gh_jid=1', externalId: 'x' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'https://careers.acme.com/open/123', externalId: 'acme-123' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'https://job-boards.greenhouse.io/gitlab', externalId: 'gitlab-1' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'não é url', externalId: 'acme-1' }))).toBeNull();
  it('maps field types, options and the optional demographic block')
    const list = (name: string, type: string, labels: string[]) => ({ name, type, values: labels.map((label, value) => ({ label, value })) });
    const api = {
      questions: [
        { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
        { label: 'Resume/CV', required: true, fields: [{ name: 'resume_text', type: 'textarea', values: [] }, { name: 'resume', type: 'input_file', values: [] }] },
        { label: 'Work authorization', required: true, fields: [list('question_2', 'multi_value_single_select', ['Yes', 'No'])] },
        { label: 'Languages', required: false, fields: [list('question_3[]', 'multi_value_multi_select', ['English', 'Portuguese'])] },
        { label: 'Widget', required: false, fields: [{ name: 'question_4', type: 'tipo_novo', values: [] }] },
      ],
      compliance: [{ type: 'eeoc', questions: [{ label: 'Gender', required: false, fields: [list('gender', 'multi_value_single_select', ['Male', 'Female', 'Decline To Self Identify'])] }] }],
    };
    expect(mapGreenhouseQuestions(api).map((q) => [q.id, q.kind, q.required, q.options])).toEqual([
      ['first_name', 'text', true, []], ['resume', 'file', true, []], ['question_2', 'select', true, ['Yes', 'No']],
      ['question_3[]', 'multiselect', false, ['English', 'Portuguese']], ['gender', 'select', false, ['Male', 'Female', 'Decline To Self Identify']],
    ]);
    api.questions[4].required = true;
    expect(() => mapGreenhouseQuestions(api)).toThrow(SiteLayoutError);
  it('compares options without approximating')
    expect(matchOption(['Yes', 'No', 'Prefer not to say'], '  prefer NOT to  say ')).toBe('Prefer not to say');
    expect(matchOption(['Yes', 'No'], 'Yes, with sponsorship')).toBeNull();
    expect(matchOption(['Sim', 'Não'], 'Nao')).toBeNull();
  ```
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/sites/greenhouse.test.ts` — Expected: FAIL, `Cannot find module './greenhouse'`.
- [ ] **Step 3: Implement `greenhouseTarget`, `mapGreenhouseQuestions`, `sameText` and `matchOption`.**
- [ ] **Step 4: Run to see them pass.** Run: `pnpm test packages/apply/src/sites/greenhouse.test.ts` — Expected: PASS.
- [ ] **Step 5: Record the fixtures.** Escolha, em um board de `DEFAULT_GREENHOUSE_BOARDS`, uma vaga cujo `?questions=true` tenha ao menos um `multi_value_single_select` e um bloco demográfico (`compliance` ou `demographic_questions`) não vazio; prefira uma que tenha também `multi_value_multi_select`.
  ```bash
  pnpm exec tsx packages/apply/scripts/record-fixture.ts json   --url "https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true" --out packages/apply/fixtures/greenhouse/job.json
  pnpm exec tsx packages/apply/scripts/record-fixture.ts replay --url "https://job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>" --out packages/apply/fixtures/greenhouse/form
  ```
  Escreva à mão `confirmation.synthetic.html`: um documento mínimo com `<main><h1>Thank you for applying.</h1></main>`. Run: `pnpm test packages/apply/src/recording/clean.test.ts` — Expected: PASS, agora com os arquivos de `fixtures/greenhouse`.
- [ ] **Step 6: Write the failing browser tests.** `greenhouse.browser.test.ts`, com `openFixture({ ...routes, [DONE]: fixturePath('greenhouse', 'confirmation.synthetic.html') })`. Helpers do teste: `shownValue(page, q)`, o texto que o combobox da pergunta mostra; `uploadedNames(page)`, o nome de arquivo mostrado em cada campo de arquivo. Os valores esperados são fixos; se o HTML gravado pedir, ajuste o localizador, nunca o valor.
  ```ts
  const api = JSON.parse(readFileSync(fixturePath('greenhouse', 'job.json'), 'utf8'));
  const routes = replayRoutes('greenhouse', 'form');
  const formUrl = Object.keys(routes).find((u) => u.includes('/embed/job_app'))!;
  const DONE = formUrl.replace('/embed/job_app', '/embed/job_app/confirmation');
  const target = greenhouseTarget(job({ url: formUrl }))!;
  const site = createGreenhouseSite({ fetchJob: async () => api, stepMs: 5_000, submitMs: 1_500 });
  const mapped = mapGreenhouseQuestions(api);
  const text = mapped.find((q) => q.kind === 'text' && q.required)!, select = mapped.find((q) => q.kind === 'select')!;
  const files = { resumePath: fakeResumePath() };
  const BADGE = '<textarea name="g-recaptcha-response" style="display:none"></textarea><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible" width="256" height="60"></iframe>';
  const CHALLENGE = '<iframe id="desafio" src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x" width="400" height="580" style="position:fixed;top:0;left:0"></iframe>';

  it('opens the embed form and reads the questions the API publishes')
    expect(await site.open(page, target)).toEqual({ kind: 'form' });
    expect(await site.readStep(page)).toMatchObject({ isLast: true });
    expect((await site.readStep(page)).questions.slice(0, mapped.length)).toEqual(mapped);
  it('reports a closed job without opening the page, and a load failure as a plain error')
    expect(await createGreenhouseSite({ fetchJob: async () => null }).open(page, target)).toEqual({ kind: 'unavailable', reason: 'closed' });
    expect(page.url()).toBe('about:blank');
    await expect(site.open(page, { ...target, url: target.url.replace(/token=\d+/, 'token=1') })).rejects.not.toBeInstanceOf(SiteLayoutError);
  it('is a layout error when a required API question has no control on the page')
    // drifted = createGreenhouseSite cujo fetchJob devolve `api` mais { label: 'Pergunta que a página não tem', required: true, fields: [{ name: 'question_0', type: 'input_text', values: [] }] }
    await expect(drifted.readStep(page)).rejects.toBeInstanceOf(SiteLayoutError);
  it('fills text, picks the exact option, uploads the résumé only into the résumé field, and empties on null')
    await site.fillStep(page, [ans(text.id, 'Ana'), ans(select.id, select.options[1]), ans('resume', 'cv.pdf'), ans('cover_letter', 'cv.pdf'), ans('question_inexistente', 'x')], files);
    expect(await page.getByLabel(text.label, { exact: true }).inputValue()).toBe('Ana');
    expect(await shownValue(page, select)).toBe(select.options[1]);
    expect(await uploadedNames(page)).toEqual([basename(files.resumePath)]);
    await site.fillStep(page, [ans(text.id, null)], files);
    expect(await page.getByLabel(text.label, { exact: true }).inputValue()).toBe('');
  it('never picks a look-alike option: an answer outside the list is a layout error')   // Review Focus 5
    await expect(site.fillStep(page, [ans(select.id, `${select.options[0]} (talvez)`)], files)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(await shownValue(page, select)).toBe('');
  it('does not call a loaded captcha a gate; a challenge or a code prompt on screen is one')   // inject() entre uma afirmação e outra, nesta ordem
    expect(await site.humanGate(page)).toBeNull();                 // depois de inject(page, BADGE)
    expect(await site.humanGate(page)).toBe('captcha');            // depois de inject(page, CHALLENGE)
    expect(await site.humanGate(page)).toBeNull();                 // depois de remover #desafio
    expect(await site.humanGate(page)).toBe('verification_code');  // depois de inject(page, '<label>Verification code <input type="text"></label>')
  it('never advances and never reports success without a confirmation')   // clicks = await watchClicks(page), antes de open
    await expect(site.next(page)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks).toEqual([]);
    await expect(site.submit(page)).rejects.toBeInstanceOf(Error);
    expect(clicks.filter((c) => /submit application/i.test(c))).toHaveLength(1);
  it('returns the confirmation text, and does not click again once it is on screen')   // linkSteps(page, [{ from: formUrl, button: /submit application/i, to: DONE }])
    expect(await site.submit(page)).toEqual({ confirmation: 'Thank you for applying.' });
    expect(await site.submit(page)).toEqual({ confirmation: 'Thank you for applying.' });
    expect(clicks).toHaveLength(1);
  it('discards without sending and without leaving a draft')   // writes = watchWrites(page); localStorage.setItem('rascunho', 'x') na página; before = writes.length
    await site.discard(page);
    expect(page.url()).toBe('about:blank');
    expect(writes.length).toBe(before);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);   // depois de page.goto(formUrl) de novo
  ```
  Se a vaga gravada tiver `multiselect`, acrescente um teste que responde com duas opções e confere as duas marcadas; se não tiver, deixe-o com `it.skipIf` e o motivo.
- [ ] **Step 7: Run to see them fail.** Run: `pnpm test:browser packages/apply/src/sites/greenhouse.browser.test.ts` — Expected: FAIL, `createGreenhouseSite is not a function`.
- [ ] **Step 8: Implement `createGreenhouseSite` and the rest of `shared.ts`.**
- [ ] **Step 9: Run to see them pass.** Run: `pnpm test:browser packages/apply/src/sites/greenhouse.browser.test.ts` — Expected: PASS.
- [ ] **Step 10: Register the site.** Em `sites/index.ts`, acrescente `greenhouseSite` à lista de sites reais. Em `sites/index.test.ts`, acrescente `expect(applySites({}).map((s) => s.id)).toContain('greenhouse')`; se o teste do plano base afirma que a lista real é vazia, troque essa afirmação por esta. Run: `pnpm test packages/apply/src/sites && pnpm typecheck` — Expected: PASS.
- [ ] **Step 11: Commit.**
  ```bash
  git add packages/apply/src/sites packages/apply/fixtures/greenhouse
  git commit -m "feat(apply): add the Greenhouse application script" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 3: Lever

**Files:**
- Create: `packages/apply/src/sites/lever.ts`
- Create: `packages/apply/fixtures/lever/form/`, `rendered.html`, `closed.html`, `confirmation.synthetic.html`
- Modify: `packages/apply/src/sites/index.ts`, `packages/apply/src/sites/index.test.ts`
- Test: `packages/apply/src/sites/lever.test.ts`, `packages/apply/src/sites/lever.browser.test.ts`

**Interfaces:**
- Consumes: o contrato; os helpers de `sites/fixtures.ts` (Task 1); `matchOption`, `sameText`, `visibleCaptcha`, `visibleCodePrompt`, `leaveForm` (Task 2).
- Produces:

```ts
export interface LeverDeps { stepMs: number; parseMs: number; settleMs: number; submitMs: number }   // padrões 15_000, 20_000, 1_500, 30_000
export function leverTarget(job: ApplyJob): ApplyTarget | null;
export function createLeverSite(deps?: Partial<LeverDeps>): ApplySite;
export const leverSite: ApplySite;   // id 'lever', needsLogin false
```

Comportamento:

- `open`: navega, aplica a decisão 10. Página de "vaga não encontrada" (a de `closed.html`): `closed`. Senão espera o botão `Submit application` por `stepMs`; sem ele, `SiteLayoutError`.
- `readStep` lê o DOM, uma `Question` por campo ou grupo, na ordem da página. `kind`: `input` de texto, e-mail, telefone ou endereço → `text`; `textarea` → `longtext`; `<select>` e grupo de `radio` → `select`; grupo de `checkbox` → `multiselect`; `checkbox` sozinho → `boolean`; `input[type=file]` → `file`. `options` são os textos visíveis, sem a opção vazia de espera. `required` vem do atributo `required` ou da marca de obrigatório do rótulo; `maxLength`, do atributo `maxlength`. `isLast` é sempre `true`.
- `fillStep`, nesta ordem: (1) envia o currículo, se houver resposta de arquivo; (2) espera a leitura assentar, isto é, nenhum elemento **visível** do controle de envio com texto `/analyzing|analisando/i`, por até `parseMs`; estourou, `SiteLayoutError`; (3) preenche todos os campos e esvazia os de resposta `null`, porque o site pode tê-los preenchido sozinho; (4) espera `settleMs` e relê cada campo preenchido; o que estiver diferente é preenchido de novo, uma vez; se ainda diferir depois de outro `settleMs`, `SiteLayoutError`.
- "Current location" é campo de texto com sugestões, tratado como o campo de cidade do Greenhouse.
- `humanGate`, `next`, `submit`, `discard`, `sessionState`: como no Greenhouse.

- [ ] **Step 1: Write the failing unit tests.** `lever.test.ts`:
  ```ts
  const ID = '6ed76ce8-4156-4b60-b120-403538bd66cd';
  it.each([`https://jobs.lever.co/palantir/${ID}`, `https://jobs.lever.co/palantir/${ID}/`, `https://jobs.lever.co/palantir/${ID}/apply`, `https://jobs.lever.co/palantir/${ID}?lever-source=LinkedIn`])('recognises %s')
    expect(leverTarget(job({ source: 'lever', url, externalId: ID }))).toEqual({ site: 'lever', url: `https://jobs.lever.co/palantir/${ID}/apply`, ref: { company: 'palantir', postingId: ID } });
  it.each(['https://jobs.lever.co/palantir', `https://jobs.eu.lever.co/acme/${ID}`, `https://palantir.com/careers/${ID}`, 'não é url'])('does not recognise %s')
    expect(leverTarget(job({ source: 'lever', url, externalId: ID }))).toBeNull();
  ```
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/sites/lever.test.ts` — Expected: FAIL, `Cannot find module './lever'`.
- [ ] **Step 3: Implement `leverTarget` and run again.** Run: `pnpm test packages/apply/src/sites/lever.test.ts` — Expected: PASS.
- [ ] **Step 4: Record the fixtures.** Escolha, em uma empresa de `DEFAULT_LEVER_COMPANIES`, uma vaga cujo formulário tenha ao menos um cartão de pergunta própria com caixas de marcação ou lista. As páginas do Lever são públicas e podem não ter `main`, por isso `--keep body`.
  ```bash
  pnpm exec tsx packages/apply/scripts/record-fixture.ts replay   --url "https://jobs.lever.co/<empresa>/<id>/apply" --out packages/apply/fixtures/lever/form
  pnpm exec tsx packages/apply/scripts/record-fixture.ts snapshot --url "https://jobs.lever.co/<empresa>/<id>/apply" --keep body --out packages/apply/fixtures/lever/rendered.html
  pnpm exec tsx packages/apply/scripts/record-fixture.ts snapshot --url "https://jobs.lever.co/<empresa>/00000000-0000-0000-0000-000000000000/apply" --keep body --out packages/apply/fixtures/lever/closed.html
  ```
  Escreva à mão `confirmation.synthetic.html`: `<main><h3>Application submitted!</h3></main>`. Run: `pnpm test packages/apply/src/recording/clean.test.ts` — Expected: PASS.
- [ ] **Step 5: Write the failing browser tests.** `lever.browser.test.ts`. `formUrl` é a URL do documento em `replayRoutes('lever', 'form')` e `target`, o `leverTarget` dela; `RENDERED`, `CLOSED` e `DONE` (`formUrl` com `/thanks` no lugar de `/apply`) são rotas para os outros três arquivos. Os testes de leitura do currículo rodam sobre `rendered.html`, que não tem JavaScript; o comportamento do Lever é emulado por um helper do teste, `emulateAutoRead(page, opts: { analyzingMs: number; parsedName: string; lateMs?: number })`: ao receber o arquivo, mostra "Analyzing..." onde o Lever o mostra (ache o elemento em `fixtures/lever/form`) por `analyzingMs` e então escreve `parsedName` no campo "Full name"; com `lateMs`, escreve `parsedName` de novo, uma única vez, `lateMs` depois de o campo receber outro valor. `checkedLabels(page, q)` devolve os rótulos das caixas marcadas do grupo.
  ```ts
  const site = createLeverSite({ stepMs: 5_000, parseMs: 3_000, settleMs: 300, submitMs: 1_500 });
  const find = (qs: Question[], re: RegExp) => qs.find((q) => re.test(q.label))!;
  const resumeAnd = (qs: Question[], name: string | null) => [ans(find(qs, /resume|cv/i).id, 'cv.pdf'), ans(find(qs, /full name/i).id, name)];
  const fullName = () => page.getByLabel(/full name/i).inputValue();

  it('opens the form and reads standard fields and custom cards')   // questions e isLast de readStep, depois de open
    expect(await site.open(page, target)).toEqual({ kind: 'form' });
    expect(isLast).toBe(true);
    expect(find(questions, /full name/i)).toMatchObject({ kind: 'text', required: true });
    expect(find(questions, /email/i)).toMatchObject({ kind: 'text', required: true });
    expect(find(questions, /resume|cv/i)).toMatchObject({ kind: 'file' });
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    expect(questions.filter((q) => q.kind === 'select' || q.kind === 'multiselect').every((q) => q.options.length > 0 && !q.options.includes(''))).toBe(true);
  it('reports a posting that no longer exists as closed')
    expect(await site.open(page, { ...target, url: CLOSED })).toEqual({ kind: 'unavailable', reason: 'closed' });
  // Os quatro seguintes: em RENDERED, depois de readStep, chamam emulateAutoRead(page, opts) e então fillStep(page, resumeAnd(questions, nome), files).
  it('waits for the résumé auto-read to settle, then overwrites what it wrote')   // opts { analyzingMs: 500, parsedName: 'Nome Lido Do PDF' }, nome 'Ana Souza'
    expect(await fullName()).toBe('Ana Souza');
  it('refills a field the auto-read overwrites after the fill')   // Review Focus 2; opts { analyzingMs: 0, parsedName: 'Nome Lido Do PDF', lateMs: 100 }, nome 'Ana Souza'
    expect(await fullName()).toBe('Ana Souza');
  it('empties a field the auto-read filled when the answer is null')   // opts { analyzingMs: 0, parsedName: 'Nome Lido Do PDF' }, nome null
    expect(await fullName()).toBe('');
  it('stops with a layout error when the auto-read never settles')   // opts { analyzingMs: 60_000, parsedName: '' }
    await expect(createLeverSite({ parseMs: 400, settleMs: 50 }).fillStep(page, resumeAnd(questions, 'Ana Souza'), files)).rejects.toBeInstanceOf(SiteLayoutError);
  it('ticks exactly the chosen boxes of a custom card and refuses an option that is not offered')   // em RENDERED; multi = a primeira pergunta multiselect
    await site.fillStep(page, [ans(multi.id, [multi.options[0]])], files);
    expect(await checkedLabels(page, multi)).toEqual([multi.options[0]]);
    await expect(site.fillStep(page, [ans(multi.id, ['Opção que não existe'])], files)).rejects.toBeInstanceOf(SiteLayoutError);
  it('does not call a loaded hCaptcha a gate; only a challenge on screen is one')   // em RENDERED
    expect(await site.humanGate(page)).toBeNull();
    expect(await site.humanGate(page)).toBe('captcha');   // depois de inject(page, '<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" width="400" height="600" style="position:fixed;top:0;left:0"></iframe>')
  it('submits once, returns the confirmation, never advances, and discards without sending')   // watchClicks e linkSteps(page, [{ from: formUrl, button: /submit application/i, to: DONE }]) antes de open
    await expect(site.next(page)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(await site.submit(page)).toEqual({ confirmation: 'Application submitted!' });
    expect(await site.submit(page)).toEqual({ confirmation: 'Application submitted!' });
    expect(clicks).toHaveLength(1);
    expect(page.url()).toBe('about:blank');   // depois de site.discard(page)
  ```
  Se a vaga gravada só tiver lista e nenhuma caixa de marcação, o teste do cartão usa a lista e confere a opção escolhida.
- [ ] **Step 6: Run to see them fail.** Run: `pnpm test:browser packages/apply/src/sites/lever.browser.test.ts` — Expected: FAIL, `createLeverSite is not a function`.
- [ ] **Step 7: Implement `createLeverSite`.**
- [ ] **Step 8: Run to see them pass.** Run: `pnpm test:browser packages/apply/src/sites/lever.browser.test.ts` — Expected: PASS.
- [ ] **Step 9: Register the site.** Acrescente `leverSite` à lista de sites reais e `expect(applySites({}).map((s) => s.id)).toContain('lever')` a `sites/index.test.ts`. Run: `pnpm test packages/apply/src/sites && pnpm typecheck` — Expected: PASS.
- [ ] **Step 10: Commit.**
  ```bash
  git add packages/apply/src/sites packages/apply/fixtures/lever
  git commit -m "feat(apply): add the Lever application script" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 4: LinkedIn, parte 1: sessão de gravação do dono e fixtures limpas

Os passos marcados "(dono)" só o dono executa, no computador dele, com a conta dele. Ninguém mais abre a sessão.

**Files:**
- Create: `packages/apply/fixtures/linkedin/*.html` (lista abaixo)
- Test: `packages/apply/src/recording/linkedin-fixtures.test.ts`

**Interfaces:**
- Consumes: da Task 1, o gravador (modos `profile`, `scrub`, `snapshot`) e `fixturePath`.
- Produces: os arquivos abaixo, cada um um `snapshot` de um estado. A Task 5 testa contra estes nomes.

| Arquivo | Estado | Quem grava |
|---|---|---|
| `job.html` | página de uma vaga com o botão "Candidatura simplificada", modal fechado | dono |
| `easy-apply-contact.html`, `easy-apply-resume.html`, `easy-apply-review.html` | as etapas de contato, currículo e revisão do modal **dessa mesma vaga**; a revisão mostra a caixa de seguir a empresa e o botão "Enviar candidatura" | dono |
| `easy-apply-questions.html` | etapa de perguntas adicionais, de uma vaga que tenha lista ou opções e um campo numérico | dono |
| `discard-dialog.html` | o aviso de salvar ou descartar, depois de clicar no X do modal | dono |
| `no-easy-apply.html` | vaga sem o botão, que leva ao site da empresa | dono |
| `already-applied.html` | vaga a que o dono já se candidatou | dono |
| `closed.html`, `checkpoint.html` | vaga que não aceita mais candidaturas; página de verificação de conta. Opcionais: só se aparecerem | dono |
| `login.html`, `job-guest.html` | `https://www.linkedin.com/login` e a página pública de uma vaga, sem sessão | quem implementa |
| `checkpoint.synthetic.html`, `easy-apply-sent.synthetic.html` | escritos à mão quando o real não existe | quem implementa |

- [ ] **Step 1: Write the failing test.** `linkedin-fixtures.test.ts`; `has(n)` diz se `<n>.html` existe em `fixtures/linkedin`, `read(n)` o lê, `all` é todo `.html` da pasta:
  ```ts
  const REQUIRED = ['job', 'easy-apply-contact', 'easy-apply-resume', 'easy-apply-questions', 'easy-apply-review', 'discard-dialog', 'no-easy-apply', 'already-applied', 'login', 'job-guest'];
  it('has every LinkedIn state the script is tested against')
    expect(REQUIRED.filter((n) => !has(n))).toEqual([]);
    expect(has('checkpoint') || has('checkpoint.synthetic')).toBe(true);
    expect(has('easy-apply-sent') || has('easy-apply-sent.synthetic')).toBe(true);
  it.each(all)('%s is a pruned snapshot: no script, no data blob, no page chrome')
    expect(readFileSync(file, 'utf8')).not.toMatch(/<script|<code|<iframe|<nav|<header|<aside|<footer/i);
  it('the modal fixtures hold a dialog and the page fixtures do not')
    for (const n of ['easy-apply-contact', 'easy-apply-resume', 'easy-apply-questions', 'easy-apply-review', 'discard-dialog']) expect(read(n)).toContain('role="dialog"');
    for (const n of ['job', 'no-easy-apply', 'already-applied']) expect(read(n)).not.toContain('role="dialog"');
  ```
- [ ] **Step 2: Run to see it fail.** Run: `pnpm test packages/apply/src/recording/linkedin-fixtures.test.ts` — Expected: FAIL, com a lista dos dez nomes que faltam.
- [ ] **Step 3 (dono): preparar a identidade, fora do repositório.** Crie `%LOCALAPPDATA%\kanban-vagas\fixture-identity.json`, no formato de `ScrubIdentity`. Em `names`, todas as formas do seu nome (completo, só o primeiro, só os sobrenomes, sem acento); em `emails` e `phones`, todos os seus (telefone só com dígitos); em `extra`, cidade, endereço e o que mais identificar você.
- [ ] **Step 4 (dono): gravar.** Run: `pnpm exec tsx packages/apply/scripts/record-fixture.ts profile --staging "%LOCALAPPDATA%\kanban-vagas\fixture-staging"`. Na janela que abrir, faça login no LinkedIn, se pedir. Abra cada estado da tabela e, com ele na tela, digite o nome do arquivo (sem `.html`) no terminal e tecle Enter. Para as etapas do modal, clique em "Candidatura simplificada" e avance uma etapa de cada vez. **Não clique em "Enviar candidatura"**: o gravador barra esse clique, mas não conte com isso. No fim, feche o modal pelo X, grave `discard-dialog` e clique em "Descartar". Linha vazia encerra.
- [ ] **Step 5 (dono): limpar e revisar.** Run: `pnpm exec tsx packages/apply/scripts/record-fixture.ts scrub --from "%LOCALAPPDATA%\kanban-vagas\fixture-staging" --to packages/apply/fixtures/linkedin --identity "%LOCALAPPDATA%\kanban-vagas\fixture-identity.json"`. Abra cada arquivo de `packages/apply/fixtures/linkedin` no navegador **e** no editor e procure: partes do seu nome, e-mail, telefone, cidade, empresa atual, nome ou foto de qualquer outra pessoa (recrutador, conexão, "quem contrata"). O que achar entra em `names` ou `extra`, e o comando de limpeza roda de novo; repita até não achar nada. Depois apague a pasta `fixture-staging`.
- [ ] **Step 6: Record the public states and write the synthetic ones.**
  ```bash
  pnpm exec tsx packages/apply/scripts/record-fixture.ts snapshot --url "https://www.linkedin.com/login" --out packages/apply/fixtures/linkedin/login.html
  pnpm exec tsx packages/apply/scripts/record-fixture.ts snapshot --url "https://www.linkedin.com/jobs/view/<id>/" --out packages/apply/fixtures/linkedin/job-guest.html
  ```
  Se uma dessas páginas não tiver `main`, passe `--keep` com o contêiner do conteúdo. Sem `checkpoint.html` real, escreva `checkpoint.synthetic.html`: `<main><h1>Vamos fazer uma verificação rápida de segurança</h1></main>`. Sem confirmação real, escreva `easy-apply-sent.synthetic.html`: `<main></main><div role="dialog"><h2>Candidatura enviada</h2><p>Sua candidatura foi enviada.</p></div>`.
- [ ] **Step 7: Run to see it pass.** Run: `pnpm test packages/apply/src/recording` — Expected: PASS: o conjunto está completo e o varredor de vazamento passa em todos os arquivos de `fixtures/linkedin`.
- [ ] **Step 8: Commit.** Antes, confira que `git status` não lista nada de `fixture-staging` nem o `fixture-identity.json`.
  ```bash
  git add packages/apply/fixtures/linkedin packages/apply/src/recording/linkedin-fixtures.test.ts
  git commit -m "test(apply): add scrubbed LinkedIn Easy Apply fixtures" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 5: LinkedIn, parte 2: o roteiro

**Files:**
- Create: `packages/apply/src/sites/linkedin.ts`
- Modify: `packages/apply/src/sites/index.ts`, `packages/apply/src/sites/index.test.ts`
- Test: `packages/apply/src/sites/linkedin.test.ts`, `packages/apply/src/sites/linkedin.browser.test.ts`

**Interfaces:**
- Consumes: o contrato; as fixtures da Task 4; os helpers de `sites/fixtures.ts` (Task 1); `matchOption`, `visibleCaptcha` (Task 2).
- Produces:

```ts
export type LinkedinTextKey = 'easyApply' | 'next' | 'review' | 'submit' | 'follow' | 'dismiss' | 'discard' | 'applied' | 'closed' | 'sent' | 'signIn' | 'unusual';
export const LINKEDIN_TEXT: Record<LinkedinTextKey, RegExp>;
export interface LinkedinDeps { stepMs: number; submitMs: number }   // padrões 15_000 e 30_000
export function linkedinTarget(job: ApplyJob): ApplyTarget | null;
export function createLinkedinSite(deps?: Partial<LinkedinDeps>): ApplySite;
export const linkedinSite: ApplySite;   // id 'linkedin', needsLogin true, loginUrl 'https://www.linkedin.com/login'
```

`LINKEDIN_TEXT` começa com estes textos, sem diferenciar caixa. O LinkedIn logado não foi verificado: onde a fixture mostrar outro texto, corrija a tabela e mantenha as duas línguas.

| Chave | pt-BR | en |
|---|---|---|
| `easyApply` | Candidatura simplificada | Easy Apply |
| `next` / `review` | Avançar, Continuar / Revisar | Next, Continue / Review |
| `submit` | Enviar candidatura | Submit application |
| `follow` | Seguir, Siga | Follow |
| `dismiss` / `discard` | Fechar, Dispensar / Descartar | Dismiss, Close / Discard |
| `applied` | Candidatou-se, Candidatura enviada | Applied, Application submitted |
| `closed` | Não aceita mais candidaturas | No longer accepting applications |
| `sent` | Candidatura enviada, Sua candidatura foi enviada | Application sent, Your application was sent |
| `signIn` | Entrar, Cadastre-se agora | Sign in, Join now |
| `unusual` | atividade incomum, verificação de segurança, conta restrita | unusual activity, security check, security verification, account restricted |

Comportamento:

- `humanGate` devolve só `null`, `login` ou `restricted`. `restricted`, conferido primeiro: caminho começando por `/checkpoint/`, captcha na tela (`visibleCaptcha`) ou texto `unusual` visível. `login`: caminho começando por `/login`, `/uas/login` ou `/authwall`, ou um botão ou link `signIn` visível (a página pública de quem não tem sessão).
- `sessionState`: se a página não está em `linkedin.com`, navega para `https://www.linkedin.com/feed/`; devolve `'logged_out'` quando `humanGate` daria `login`, senão `'logged_in'`.
- `open` faz no máximo uma navegação, e nenhuma se a página já está em `target.url`. Depois, nesta ordem: portão (decisão 10); texto `applied` fora de modal → `already_applied`; texto `closed` → `closed`; botão `easyApply` → clica e espera o `[role="dialog"]` por `stepMs`; sem o botão → `external`. Nunca segue o link de candidatura externa nem abre outra aba.
- `readDescription` devolve o texto do bloco de descrição da vaga, sem os rótulos de "ver mais", com o modal aberto ou fechado; `null` se a página não o tem.
- `readStep` lê só dentro do modal. `kind`: `input` de texto → `text` (`number` quando `type="number"` ou `inputmode` numérico); `textarea` → `longtext`; `<select>` e `fieldset` de `radio` → `select`; `fieldset` de `checkbox` → `multiselect`; `checkbox` sozinho → `boolean`; envio de arquivo → `file`. A caixa de seguir a empresa **não** é pergunta. `isLast` é verdadeiro quando o botão principal da etapa é `submit`.
- `fillStep` preenche e, em qualquer etapa, desmarca a caixa `follow` se estiver marcada.
- `next` clica no botão `next` ou `review` e espera a etapa mudar (título, progresso ou conjunto de perguntas) por `stepMs`. Erro de campo visível depois do clique, ou etapa que não muda: `SiteLayoutError`. Em etapa com `isLast`, lança `SiteLayoutError` sem clicar.
- `submit` (decisão 11) desmarca `follow`, clica em `submit` e espera um diálogo com texto `sent`.
- `discard`: clica em `dismiss` no modal; se aparecer o aviso de rascunho, clica em `discard`, nunca em salvar. Termina sem modal de candidatura na tela, senão `SiteLayoutError`. Sem modal aberto, não faz nada.

- [ ] **Step 1: Write the failing unit tests.** `linkedin.test.ts`:
  ```ts
  it.each([
    ['https://br.linkedin.com/jobs/view/desenvolvedor-a-front-end-at-nelogica-4485826717', '4485826717'],   // Review Focus 1
    ['https://br.linkedin.com/jobs/view/senior-react-engineer-remote-work-ref%23309388-at-bairesdev-4489662428', '4489662428'],
    ['https://www.linkedin.com/jobs/view/4485826717/', '4485826717'],
    ['https://www.linkedin.com/jobs/view/4485826717?trk=public_jobs', '4485826717'],
  ])('recognises %s')   // (url, id)
    expect(linkedinTarget(job({ source: 'linkedin', url, externalId: id }))).toEqual({ site: 'linkedin', url: `https://www.linkedin.com/jobs/view/${id}/`, ref: { jobId: id } });
  it.each([
    'https://www.linkedin.com/company/acme/jobs/', 'https://www.linkedin.com/jobs/search/?currentJobId=4485826717', 'https://www.linkedin.com/jobs/view/sem-numero',
    'https://linkedin.com.exemplo.io/jobs/view/4485826717', 'https://exemplolinkedin.com/jobs/view/4485826717',
  ])('does not recognise %s')
    expect(linkedinTarget(job({ source: 'linkedin', url, externalId: '4485826717' }))).toBeNull();
  it('has every text in Portuguese and in English, and never confuses advancing with sending')
    for (const s of ['Candidatura simplificada', 'Easy Apply']) expect(LINKEDIN_TEXT.easyApply.test(s)).toBe(true);
    for (const s of ['Enviar candidatura', 'Submit application']) expect([LINKEDIN_TEXT.submit.test(s), LINKEDIN_TEXT.next.test(s), LINKEDIN_TEXT.review.test(s)]).toEqual([true, false, false]);
  ```
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/sites/linkedin.test.ts` — Expected: FAIL, `Cannot find module './linkedin'`.
- [ ] **Step 3: Implement `linkedinTarget` and `LINKEDIN_TEXT`, and run again.** Run: `pnpm test packages/apply/src/sites/linkedin.test.ts` — Expected: PASS.
- [ ] **Step 4: Write the failing browser tests.** `linkedin.browser.test.ts`. Cada fixture é servida em um endereço: `JOB = 'https://www.linkedin.com/jobs/view/4000000001/'` → `job.html`; `at(n) = JOB + n + '/'` para as etapas do modal, `discard-dialog` e a confirmação (`at('sent')`); `.../4000000002/` → `no-easy-apply.html`; `.../4000000003/` → `already-applied.html`; `.../4000000004/` → `job-guest.html`; `LOGIN = 'https://www.linkedin.com/login'` → `login.html`; `CHECK = 'https://www.linkedin.com/checkpoint/challenge/x'` → a fixture de verificação. `FLOW` liga os estados com `linkSteps`: em `JOB`, `easyApply` → contato; em cada etapa, `next` ou `review` → a seguinte (contato, currículo, revisão); na revisão, `submit` → `at('sent')` e `dismiss` → `at('discard-dialog')`; no aviso, `discard` → `JOB`. `targetOf(id)` é o `linkedinTarget` de uma vaga com esse id. Helpers do teste: `chosen(page, q)`, a opção marcada da pergunta; `followAtSubmit(page)`, que devolve uma função dizendo se a caixa de seguir estava marcada no instante do clique de envio. `clicks` é sempre `await watchClicks(page)`, pedido antes de qualquer navegação. Ao escrever o roteiro, derive cada seletor dos arquivos de `fixtures/linkedin`: papel e texto visível primeiro, classe CSS só quando não houver outro jeito.
  ```ts
  const site = createLinkedinSite({ stepMs: 3_000, submitMs: 1_500 });

  it('tells a live session from a logged-out page')
    expect(await site.sessionState(page)).toBe('logged_in');    // em JOB
    expect(await site.sessionState(page)).toBe('logged_out');   // em LOGIN
    expect(await site.humanGate(page)).toBe('login');
  it('opens the Easy Apply modal with one click')   // com FLOW
    expect(await site.open(page, targetOf('4000000001'))).toEqual({ kind: 'form' });
    expect(clicks).toEqual([expect.stringMatching(LINKEDIN_TEXT.easyApply)]);
    expect(await page.locator('[role="dialog"]').count()).toBeGreaterThan(0);
  it('reports a job without Easy Apply as external and follows no link')
    expect(await site.open(page, targetOf('4000000002'))).toEqual({ kind: 'unavailable', reason: 'external' });
    expect(clicks).toEqual([]);
    expect(page.url()).toBe('https://www.linkedin.com/jobs/view/4000000002/');
  it('reports an applied job as already_applied even when the Easy Apply button is still there')   // Review Focus 4; antes: abre .../4000000003/ e inject(page, '<button>Candidatura simplificada</button>')
    expect(await site.open(page, targetOf('4000000003'))).toEqual({ kind: 'unavailable', reason: 'already_applied' });
    expect(clicks).toEqual([]);
  it('treats the public page of an expired session as a login gate, never as external')   // Review Focus 4
    expect(await site.open(page, targetOf('4000000004'))).toEqual({ kind: 'form' });
    expect(await site.humanGate(page)).toBe('login');
  it('reports a checkpoint or an unusual-activity notice as restricted and touches nothing')
    expect(await site.humanGate(page)).toBe('restricted');   // em CHECK
    expect(await site.humanGate(page)).toBeNull();           // em JOB
    expect(await site.humanGate(page)).toBe('restricted');   // em JOB, depois de inject(page, '<h2>We noticed unusual activity from your account</h2>')
    expect(clicks).toEqual([]);
  it('reads the description with the modal closed or open')   // text = await site.readDescription!(page), em JOB e em at('easy-apply-contact')
    expect(text!.length).toBeGreaterThan(200);
    expect(text).not.toMatch(/<\w+[^>]*>/);
    expect(await site.readDescription!(page)).toBeNull();    // em LOGIN
  it('reads each step of the modal')   // contact, resume, extra, review = readStep em at('easy-apply-…') de cada uma
    expect(contact.isLast).toBe(false);
    expect(contact.questions.some((q) => /e-?mail/i.test(q.label))).toBe(true);
    expect(resume.questions.filter((q) => q.kind === 'file')).toHaveLength(1);
    expect(new Set(extra.questions.map((q) => q.id)).size).toBe(extra.questions.length);
    expect(extra.questions.some((q) => q.kind === 'select' && q.options.length > 1)).toBe(true);
    expect(extra.questions.some((q) => q.kind === 'number')).toBe(true);
    expect(review.isLast).toBe(true);
    expect(review.questions.some((q) => LINKEDIN_TEXT.follow.test(q.label))).toBe(false);
  it('fills a step and refuses an option that is not offered')   // em at('easy-apply-questions'); list e num = a primeira pergunta select e a primeira number
    await site.fillStep(page, [ans(list.id, list.options[1]), ans(num.id, '7')], files);
    expect(await chosen(page, list)).toBe(list.options[1]);
    expect(await page.locator(`[id="${num.id}"]`).inputValue()).toBe('7');
    await expect(site.fillStep(page, [ans(list.id, 'Opção que não existe')], files)).rejects.toBeInstanceOf(SiteLayoutError);
  it('advances with the next button only, and refuses to advance on the last step')   // com FLOW
    expect(clicks).toEqual([expect.stringMatching(LINKEDIN_TEXT.next)]);   // depois de site.next(page) em at('easy-apply-contact')
    await expect(site.next(page)).rejects.toBeInstanceOf(SiteLayoutError);   // em at('easy-apply-review')
    expect(clicks).toHaveLength(1);
  it('walks a résumé-and-contact application to the review step without sending')   // critério de aceite 1, até o envio; com FLOW
    // open; enquanto !isLast: readStep, fillStep só com ans(id, 'cv.pdf') para as perguntas file, next
    expect((await site.readStep(page)).isLast).toBe(true);
    expect(clicks.some((c) => LINKEDIN_TEXT.submit.test(c))).toBe(false);
  it('rejects the submission when no confirmation shows up')   // em at('easy-apply-review'), sem FLOW: o clique não leva a lugar nenhum
    await expect(site.submit(page)).rejects.toBeInstanceOf(SubmitRejectedError);
  it('unticks follow before sending and returns the confirmation')   // com FLOW, em at('easy-apply-review'); ticked = await followAtSubmit(page)
    expect((await site.submit(page)).confirmation).toMatch(LINKEDIN_TEXT.sent);
    expect(ticked()).toBe(false);
    expect(clicks.filter((c) => LINKEDIN_TEXT.submit.test(c))).toHaveLength(1);
  it('discards the draft and never saves it')   // com FLOW, em at('easy-apply-review'), depois de site.discard(page)
    expect(clicks).toEqual([expect.stringMatching(LINKEDIN_TEXT.dismiss), expect.stringMatching(LINKEDIN_TEXT.discard)]);
    expect(await page.locator('[role="dialog"]').count()).toBe(0);
  it('recognises the English interface')   // com FLOW, em JOB, depois de trocar o texto do botão "Candidatura simplificada" por "Easy Apply"
    expect(await site.open(page, targetOf('4000000001'))).toEqual({ kind: 'form' });
  ```
  Se `closed.html` existir, acrescente o teste de `open` devolvendo `closed`; senão, `it.skipIf` com o motivo.
- [ ] **Step 5: Run to see them fail.** Run: `pnpm test:browser packages/apply/src/sites/linkedin.browser.test.ts` — Expected: FAIL, `createLinkedinSite is not a function`.
- [ ] **Step 6: Implement `createLinkedinSite`.**
- [ ] **Step 7: Run to see them pass.** Run: `pnpm test:browser packages/apply/src/sites/linkedin.browser.test.ts` — Expected: PASS.
- [ ] **Step 8: Register the site.** Acrescente `linkedinSite` à lista de sites reais e `expect(applySites({}).map((s) => s.id)).toContain('linkedin')` a `sites/index.test.ts`. Run: `pnpm test packages/apply/src/sites && pnpm typecheck` — Expected: PASS.
- [ ] **Step 9: Commit.**
  ```bash
  git add packages/apply/src/sites
  git commit -m "feat(apply): add the LinkedIn Easy Apply script" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 6: Os três juntos: conferência cruzada e textos da tela de Configurações

**Files:**
- Create: `apps/web/src/lib/applySites.ts`
- Modify: `packages/apply/src/sites/index.ts` (ordem da lista), `apps/web/src/components/SettingsApplySection.tsx`
- Test: `packages/apply/src/sites/index.test.ts`, `apps/web/src/lib/applySites.test.ts`

**Interfaces:**
- Consumes: `applySites`, `siteFor` (plano base); os três sites (Tasks 2, 3 e 5); `job` (Task 1).
- Produces:

```ts
// apps/web/src/lib/applySites.ts (sem imports: vai para o navegador)
export interface ApplySiteCopy { label: string; login: string; how: string; warning: string | null }
export const APPLY_SITE_COPY: Record<'linkedin' | 'greenhouse' | 'lever', ApplySiteCopy>;
export function applySiteCopy(id: string): ApplySiteCopy;   // id sem texto (o site de teste): { label: id, login: '', how: '', warning: null }
```

Texto exato:

| id | `label` | `login` | `how` | `warning` |
|---|---|---|---|---|
| `linkedin` | LinkedIn | Precisa de login | Só vagas com "Candidatura simplificada". As outras são puladas. | O LinkedIn proíbe automação nos termos de uso e pode restringir a sua conta. O risco é seu. |
| `greenhouse` | Greenhouse | Sem login | Formulário público da vaga. Perguntas demográficas opcionais ficam em branco. | O formulário pode pedir captcha: a janela abre e espera você resolver. |
| `lever` | Lever | Sem login | Formulário público da vaga. O Lever lê o currículo e preenche campos; a IA sobrescreve com os dados do seu perfil. | O formulário pode pedir captcha: a janela abre e espera você resolver. No ensaio, o arquivo do currículo chega ao Lever, mas a candidatura não é enviada. |

- [ ] **Step 1: Write the failing tests.** Em `packages/apply/src/sites/index.test.ts`:
  ```ts
  it('registers the three real sites in the order of the spec table, and none of them when FAKE_APPLY_SITE=1')
    expect(applySites({}).map((s) => s.id)).toEqual(['linkedin', 'greenhouse', 'lever']);
    expect(applySites({ FAKE_APPLY_SITE: '1' }).filter((s) => ['linkedin', 'greenhouse', 'lever'].includes(s.id))).toEqual([]);
  it.each([
    ['greenhouse', 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002', 'gitlab-8638232002', 'greenhouse'],
    ['greenhouse', 'https://stripe.com/jobs/search?gh_jid=7001234', 'stripe-7001234', 'greenhouse'],
    ['lever', 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd', '6ed76ce8-4156-4b60-b120-403538bd66cd', 'lever'],
    ['linkedin', 'https://br.linkedin.com/jobs/view/desenvolvedor-a-front-end-at-nelogica-4485826717', '4485826717', 'linkedin'],
    ['gupy', 'https://acme.gupy.io/jobs/123', '123', null],
    ['indeed', 'https://br.indeed.com/viewjob?jk=abc', 'abc', null],
    ['remotive', 'https://remotive.com/remote-jobs/software-dev/x-123', '123', null],
  ])('%s %s is claimed by at most one site')   // (source, url, externalId, expected); j = job({ source, url, externalId })
    expect(applySites({}).filter((s) => s.match(j) !== null).map((s) => s.id)).toEqual(expected ? [expected] : []);
    expect(siteFor(j, applySites({}))?.site.id ?? null).toBe(expected);
  it('only LinkedIn needs login, and it says where the owner logs in')
    expect(applySites({}).map((s) => [s.id, s.needsLogin, s.loginUrl])).toEqual([['linkedin', true, 'https://www.linkedin.com/login'], ['greenhouse', false, undefined], ['lever', false, undefined]]);
  ```
  `apps/web/src/lib/applySites.test.ts`:
  ```ts
  it('has copy for the three real sites and only them')
    expect(Object.keys(APPLY_SITE_COPY).sort()).toEqual(['greenhouse', 'lever', 'linkedin']);
  it('warns about the LinkedIn terms of use and about the résumé reaching Lever in rehearsal')
    expect(APPLY_SITE_COPY.linkedin.warning).toContain('proíbe automação');
    expect(APPLY_SITE_COPY.lever.warning).toContain('No ensaio');
  it('falls back to the id for a site without copy')
    expect(applySiteCopy('fake')).toEqual({ label: 'fake', login: '', how: '', warning: null });
  ```
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/sites/index.test.ts apps/web/src/lib/applySites.test.ts` — Expected: FAIL: a ordem da lista difere e `./applySites` não existe.
- [ ] **Step 3: Implement.** Ordene a lista de sites reais como `linkedin`, `greenhouse`, `lever`. Crie `apps/web/src/lib/applySites.ts` com a tabela acima. Em `SettingsApplySection.tsx`, cada linha de site passa a mostrar `applySiteCopy(id).label` como nome, `login` ao lado, `how` como texto de apoio e `warning`, quando houver, no estilo de aviso que a seção já usa.
- [ ] **Step 4: Run to see them pass.** Run: `pnpm test packages/apply/src/sites/index.test.ts apps/web/src/lib/applySites.test.ts && pnpm typecheck` — Expected: PASS e typecheck limpo.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/apply/src/sites/index.ts packages/apply/src/sites/index.test.ts apps/web/src/lib/applySites.ts apps/web/src/lib/applySites.test.ts apps/web/src/components/SettingsApplySection.tsx
  git commit -m "feat(apply): show the three application sites in settings" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

### Task 7: `pnpm apply:smoke` e README

**Files:**
- Create: `packages/apply/src/smoke.ts`, `scripts/apply-smoke.ts`
- Modify: `package.json` (raiz), `README.md`
- Test: `packages/apply/src/smoke.test.ts`

**Interfaces:**
- Consumes: `greenhouseSite`, `leverSite`, `linkedinSite`, importados direto (sem `applySites()`, para `FAKE_APPLY_SITE` não trocar o site). Do plano base, só em `scripts/apply-smoke.ts`: a abertura do perfil persistente com janela (`browser.ts`), a pasta de dados (`data-dir.ts`), o resolvedor (`answers/resolve.ts`) e o currículo no modo `base` (`apps/worker/src/apply/resume.ts`). As assinaturas dessas quatro peças estão nos blocos Interfaces das tasks do plano base que criam esses arquivos; se alguma não existir com esse papel, pare e avise em vez de escrever uma segunda versão aqui.
- Produces:

```ts
// packages/apply/src/smoke.ts
export interface SmokeArgs { site: 'linkedin' | 'greenhouse' | 'lever'; url: string; resumePath: string | null }
export function parseSmokeArgs(argv: string[], env: NodeJS.ProcessEnv): SmokeArgs | { error: string };
export function smokeShotPath(dataDir: string, site: string, now: Date): string;   // <dataDir>/smoke/<site>-AAAAMMDD-HHmmss.png
export function assertOutsideRepo(path: string, repoRoot: string): void;           // lança se o caminho fica dentro do repositório
export interface SmokeDeps {
  site: ApplySite; job: ApplyJob; page: Page;
  resolve(questions: Question[]): Promise<ResolvedAnswer[]>;
  resumePath: string; shotPath: string; print(line: string): void;
}
export interface SmokeReport { outcome: 'filled' | 'pending' | 'unavailable' | 'gate'; detail: string; steps: number; shotPath: string | null }
export function runSmoke(deps: SmokeDeps): Promise<SmokeReport>;
```

`runSmoke`: `match`; `open` (indisponível: imprime o motivo e termina); então, por no máximo 12 etapas: `humanGate` (portão: imprime, fotografa e termina com `gate`), `readStep`, imprime cada pergunta (rótulo, tipo, obrigatória, número de opções), `resolve`, imprime cada resposta (valor e origem; obrigatória sem resposta sai como `SEM RESPOSTA`), `fillStep`, e `next` se não for a última. No fim fotografa a página inteira em `shotPath`. `outcome` é `pending` se alguma obrigatória ficou sem resposta, senão `filled`. `discard` roda sempre, inclusive depois de erro. O módulo não chama o método de envio do site em nenhum caminho.

`parseSmokeArgs` aceita só `--site`, `--job` e `--resume` (e ignora um `--` solto, que o pnpm repassa). Com `CI` definida, ou com qualquer outro argumento, devolve `error`.

- [ ] **Step 1: Write the failing tests.** `smoke.test.ts`. `stubSite(steps, opts?: { gate?: HumanGate })` é um `ApplySite` de `vi.fn()` que devolve as etapas em sequência; `page` é `{ screenshot: vi.fn() }` convertido para `Page`; `name` e `visa` são perguntas obrigatórias; `deps` é um `SmokeDeps` completo cujo `resolve` responde `'Ana Souza'` a `name` e `null` ao resto, e cujo `print` acumula em `lines`.
  ```ts
  const ok = ['--site', 'lever', '--job', 'https://jobs.lever.co/acme/6ed76ce8-4156-4b60-b120-403538bd66cd'];
  it('parses the two required flags and the optional résumé')
    expect(parseSmokeArgs(['--', ...ok], {})).toEqual({ site: 'lever', url: ok[3], resumePath: null });
    expect(parseSmokeArgs([...ok, '--resume', 'C:/cv.pdf'], {})).toMatchObject({ resumePath: 'C:/cv.pdf' });
  it('refuses to run under CI')
    expect(parseSmokeArgs(ok, { CI: 'true' })).toEqual({ error: expect.stringContaining('CI') });
  it.each(['--submit', '--send', '--real', '--enviar', '--yes', '--mode=real'])('has no flag that submits: %s is an error')
    expect(parseSmokeArgs([...ok, flag], {})).toHaveProperty('error');
  it('rejects an unknown site and a missing job')
    expect(parseSmokeArgs(['--site', 'gupy', '--job', 'https://x.y'], {})).toHaveProperty('error');
    expect(parseSmokeArgs(['--site', 'lever'], {})).toHaveProperty('error');
  it('names the screenshot by site and time, and refuses a path inside the repository')
    expect(smokeShotPath('C:/dados', 'lever', new Date(2026, 10, 12, 10, 30, 5))).toBe(join('C:/dados', 'smoke', 'lever-20261112-103005.png'));
    expect(() => assertOutsideRepo(join(repoRoot, 'tmp', 'a.png'), repoRoot)).toThrow(/fora do repositório/);
    expect(() => assertOutsideRepo(join(repoRoot, '..', 'fora', 'a.png'), repoRoot)).not.toThrow();
  it('fills every step, prints questions and answers, shoots, discards and never submits')   // site = stubSite([{ questions: [name], isLast: false }, { questions: [visa], isLast: true }])
    expect(await runSmoke({ ...deps, site, shotPath: 'out.png' })).toMatchObject({ outcome: 'pending', steps: 2, shotPath: 'out.png' });
    expect([site.fillStep, site.next, site.discard, site.submit].map((f) => vi.mocked(f).mock.calls.length)).toEqual([2, 1, 1, 0]);
    for (const shown of [name.label, 'Ana Souza', 'SEM RESPOSTA']) expect(lines.join('\n')).toContain(shown);
  it('stops at a human gate without reading or filling')   // site = stubSite([{ questions: [name], isLast: true }], { gate: 'captcha' })
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'gate', detail: 'captcha' });
    expect([site.readStep, site.discard].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 1]);
  it('discards even when a step throws')   // site.fillStep rejeita com new SiteLayoutError('x')
    await expect(runSmoke({ ...deps, site })).rejects.toBeInstanceOf(SiteLayoutError);
    expect(site.discard).toHaveBeenCalledTimes(1);
  it('has no code path that submits')
    for (const file of ['packages/apply/src/smoke.ts', 'scripts/apply-smoke.ts']) expect(readFileSync(join(repoRoot, file), 'utf8')).not.toMatch(/\.submit\s*\(/);
  ```
- [ ] **Step 2: Run to see them fail.** Run: `pnpm test packages/apply/src/smoke.test.ts` — Expected: FAIL, `Cannot find module './smoke'`.
- [ ] **Step 3: Implement `packages/apply/src/smoke.ts` and `scripts/apply-smoke.ts`.** O script segue `scripts/ai-smoke.ts`: `parseSmokeArgs` vem antes de qualquer outra coisa (com `error`, nada é lido nem aberto); depois carrega o `.env`, calcula `shotPath` com `smokeShotPath` e a pasta de dados, chama `assertOutsideRepo`, abre o perfil persistente com janela, monta `resolve` com o resolvedor do plano base (perfil do dono, banco de respostas e provedor configurados como no worker), usa `--resume` ou gera o currículo `base`, chama `runSmoke`, imprime o relatório e o caminho da foto, e fecha o navegador. Código de saída 0 para `filled` e `pending`, 1 para o resto. Em `package.json`: `"apply:smoke": "tsx scripts/apply-smoke.ts"`.
- [ ] **Step 4: Run to see them pass.** Run: `pnpm test packages/apply/src/smoke.test.ts && pnpm typecheck` — Expected: PASS e typecheck limpo. Run (PowerShell): `$env:CI='1'; pnpm apply:smoke -- --site lever --job https://jobs.lever.co/a/b; $env:CI=$null` — Expected: a mensagem de recusa e código de saída 1, sem abrir navegador.
- [ ] **Step 5: Write the README section.** Dentro de `## Candidatura automática` (crie a seção se o plano base ainda não a criou):
  - `### Sites suportados`: a tabela "Sites" do spec (login, como o app acha o formulário, observações); a regra de reconhecimento da decisão 1, uma frase por site, dizendo que vaga do Greenhouse em domínio da empresa sem `gh_jid` não é suportada; captcha é detectado e nunca resolvido, a janela espera o dono; no ensaio, o Lever recebe o arquivo do currículo; o LinkedIn proíbe automação e o risco é do dono; cada candidatura no LinkedIn envia um PDF novo, que fica na lista de currículos recentes da conta.
  - `### Conferir um site de verdade`: o comando `pnpm apply:smoke -- --site <linkedin|greenhouse|lever> --job <url> [--resume <pdf>]`; ele sempre roda em ensaio, não tem opção de envio, recusa rodar na CI, imprime perguntas e respostas e grava a foto em `<pasta de dados>/smoke/`.
  - `### Quando um site muda de layout`: a candidatura para em "formulário não reconhecido", com a foto; regrava-se a fixture com `packages/apply/scripts/record-fixture.ts` (no LinkedIn, o dono repete a gravação e a limpeza), corrige-se o roteiro, e `pnpm test:browser` volta a passar.
  - Em "Desenvolvimento", a linha `pnpm apply:smoke -- --site <id> --job <url>   # ATENÇÃO: abre um formulário real, em ensaio; nunca envia`.
- [ ] **Step 6: Commit.**
  ```bash
  git add packages/apply/src/smoke.ts packages/apply/src/smoke.test.ts scripts/apply-smoke.ts package.json README.md
  git commit -m "feat(apply): add the apply:smoke rehearsal command and document the sites" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
  ```

---

## Depois deste plano

- **Confirmar as hipóteses no primeiro uso real.** O primeiro envio de cada site guarda a foto e o texto da confirmação: troque `confirmation.synthetic.html`, `easy-apply-sent.synthetic.html` e `checkpoint.synthetic.html` pelas páginas reais, limpas, e corrija os sinais da decisão 14 se diferirem.
- **Fora deste plano, por decisão:** `jobs.eu.lever.co`; vaga do Greenhouse em domínio da empresa sem `gh_jid`; seguir o link externo do LinkedIn; qualquer site além dos três (sub-projeto 6).
- **Não vira teste:** a frequência com que o captcha barra o envio (o spec diz que só o uso real mostra) e as sugestões de cidade do Lever e do Greenhouse, que dependem de rede. As duas são conferidas com `pnpm apply:smoke`.

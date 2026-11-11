# Kanban de Vagas

Kanban local e open source para organizar a busca de emprego. Você cria perfis de busca (stacks, nível, região, idade da vaga), um worker coleta vagas de nove fontes a cada hora e você acompanha tudo em um quadro, arrastando os cards entre as colunas.

O app guarda os dados em um Postgres (o do `docker-compose.yml` incluído ou um projeto Supabase) e não tem login: foi feito para rodar na sua máquina.

**Nesta primeira versão:** perfis de busca, nove fontes, worker horário, quadro kanban com histórico de movimentos, notas por vaga, contadores e tela de saúde das fontes.

**Planejado (ainda não existe):**

- currículo em PT-BR e inglês, adaptado por IA para cada vaga;
- análise da descrição da vaga, com pontos para a entrevista;
- candidatura automática, com contadores de "aplicadas pela IA" e "precisam de você";
- Glassdoor e mais fontes internacionais;
- contas de usuário e login.

## Começar em dez minutos

Requisitos: Node 24, pnpm 10 (`corepack enable` resolve) e Docker, para o Postgres local.

```bash
docker compose up -d        # Postgres 17 na porta 5433 do host
cp .env.example .env        # no PowerShell: Copy-Item .env.example .env
pnpm install
pnpm dev                    # aplica as migrations e sobe web, api e worker
```

Abra http://localhost:5173, vá em **Perfis de busca**, crie um perfil (marque ao menos uma fonte; Remotive e Gupy não precisam de configuração) e clique em **Buscar agora**. As vagas aparecem na coluna **Descobertas** em alguns segundos.

Para parar: `Ctrl+C` no `pnpm dev` e `docker compose down` (os dados ficam no volume; `docker compose down -v` apaga tudo).

### Usar o Supabase em vez do Docker

Crie um projeto no Supabase, copie a connection string em *Project Settings > Database* e coloque-a em `DATABASE_URL` no `.env`, no lugar da URL do Postgres local. Depois rode `pnpm db:migrate` (o `pnpm dev` também migra).

- A string do pooler funciona, tanto a do *Transaction pooler* (porta 6543) quanto a do *Session pooler* (porta 5432): o app desliga os prepared statements.
- A conexão é criptografada (TLS) por padrão sempre que o host do `DATABASE_URL` não é local, como o do Supabase; não é preciso acrescentar `sslmode` à URL. Hosts locais (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal` ou um nome sem ponto, como o de um serviço do Docker) ficam sem TLS. Para um Postgres em rede privada que não fala TLS, acrescente `?sslmode=disable` à URL; para também validar o certificado do servidor, `?sslmode=verify-full`. Um `sslmode` explícito na URL (ou a variável `PGSSLMODE`) sempre prevalece.
- Todas as tabelas têm RLS habilitado e nenhuma policy. A chave pública (`anon`) da API do Supabase não lê nem escreve nada; o app acessa o banco como dono das tabelas, pelo `DATABASE_URL`, e por isso não é afetado. Não adicione policies.
- Nunca commite o `.env`. O `.gitignore` já o ignora.

## Como funciona

`pnpm dev` sobe três processos que compartilham o mesmo banco:

| Processo | O que faz | Porta |
|---|---|---|
| `web` | Interface React (Vite) | 5173 |
| `api` | API Fastify; as rotas existem em `/` e espelhadas em `/api`. Serve o `apps/web/dist` quando ele existe | 3333 |
| `worker` | Busca vagas e executa a fila de buscas | nenhuma |

No `pnpm dev` o Vite repassa `/api` para a API. O worker nunca é chamado por HTTP: a API grava os pedidos de busca na tabela `runs` e o worker os lê.

A API não envia cabeçalhos CORS: o web está sempre na mesma origem que ela (proxy do Vite em dev, a própria API quando serve o `apps/web/dist`), então outros sites abertos no navegador não conseguem ler as respostas. Requisições que alteram dados (`POST`, `PATCH`, `PUT`, `DELETE`) com um cabeçalho `Origin` de outro host são recusadas com 403; chamadas sem `Origin` (curl, scripts) passam.

**Worker.** Ao iniciar, ele busca na hora se não houve nenhuma busca bem-sucedida na última hora; depois busca a cada hora cheia (10:00, 11:00, ...). Para cada perfil ativo há um run por fonte, executado com timeout de 60 s e uma nova tentativa (a tentativa que estoura o tempo é cancelada antes de a seguinte começar). A fila é verificada a cada 5 s: cada fonte executa um run por vez (os runs da mesma fonte, de perfis diferentes, rodam em sequência), fontes diferentes rodam em paralelo, até 4 runs ao mesmo tempo, e os pedidos manuais passam na frente dos horários. Se o banco estiver fora do ar na hora cheia, a busca daquela hora é enfileirada assim que ele voltar. Uma vaga que já existe (mesma URL, ou mesmo hash de empresa + título + local, mesmo vindo de outra fonte) é ignorada; as novas entram no topo de **Descobertas**. Runs que ficaram "em execução" quando o worker caiu viram erro no próximo start; os que ficaram assim com o worker ainda rodando (a conexão com o banco caiu no meio do run) viram erro em cerca de 5 minutos, na própria verificação da fila, e a fonte volta a ser buscada.

**Buscar agora.** O botão enfileira um run por fonte do perfil; o worker inicia em até 5 s os das fontes que estão livres. O de uma fonte que está no meio de outro run (a busca horária de outro perfil, por exemplo) espera esse run terminar, o que pode levar até cerca de 2 minutos, e o mesmo vale quando já há 4 runs em andamento. Enquanto isso o quadro, os contadores e a saúde das fontes são recarregados a cada 2 s por 30 s; depois voltam ao intervalo normal (15 s). Fontes do perfil que já têm um run na fila ou em andamento são puladas; se todas já têm, a interface avisa que há uma busca em andamento.

**Filtros do perfil.** Uma vaga passa se alguma das stacks aparece no título, nas stacks detectadas ou na descrição; o nível é lido do título (títulos sem nível aparente passam); região e idade máxima também são aplicados. Nas fontes que buscam por palavra-chave (Gupy, Himalayas, LinkedIn e Indeed), só as **três primeiras stacks** do perfil viram termos de busca; sem stacks, a busca usa "developer" ("desenvolvedor" no Gupy). As demais fontes baixam o feed inteiro e o filtro é local.

**Colunas.** Descobertas, Selecionadas, Aplicada, Entrevista, Oferta e Arquivada. Todo movimento é manual (arrastar e soltar) e fica no histórico da vaga. Mover um card para Aplicada conta como "aplicada por você". O card abre um painel lateral com a descrição, o link original, notas editáveis e o histórico. A barra do topo mostra o total de vagas e os contadores de aplicadas e de pendentes; os da IA ficam zerados enquanto a candidatura automática não existe.

**Saúde das fontes.** Mostra, por fonte, o último run: status (OK, Erro ou Nunca rodou), vagas encontradas, novas, horário e a mensagem de erro. Uma fonte com erro não impede as outras. Se nenhum run termina há mais de 2 horas, a interface avisa que o worker pode estar parado.

## Worker sempre ligado

O worker só busca enquanto está rodando. Para ele rodar sem a interface aberta:

```bash
pnpm worker:install             # instala
pnpm worker:install --uninstall # remove
```

**Windows.** O comando grava `worker.cmd` na raiz do repo (ignorado pelo git), que roda `pnpm --filter @kv/worker start`, e registra a tarefa agendada `KanbanVagasWorker`, que o executa a cada logon do seu usuário. Não precisa de administrador, e a tarefa não tem limite de tempo. Uma janela de console fica aberta; fechá-la para o worker.

```bash
schtasks /Run /TN KanbanVagasWorker     # iniciar agora, sem sair da sessão
schtasks /Query /TN KanbanVagasWorker   # conferir
```

**Linux e macOS.** O comando só imprime as instruções do `pm2`; nada é instalado.

O worker lê o `DATABASE_URL` do `.env` na raiz do repo, então crie o `.env` e rode `pnpm db:migrate` antes. Ele não migra o banco. Com o Postgres do Docker, o Docker precisa estar ligado (o container sobe sozinho com ele); se o worker iniciar antes de o banco responder, como no logon do Windows com o Docker Desktop ainda subindo, ele tenta de novo por até 5 minutos antes de desistir. A API faz a mesma espera. Banco sem tabelas não é esperado: o erro pede `pnpm db:migrate` na hora. Com o worker instalado, não é preciso o worker do `pnpm dev`; rodar os dois duplica as buscas (as vagas não duplicam, a deduplicação cobre).

## Fontes

| Fonte | Região | Método |
|---|---|---|
| Gupy | Brasil | Endpoint não oficial do próprio portal, por palavra-chave |
| Remotive | Remoto global | Feed JSON público, baixado inteiro |
| RemoteOK | Remoto global | Feed JSON público |
| Greenhouse | Exterior | Job Board API, uma consulta por empresa da lista |
| Lever | Exterior | Postings API, uma consulta por empresa da lista |
| Arbeitnow | Europa / remoto | API JSON pública |
| Himalayas | Remoto global | API JSON pública de busca, por palavra-chave (2 páginas por termo) |
| LinkedIn | Brasil / exterior | Endpoint público de busca, sem login |
| Indeed | Brasil / exterior | Chromium via Playwright, sem login |

- **Gupy** usa um endpoint que o portal da Gupy chama no navegador. Não é uma API documentada e pode mudar sem aviso.
- **Remotive** tem um feed público pequeno. O app o baixa uma vez e o guarda em memória por 6 horas; buscas dentro desse prazo reaproveitam o feed.
- **Greenhouse e Lever** consultam uma lista configurável de empresas (`GREENHOUSE_BOARDS` e `LEVER_COMPANIES`). Os padrões estão na tabela de configuração; empresas que não existem nessas plataformas são ignoradas desde que ao menos uma responda.
- **LinkedIn e Indeed** leem páginas públicas, sem usar sua conta. Não há API oficial: eles podem quebrar ou ser bloqueados a qualquer momento, e o acesso automatizado pode contrariar os termos desses sites. Use por sua conta e risco. Os cards dessas duas fontes vêm sem texto de descrição.
- **Indeed** é bloqueado quando o Chromium roda sem janela (headless). Só funciona com `INDEED_HEADFUL=1` no `.env` (abre uma janela de navegador visível a cada busca), depois de instalar o Chromium do Playwright: `pnpm --filter @kv/connectors exec playwright install chromium`. Sem isso, o run termina em erro e aparece na tela de saúde das fontes.

## Configuração

Variáveis lidas pelo código. API, worker e `pnpm db:migrate` leem o `.env` da raiz do repo; variáveis já definidas no ambiente do processo têm precedência sobre as do arquivo.

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | nenhum (obrigatória) | Connection string do Postgres. Sem ela, API, worker e migrations não sobem |
| `API_PORT` | `3333` | Porta da API. O proxy do Vite só enxerga a variável se ela estiver no ambiente do shell, não só no `.env` |
| `PORT` | nenhum | Porta da API em plataformas que a injetam (Railway); tem precedência sobre `API_PORT` |
| `HOST` | `127.0.0.1` | Endereço em que a API escuta; o container usa `0.0.0.0` |
| `WEB_DIST` | `apps/web/dist` | Diretório do web buildado que a API serve, quando tem `index.html` |
| `GREENHOUSE_BOARDS` | `gitlab,stripe,cloudflare,figma` | Boards do Greenhouse, separados por vírgula |
| `LEVER_COMPANIES` | `palantir,spotify` | Empresas do Lever, separadas por vírgula |
| `FAKE_CONNECTORS` | desligado | `1` troca todas as fontes por uma fonte falsa e determinística (testes e2e, sem rede) |
| `INDEED_HEADFUL` | desligado | `1` abre o Chromium do Indeed com janela visível |
| `E2E_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/kanban_e2e` | Só no `pnpm e2e`. O nome do banco precisa terminar em `_e2e` ou `_test` |
| `E2E_SCREENSHOT_DIR` | desligado | Só no `pnpm e2e`: pasta onde o teste grava screenshots |
| `CI` | desligado | Só no `pnpm e2e`: com `CI` definida, o Playwright gera relatório HTML e proíbe `test.only` |

## Desenvolvimento

```bash
pnpm test           # testes unitários (Vitest)
pnpm typecheck      # tsc --noEmit em todos os pacotes
pnpm e2e            # teste de ponta a ponta (Playwright)
pnpm db:generate    # gera uma migration a partir de packages/db/src/schema.ts
pnpm db:migrate     # aplica as migrations pendentes no DATABASE_URL
pnpm start:prod     # migra e sobe api + worker como em produção (veja "Deploy")
```

- Os testes unitários não usam rede nem Docker: o banco é um Postgres em memória (PGlite) e as fontes são testadas contra fixtures gravadas.
- O `pnpm e2e` precisa do Postgres do compose no ar (`docker compose up -d`) e do Chromium do Playwright (`pnpm --filter @kv/web exec playwright install chromium`, uma vez). Ele cria o banco `kanban_e2e` se não existir, esvazia as tabelas a cada execução e sobe seu próprio `pnpm dev` com `FAKE_CONNECTORS=1`, então as portas 5173 e 3333 precisam estar livres (pare o seu `pnpm dev`). O banco `kanban` de desenvolvimento não é tocado.
- Mudou o schema? Edite `packages/db/src/schema.ts`, rode `pnpm db:generate`, revise o SQL gerado em `packages/db/migrations` e aplique com `pnpm db:migrate`. Tabelas novas usam `.enableRLS()` para manter o RLS habilitado.

Estrutura:

```
apps/web              interface React + Vite + Tailwind + Motion + dnd-kit + TanStack Query
apps/api              API Fastify
apps/worker           busca horária e fila de buscas
packages/connectors   uma fonte por arquivo, mais filtro local e fixtures
packages/db           schema Drizzle, migrations SQL e cliente postgres-js
packages/shared       tipos e schemas Zod
scripts/              start de produção, instalação do worker, gravação de fixtures
.railway/             configuração do Railway (nunca aplicada, veja "Deploy")
docs/superpowers/     spec e plano de implementação
```

### Adicionar uma fonte

1. Grave uma resposta real: `node scripts/record-fixture.mjs <url> packages/connectors/fixtures/<fonte>.json [chave-do-array] [n]`. Se a resposta for JSON, o script corta a lista para `n` itens (padrão 5).
2. Crie `packages/connectors/src/<fonte>.ts` com uma função de mapeamento pura (resposta da fonte para `NormalizedJob`, usando `keepValid` e `expectList` de `normalize.ts`) e um `Connector` (`id`, `name`, `search(filters)`) que a usa.
3. Teste o mapeamento contra a fixture em `<fonte>.test.ts` (veja `remotive.test.ts`) e inclua a fonte em `drift.test.ts`, que garante que uma mudança de formato vira erro, não "0 vagas".
4. Registre o conector na lista `REAL` de `packages/connectors/src/index.ts` e atualize a lista de ids em `index.test.ts`.

## CI

O workflow `.github/workflows/ci.yml` roda em push para a `main` e em pull requests de qualquer branch. Um job no Ubuntu, com Node 24 e um Postgres 17 como serviço, executa em ordem: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, instalação do Chromium do Playwright e `pnpm e2e` (banco `kanban_e2e`). Se algo falhar, o relatório do Playwright é guardado como artefato por 7 dias. Uma execução nova no mesmo branch cancela a anterior.

## Deploy no Railway

> **ATENÇÃO: o app NÃO TEM LOGIN.** Quem tiver a URL lê e altera tudo (vagas, notas, perfis). **Não gere domínio público** para o serviço enquanto não existir autenticação. A configuração do repo não declara domínio de propósito.

O alvo é **um serviço** construído pelo `Dockerfile`. Um container roda a API (que também serve o web já buildado) e o worker, iniciados por `scripts/start-prod.mjs`.

- **Banco:** defina a variável `DATABASE_URL` do serviço com a connection string do Postgres (Supabase, por exemplo). Ela nunca fica no repositório.
- **Migrations:** o `start-prod.mjs` aplica as migrations pendentes antes de subir a API e o worker. API e worker não migram. Se o banco ainda não aceita conexões (redeploy junto com o banco), as migrations, a API e o worker esperam por ele até 5 minutos cada antes de sair com erro.
- **Healthcheck:** `/api/stats`, que consulta o banco.
- **Uma réplica só.** O worker e as migrations do start não foram feitos para rodar em paralelo; com mais de uma réplica as buscas rodariam em dobro e duas réplicas poderiam migrar ao mesmo tempo.
- Se a API ou o worker cair, o container sai com erro e o Railway o reinicia.
- **Indeed não funciona no container:** a imagem não tem Chromium. A fonte falha com erro claro na tela de saúde das fontes.

O arquivo `.railway/railway.ts` descreve esse serviço como infraestrutura como código. **Ele nunca foi aplicado nem validado contra o Railway.** O primeiro passo, que só lê e não altera nada, é `railway config plan`; ele exige o pacote `railway` instalado no repo como dependência de desenvolvimento (`pnpm add -D -w railway`). Revise o plano antes de qualquer `railway config apply`.

### Rodar o mesmo container localmente

Com o Postgres do compose no ar:

```bash
docker build -t kanban-vagas .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5433/kanban \
  kanban-vagas
```

Abra http://localhost:8080. No Docker Desktop (Windows e macOS) `host.docker.internal` já existe; no Linux acrescente `--add-host=host.docker.internal:host-gateway`.

Sem Docker, `pnpm --filter @kv/web build && pnpm start:prod` faz o mesmo no host: migra, sobe API e worker e serve o web buildado (porta 3333, ou `PORT`).

## Licença

Apache License 2.0. Veja o arquivo [`LICENSE`](LICENSE).

# Core: Kanban de Vagas — Design

Data: 2026-11-11
Status: aprovado para planejamento

## Contexto

Kanban de vagas open source, local-first. O produto completo foi dividido em cinco sub-projetos:

1. **Core** (este spec) — kanban, banco, framework de conectores, worker de busca.
2. IA de perfil — currículo PT-BR/EN, adaptação por vaga, análise da descrição.
3. Auto-apply — IA aplica e move o card até "Entrevista"; contadores de aplicadas e pendentes humanas.
4. Conectores adicionais — Glassdoor e mais fontes internacionais.
5. Polish open source — assets extras, docs, empacotamento.

Cada sub-projeto tem seu próprio spec, plano e implementação.

## Objetivo do Core

Entregar um app local em que o usuário cria perfis de busca, um worker coleta vagas de nove fontes a cada hora, e as vagas aparecem em um kanban que o usuário organiza manualmente.

## Fora de escopo

- Upload de currículo e qualquer chamada a LLM.
- Candidatura automática.
- Login em qualquer site de vagas.
- Glassdoor.
- Multiusuário, autenticação, deploy em nuvem.

## Arquitetura

Monorepo TypeScript com pnpm workspaces. Três processos e um banco SQLite compartilhado.

```
apps/web              React + Vite + Tailwind + Motion + dnd-kit
apps/api              Fastify + Drizzle ORM + SQLite (better-sqlite3)
apps/worker           node-cron + conectores
packages/connectors   um arquivo por fonte, interface comum
packages/shared       tipos e schemas Zod
packages/db           schema Drizzle, migrations, cliente
```

- `web` fala somente com `api` por HTTP.
- `api` e `worker` acessam o SQLite via `packages/db` (modo WAL para leitura e escrita concorrentes).
- `worker` nunca é chamado por HTTP; a API enfileira pedidos de execução na tabela `runs`.
- `pnpm dev` sobe os três processos. `pnpm worker:install` registra o worker como tarefa agendada do sistema (Task Scheduler no Windows, pm2 nos demais) para rodar com a UI fechada.

## Modelo de dados

**search_profiles** — `id`, `name`, `stacks` (lista), `levels` (junior | pleno | senior, lista), `max_age_days` (1 | 3 | 7 | 30), `regions` (brasil | exterior | remoto, lista), `sources` (lista de ids de conector), `active`, `created_at`.

**jobs** — `id`, `source`, `external_id`, `url`, `title`, `company`, `location`, `remote` (bool), `level` (nullable), `stacks` (lista), `description`, `posted_at`, `discovered_at`, `dedup_hash`, `profile_id`, `column`, `position`, `applied_by` (ia | humano | null), `needs_human` (bool), `needs_human_reason` (nullable), `notes`.

**job_events** — `id`, `job_id`, `from_column`, `to_column`, `actor` (ia | humano | sistema), `created_at`.

**runs** — `id`, `profile_id`, `source`, `trigger` (cron | manual), `status` (queued | running | ok | error), `found`, `inserted`, `error`, `started_at`, `finished_at`.

Os campos `applied_by`, `needs_human` e `needs_human_reason` existem desde o Core, mas só são preenchidos pelo sub-projeto 3.

## Conectores

Interface única em `packages/connectors`:

```ts
interface Connector {
  id: string;
  name: string;
  search(filters: SearchFilters): Promise<NormalizedJob[]>;
}
```

`SearchFilters` carrega stacks, níveis, idade máxima e regiões. Cada conector traduz esses filtros para a fonte e devolve vagas normalizadas; o que a fonte não filtra é filtrado localmente por uma função comum.

| Conector | Método | Região |
|---|---|---|
| Gupy | API pública de busca | Brasil |
| Remotive | API JSON pública | Remoto global |
| RemoteOK | Feed JSON público | Remoto global |
| Greenhouse | Job Board API por empresa (lista configurável) | Exterior |
| Lever | Postings API por empresa (lista configurável) | Exterior |
| Arbeitnow | API JSON pública | Europa / remoto |
| Himalayas | API JSON pública | Remoto global |
| LinkedIn | Endpoint guest de busca, sem login | Brasil / exterior |
| Indeed | Playwright headless, sem login | Brasil / exterior |

LinkedIn e Indeed dependem de páginas públicas sem contrato de API. São frágeis por natureza, usam intervalo entre requisições e ficam isolados: bloqueio ou mudança de layout gera erro no run daquele conector e nada mais. O README avisa que o uso dessas duas fontes é por conta do usuário, sujeito aos termos de cada site.

Adicionar uma fonte significa criar um arquivo e registrá-lo no índice de conectores.

## Worker

- Cron a cada hora cheia. Ao iniciar, executa imediatamente se o último run com sucesso tem mais de uma hora.
- Para cada perfil ativo, executa os conectores selecionados em paralelo, com timeout de 60 s e um retry por conector.
- Deduplicação: `dedup_hash` = hash de empresa + título normalizados + localização; vaga já existente (mesma `url` ou mesmo hash) é ignorada.
- Vagas novas entram na coluna `descobertas`.
- Cada execução de conector grava uma linha em `runs`.
- A cada 5 s o worker verifica `runs` com status `queued` (criados pelo botão "Buscar agora") e os executa.

## API

- `GET/POST/PATCH/DELETE /profiles`
- `GET /jobs?column=&profile=&source=&q=`
- `PATCH /jobs/:id` — mover (coluna, posição) e editar notas; grava `job_events`.
- `GET /jobs/:id` — detalhe com histórico.
- `POST /runs` — enfileira execução manual de um perfil.
- `GET /runs/health` — último run por conector.
- `GET /stats` — contadores do topo.

Entradas validadas com os schemas Zod de `packages/shared`.

## Interface

**Kanban** — colunas: Descobertas, Selecionadas, Aplicada, Entrevista, Oferta, Arquivada. No Core todo movimento é manual, por drag and drop. Card mostra título, empresa, fonte, local/remoto, nível, stacks e idade da vaga.

**Contadores** — barra superior: total de vagas, aplicadas pela IA, aplicadas por humano, pendentes de humano. Os de IA aparecem zerados no Core.

**Detalhe da vaga** — drawer lateral com descrição, link original, notas editáveis e histórico de movimentos. Reserva uma seção vazia "Análise IA" para o sub-projeto 2.

**Perfis de busca** — tela de lista e formulário (stacks, nível, idade máxima, região, fontes, ativo) e botão "Buscar agora".

**Saúde das fontes** — painel com último run de cada conector: status, quantidade, erro. Conector em erro mostra badge de aviso.

**Visual** — tema escuro por padrão. Motion para arrastar, entrada de cards e contadores animados; respeita `prefers-reduced-motion`. Assets gerados no Higgsfield: logo, ilustrações de estado vazio e fundo do cabeçalho, salvos em `apps/web/public`.

## Erros

- Falha de conector: registrada em `runs`, visível em "Saúde das fontes", não interrompe os demais.
- Worker parado: a UI mostra aviso quando o último run tem mais de duas horas.
- Erros de API: resposta JSON `{ error, message }` e toast na UI.

## Testes

- Vitest: cada conector contra fixtures gravadas (sem rede), filtro local, deduplicação, rotas da API com banco em memória.
- Playwright e2e: criar perfil, executar run com conector fake, ver card em Descobertas, arrastar para Selecionadas.

## Critérios de aceite

1. `pnpm install && pnpm dev` sobe web, api e worker em uma máquina limpa com Node 24.
2. Um perfil ativo produz vagas em Descobertas sem ação do usuário, a cada hora.
3. "Buscar agora" traz vagas em menos de dois minutos.
4. A mesma vaga não aparece duas vezes.
5. Um conector com erro não impede os outros de entregar vagas.
6. Mover um card persiste após recarregar a página e aparece no histórico.

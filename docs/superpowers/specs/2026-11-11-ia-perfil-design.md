# IA de Perfil — Design (sub-projeto 2)

Data: 2026-11-11
Status: aprovado para planejamento
Depende de: Core (`2026-11-11-core-kanban-design.md`, incluindo os adendos de Postgres e Railway)

## Objetivo

O usuário sobe seu currículo em português e em inglês. O app traduz as vagas, dá uma nota de aderência a cada uma, analisa em detalhe as que interessam e gera, sob demanda, um currículo adaptado à vaga, sem inventar nada.

## Fora de escopo

- Candidatura automática (sub-projeto 3).
- Carta de apresentação.
- Login e multiusuário.
- Manter o layout visual do currículo original.
- Exportar DOCX.

## Motor de IA

Novo pacote `packages/ai`, com uma interface única:

```ts
interface AiProvider {
  id: 'anthropic' | 'openai' | 'gemini';
  generate<T>(req: {
    tier: 'fast' | 'strong';
    system: string;
    prompt: string;
    schema: ZodType<T>;
    maxOutputTokens: number;
  }): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number }; model: string }>;
}
```

- Três adaptadores na primeira versão: Claude (Anthropic), OpenAI e Gemini, cada um com o SDK oficial do provedor e saída estruturada nativa validada pelo schema Zod.
- Seleção por ambiente: `AI_PROVIDER` e a chave do provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` ou `GEMINI_API_KEY`).
- Dois níveis de modelo por provedor: `fast` (triagem em massa) e `strong` (análise e currículo). Padrões para Claude: `claude-haiku-5-5` e `claude-opus-5-5`. Os padrões de OpenAI e Gemini são definidos no plano, conferidos na documentação atual de cada um. Todos podem ser trocados por `AI_MODEL_FAST` e `AI_MODEL_STRONG`.
- Tabela de preços por modelo em um arquivo de configuração, usada só para estimar custo.
- Sem provedor configurado, o app funciona como no Core e as áreas de IA mostram "IA não configurada" com o passo a passo.
- Recusa do modelo, saída fora do schema, limite de taxa e erro de rede viram erro tipado; a tarefa é tentada de novo até três vezes com espera crescente e depois marcada como falha, visível na interface.

## Currículo e perfil

- Tela nova **Meu perfil**: upload de um arquivo por idioma (`pt-BR`, `en`), PDF ou DOCX, até 5 MB.
- O servidor extrai o texto (PDF e DOCX) e o modelo `strong` o converte em um perfil estruturado: dados de contato, resumo, experiências (empresa, cargo, início, fim, local, realizações), formação, habilidades, idiomas, certificações, links.
- O usuário revisa e edita o perfil estruturado na tela. **Esse perfil, por idioma, é a fonte da verdade** para tudo que a IA escreve. O arquivo original fica guardado e nunca é alterado.
- Se só um idioma foi enviado, o outro pode ser gerado por tradução do perfil, marcado como "traduzido por IA" até o usuário revisar.
- PDF só com imagem (sem texto extraível) é recusado com mensagem clara.

## Camadas de processamento

**Camada 1 — toda vaga nova (automática, modelo `fast`, em lotes).** Idioma da vaga, título traduzido para pt-BR quando necessário, nota de aderência de 0 a 100 e uma linha de justificativa. Roda só quando existe perfil. O card mostra a nota e o idioma; cada coluna pode ser ordenada por nota.

**Camada 2 — ao mover para Selecionadas ou abrir a vaga (automática, modelo `strong`).** Busca a descrição se a fonte não a entregou (LinkedIn e Indeed), sem login e com as mesmas regras de acesso do Core; tradução completa da descrição; análise com: pontos fortes do perfil para a vaga, lacunas, palavras-chave da vaga presentes e ausentes no perfil, o que revisar para a entrevista e perguntas prováveis. Preenche a seção "Análise IA" do drawer, com alternância entre texto original e traduzido.

**Camada 3 — sob demanda, botão "Adaptar currículo" (modelo `strong`).** Gera uma versão do perfil voltada à vaga, no idioma da vaga (pt-BR ou inglês; outros idiomas usam inglês). O usuário revisa e edita o texto na tela e baixa um PDF de uma coluna, com texto selecionável, sem tabelas nem imagens, adequado a sistemas de triagem.

Todo resultado é gravado e reutilizado: a mesma vaga com o mesmo perfil nunca é processada duas vezes. Editar o perfil marca notas e análises como desatualizadas; elas são refeitas na próxima vez que forem necessárias, não todas de uma vez.

## Regra de não invenção

- Os prompts permitem reordenar, resumir, reescrever e enfatizar; proíbem acrescentar empresa, cargo, data, formação, certificação, idioma ou habilidade que não esteja no perfil.
- O currículo adaptado é gerado como estrutura que **referencia** itens do perfil por identificador (experiência, formação, habilidade); só os textos livres (resumo e realizações) são reescritos.
- Verificação em código, antes de mostrar o resultado: todo identificador existe no perfil; empresas, cargos e datas são copiados do perfil, não do modelo; toda habilidade listada existe no perfil; números citados nas realizações reescritas (percentuais, valores, quantidades) aparecem na realização original correspondente. Qualquer divergência bloqueia o resultado e mostra o que divergiu.
- A análise da camada 2 pode sugerir o que estudar, mas nunca afirma que o usuário tem algo que não está no perfil.

## Conteúdo de terceiros

Título e descrição de vaga vêm de sites externos e entram nos prompts apenas como dados, delimitados e acompanhados da instrução de ignorar qualquer comando contido neles. A saída estruturada e a verificação de não invenção limitam o efeito de uma vaga maliciosa.

## Custo

- Cada chamada grava provedor, modelo, camada, tokens de entrada e saída e custo estimado.
- `AI_DAILY_BUDGET_USD` (padrão 1,00). Ao atingir o limite do dia: a camada 1 pausa até o dia seguinte; as camadas 2 e 3 pedem confirmação do usuário antes de cada execução.
- A tela Meu perfil mostra o gasto do dia e dos últimos 30 dias, por camada.
- A camada 1 só envia ao modelo título, empresa, local e um trecho inicial da descrição; o perfil vai resumido e em posição fixa no prompt para aproveitar cache de prompt quando o provedor oferecer.

## Privacidade

A interface e o README avisam, antes do primeiro upload, que o currículo e as vagas são enviados ao provedor de IA escolhido. O currículo fica no banco do próprio usuário. O alerta do Core continua valendo: sem login, o app não deve ficar em URL pública.

## Dados

Tabelas novas, com RLS habilitado como as demais:

- `resumes` — idioma, nome do arquivo, tipo, conteúdo binário, texto extraído, enviado em.
- `profiles` — idioma, dados estruturados (JSON), origem (`extraido` | `traduzido` | `editado`), versão, atualizado em.
- `job_ai` — vaga, idioma detectado, título traduzido, nota, justificativa, descrição traduzida, análise (JSON), versão do perfil usada, estado por camada.
- `tailored_resumes` — vaga, idioma, conteúdo estruturado (JSON), versão do perfil, criado e editado em.
- `ai_tasks` — fila: tipo, vaga, estado (`queued` | `running` | `ok` | `error` | `blocked_budget`), tentativas, erro, datas; no máximo uma tarefa pendente por tipo e vaga.
- `ai_usage` — provedor, modelo, camada, tokens, custo estimado, data.

`jobs` ganha `description_fetched_at`.

## Processamento

- A fila de IA é separada da fila de busca. O worker a consome com concorrência limitada; falha ou lentidão de IA nunca atrasa a busca de vagas.
- A API enfileira tarefas (upload, mover para Selecionadas, abrir vaga, pedir adaptação) e a interface acompanha o estado; nenhuma chamada de IA acontece dentro de uma requisição HTTP.
- O PDF é gerado no servidor a partir do conteúdo estruturado revisado.

## Interface

- **Meu perfil:** upload por idioma, perfil estruturado editável, estado da IA (provedor, modelos), gasto.
- **Card:** nota de aderência, idioma original, título traduzido com o original em dica.
- **Quadro:** ordenar coluna por nota.
- **Drawer:** seção "Análise IA" preenchida, alternância original/traduzido, botão "Adaptar currículo", editor do currículo adaptado e download do PDF, estados de carregando, erro e limite de gasto.

## Testes

- Adaptadores dos três provedores contra respostas gravadas; nenhum teste automatizado chama um provedor real.
- Provedor falso determinístico para testes unitários e e2e.
- Verificador de não invenção com casos adversariais: empresa inventada, data alterada, habilidade a mais, número novo em realização.
- Extração de texto com PDFs e DOCX de exemplo, incluindo PDF sem texto.
- Orçamento: pausa da camada 1, confirmação nas camadas 2 e 3, virada do dia.
- Injeção: vaga cujo texto manda ignorar instruções não altera a estrutura da saída nem passa pelo verificador.
- e2e: enviar currículo, ver nota no card, abrir análise, adaptar currículo, baixar PDF.
- Um roteiro manual, fora da CI, que roda cada provedor real com uma vaga e um perfil de exemplo, para conferir qualidade e custo antes de liberar.

## Critérios de aceite

1. Com um provedor configurado e um currículo enviado, vagas novas recebem nota e título em português sem ação do usuário.
2. Mover uma vaga para Selecionadas produz a análise completa e a tradução em até dois minutos.
3. O currículo adaptado nunca contém empresa, cargo, data, formação ou habilidade ausente do perfil; os testes adversariais bloqueiam todos os casos.
4. O PDF baixado tem texto selecionável e uma coluna.
5. Trocar `AI_PROVIDER` entre os três provedores não exige mudança de código.
6. Ao atingir o limite diário, nenhuma chamada automática é feita até o dia seguinte.
7. Sem provedor configurado, todas as funções do Core continuam funcionando.
8. Uma falha do provedor de IA não impede nem atrasa a busca horária de vagas.

## Adendo (2026-11-11): aba Configurações

Decidido após a aprovação do spec; onde conflitar com as seções acima, vale este adendo.

**Motivo.** Configurar provedor, chave, modelos, orçamento e listas de empresas só por `.env` é pouco prático. O app ganha uma aba **Configurações**.

**Conteúdo da aba**

- *IA:* provedor (Claude, OpenAI, Gemini); modelo rápido e modelo forte, com os padrões do provedor pré-preenchidos; chave de API; limite diário de gasto; liga/desliga da camada 1 (triagem automática) e do disparo automático da camada 2; botão "Testar conexão"; gasto de hoje e dos últimos 30 dias.
- *Fontes:* empresas consultadas no Greenhouse e no Lever; aviso de que o Indeed exige navegador visível e não funciona no container.
- *Geral:* estado do worker e horário da próxima busca. O idioma de tradução permanece pt-BR nesta versão.

O resumo de gasto e o estado da IA, antes previstos em "Meu perfil", ficam em Configurações; "Meu perfil" mantém currículo e perfil estruturado, com um atalho para Configurações quando a IA não está configurada.

**Chave de API**

- Digitada na aba e gravada no banco **cifrada** (AES-256-GCM, nonce aleatório por gravação) com chave derivada de `APP_SECRET`, que existe apenas no ambiente do servidor.
- É de escrita apenas: a API nunca devolve a chave; a tela mostra só provedor, os quatro últimos caracteres e a data da gravação. Há ação para remover.
- Uma chave por provedor; trocar de provedor não apaga as outras.
- Se a variável de ambiente do provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) estiver definida, ela tem prioridade e a tela informa "definida pelo ambiente" sem permitir edição.
- Sem `APP_SECRET`, gravar chave pela tela fica desabilitado, com a instrução de como gerar o segredo; as demais configurações funcionam.
- Trocar `APP_SECRET` invalida as chaves gravadas: a decifragem falha de forma tratada e a tela pede a chave de novo.
- A chave nunca aparece em log, mensagem de erro, resposta de API ou registro de uso.

**Demais configurações**

- Gravadas em uma tabela `settings` (chave, valor JSON, atualizado em), com RLS como as demais.
- Precedência para valores não secretos: configuração gravada pela tela, depois variável de ambiente, depois padrão do código. As variáveis `AI_PROVIDER`, `AI_MODEL_FAST`, `AI_MODEL_STRONG`, `AI_DAILY_BUDGET_USD`, `GREENHOUSE_BOARDS` e `LEVER_COMPANIES` continuam válidas como padrão inicial.
- API e worker leem a configuração do banco a cada uso (com cache curto), de modo que uma mudança na tela vale sem reiniciar processos.
- Valores validados no servidor: modelos como texto curto, orçamento entre 0 e um teto, listas de empresas com tamanho e formato limitados.

**Testar conexão**

- Faz uma chamada mínima ao provedor com o modelo rápido e informa sucesso, chave inválida, modelo inexistente, sem crédito ou erro de rede, sem expor a chave.
- Custa uma fração de centavo; é registrada no uso; tem limite de frequência no servidor.

**Segurança**

- As rotas de configuração seguem as proteções existentes (validação, guarda de origem, erro genérico em falha interna).
- O alerta do Core continua: sem login, quem alcança o app consegue trocar o provedor e gastar a chave gravada, embora não consiga lê-la. O app não deve ficar em URL pública antes do sub-projeto de login.

**Critérios de aceite adicionais**

9. Configurar provedor, modelos, chave e orçamento pela tela põe a IA para funcionar sem editar arquivos nem reiniciar processos.
10. Nenhuma resposta da API, log ou linha do banco contém a chave em texto puro.
11. Com a variável de ambiente da chave definida, a tela não permite sobrescrevê-la e indica a origem.
12. Sem `APP_SECRET`, a gravação de chave é recusada com instrução clara e o restante do app funciona.

# Kanban de Vagas

Kanban local e open source para organizar a busca de emprego. Você cria perfis de busca (stacks, nível, região, idade da vaga), um worker coleta vagas de nove fontes a cada hora e você acompanha tudo em um quadro, arrastando os cards entre as colunas.

O app guarda os dados em um Postgres (o do `docker-compose.yml` incluído ou um projeto Supabase) e não tem login: foi feito para rodar na sua máquina.

**O que existe hoje:** perfis de busca, nove fontes, worker horário, quadro kanban com histórico de movimentos, notas por vaga, contadores e tela de saúde das fontes.

**Opcional, com uma chave de API de um provedor de IA (Claude, OpenAI ou Gemini):** você envia o currículo em português e/ou inglês, o app extrai um perfil estruturado, dá nota e título traduzido a cada vaga, analisa as vagas que interessam (pontos fortes, lacunas, o que revisar para a entrevista) e gera, a pedido, um currículo adaptado em PDF, sem inventar nada. Sem chave, tudo o mais funciona igual. Veja [IA de perfil](#ia-de-perfil).

**Opcional, desligada por padrão, só no seu computador:** candidatura automática. O app abre um navegador, preenche o formulário de candidatura da vaga com o seu currículo e as suas respostas e, se você deixar, envia em seu nome. Começa sempre em modo ensaio, que não envia nada. Leia [Candidatura automática](#candidatura-automática) antes de ligar.

**Planejado (ainda não existe):**

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
| `worker` | Busca vagas, executa a fila de buscas, a fila de IA e a fila de candidaturas | nenhuma |

No `pnpm dev` o Vite repassa `/api` para a API. O worker nunca é chamado por HTTP: a API grava os pedidos de busca na tabela `runs` e o worker os lê.

A API não envia cabeçalhos CORS: o web está sempre na mesma origem que ela (proxy do Vite em dev, a própria API quando serve o `apps/web/dist`), então outros sites abertos no navegador não conseguem ler as respostas. Requisições que alteram dados (`POST`, `PATCH`, `PUT`, `DELETE`) com um cabeçalho `Origin` de outro host são recusadas com 403; chamadas sem `Origin` (curl, scripts) passam.

A API também confere o cabeçalho `Host` de **toda** requisição: só aceita `localhost`, `host.docker.internal`, um endereço IP ou um nome listado em `ALLOWED_HOSTS`; o resto recebe 403. É a proteção contra *DNS rebinding*: uma página maliciosa aberta no seu navegador pode fazer o próprio domínio apontar para `127.0.0.1` e, a partir daí, falar com a API local como se fosse a mesma origem (ler o seu currículo, gastar a sua chave). O `Host` continua sendo o nome do atacante, e é por ele que a requisição é recusada. Em uso local (`pnpm dev`, `pnpm start:prod`, `docker run -p 8080:8080` aberto em `localhost`) não há nada a configurar; atrás de um domínio próprio, defina `ALLOWED_HOSTS=seu.dominio`.

**Worker.** Ao iniciar, ele busca na hora se não houve nenhuma busca bem-sucedida na última hora; depois busca a cada hora cheia (10:00, 11:00, ...). Para cada perfil ativo há um run por fonte, executado com timeout de 60 s e uma nova tentativa (a tentativa que estoura o tempo é cancelada antes de a seguinte começar). A fila é verificada a cada 5 s: cada fonte executa um run por vez (os runs da mesma fonte, de perfis diferentes, rodam em sequência), fontes diferentes rodam em paralelo, até 4 runs ao mesmo tempo, e os pedidos manuais passam na frente dos horários. Se o banco estiver fora do ar na hora cheia, a busca daquela hora é enfileirada assim que ele voltar. Uma vaga que já existe (mesma URL, ou mesmo hash de empresa + título + local, mesmo vindo de outra fonte) é ignorada; as novas entram no topo de **Descobertas**. Runs que ficaram "em execução" quando o worker caiu viram erro no próximo start; os que ficaram assim com o worker ainda rodando (a conexão com o banco caiu no meio do run) viram erro em cerca de 5 minutos, na própria verificação da fila, e a fonte volta a ser buscada.

**Buscar agora.** O botão enfileira um run por fonte do perfil; o worker inicia em até 5 s os das fontes que estão livres. O de uma fonte que está no meio de outro run (a busca horária de outro perfil, por exemplo) espera esse run terminar, o que pode levar até cerca de 2 minutos, e o mesmo vale quando já há 4 runs em andamento. Enquanto isso o quadro, os contadores e a saúde das fontes são recarregados a cada 2 s por 30 s; depois voltam ao intervalo normal (15 s). Fontes do perfil que já têm um run na fila ou em andamento são puladas; se todas já têm, a interface avisa que há uma busca em andamento.

**Filtros do perfil.** Uma vaga passa se alguma das stacks aparece no título, nas stacks detectadas ou na descrição; o nível é lido do título (títulos sem nível aparente passam); região e idade máxima também são aplicados. Nas fontes que buscam por palavra-chave (Gupy, Himalayas, LinkedIn e Indeed), só as **três primeiras stacks** do perfil viram termos de busca; sem stacks, a busca usa "developer" ("desenvolvedor" no Gupy). As demais fontes baixam o feed inteiro e o filtro é local.

**Colunas.** Descobertas, Selecionadas, Aplicada, Entrevista, Oferta e Arquivada. Todo movimento é manual (arrastar e soltar, ou os botões "Mover para" no painel da vaga, que funcionam pelo teclado) e fica no histórico da vaga. Mover um card para Aplicada conta como "aplicada por você". O card abre um painel lateral com a descrição, o link original, notas editáveis e o histórico. A barra do topo mostra o total de vagas e os contadores de aplicadas (pela IA e por você) e de pendentes ("Precisam de você"); os da IA só saem do zero com a [candidatura automática](#candidatura-automática).

**Saúde das fontes.** Mostra, por fonte, o último run: status (OK, Erro ou Nunca rodou), vagas encontradas, novas, horário e a mensagem de erro. Uma fonte com erro não impede as outras. Se nenhum run termina há mais de 2 horas, a interface avisa que o worker pode estar parado.

## IA de perfil

Opcional. Sem um provedor de IA configurado, nada desta seção acontece e o resto do app funciona igual.

> **Privacidade.** Com um provedor configurado, o texto do seu currículo, o perfil extraído dele e o texto das vagas são enviados a esse provedor (Anthropic, OpenAI ou Google) a cada chamada. O arquivo original do currículo e o perfil ficam guardados só no seu banco. Leia a política de uso de dados do provedor antes de ligar. O que fica guardado e como apagar está em [Seus dados](#seus-dados-o-que-fica-guardado-e-como-apagar).

**O que faz.** Em **Meu perfil** você envia o currículo em português e/ou em inglês. O app lê o texto do arquivo e pede ao modelo um perfil estruturado (contato, resumo, experiências com realizações, formação, habilidades, idiomas, certificações, links), que você revisa e edita; é desse perfil, e não do arquivo, que sai tudo o que a IA escreve depois. Se você só tem o currículo em um idioma, o botão "Gerar por tradução" cria o perfil do outro. Daí em diante há três camadas:

- **Camada 1 (nota).** Toda vaga nova recebe, sozinha, uma nota de 0 a 100 de aderência ao perfil, o idioma da vaga e o título em português. Aparece no card; cada coluna pode ser ordenada por nota.
- **Camada 2 (análise).** Ao abrir a vaga ou movê-la para Selecionadas: tradução da descrição para o português e análise (pontos fortes, lacunas, palavras-chave presentes e ausentes, o que revisar para a entrevista, perguntas prováveis). A IA lê e traduz os primeiros 12 000 caracteres da descrição (quase toda vaga cabe; quando não cabe, a tela avisa que a tradução é parcial). Uma análise que **falhou** não é refeita sozinha quando você abre a vaga de novo ou move o card: o erro fica na tela com o botão "Tentar de novo", porque cada tentativa é uma chamada paga.
- **Camada 3 (currículo adaptado).** O botão "Adaptar currículo" gera uma versão do seu perfil voltada à vaga, no idioma dela, que você revisa, edita e baixa em PDF.

**Como ligar.** Na aba **Configurações**: escolha o provedor, confira os dois modelos (vêm preenchidos com os padrões), abra o bloco do provedor em "Chaves de API", cole a chave e salve; depois salve as configurações e clique em "Testar conexão". Vale na hora, sem reiniciar nada. Para gravar a chave pela tela o servidor precisa da variável `APP_SECRET` (veja [Configurações](#a-aba-configurações)). A alternativa é definir `AI_PROVIDER` e a variável da chave no `.env`.

**Custo.** Cada chamada grava provedor, modelo, camada, tokens e o custo **estimado**; a aba Configurações mostra o gasto de hoje e dos últimos 30 dias por camada, inclusive os testes de conexão e as chamadas que o provedor cobrou e depois falharam. Os preços abaixo estão em `packages/ai/src/config.ts` e são **estimativas lidas em 2026-11-11** nas páginas de preço dos provedores: a fatura do provedor é a verdade.

| Provedor | Modelo rápido (camada 1) | Modelo forte (perfil, camadas 2 e 3) |
|---|---|---|
| Claude (Anthropic) | `claude-haiku-5-5`: US$ 0,10 / 0,50 | `claude-opus-5-5`: US$ 4,00 / 20,00 |
| OpenAI | `gpt-6-luna`: US$ 0,10 / 0,50 | `gpt-6.1-sol`: US$ 2,00 / 10,00 |
| Gemini (Google) | `gemini-3.5-flash-lite`: US$ 0,30 / 2,50 | `gemini-4-carbon`: US$ 4,00 / 20,00 (a partir de 2026-12-01; até 30/11, a metade) |

Preços por milhão de tokens, entrada / saída. **A saída cobrada inclui os tokens de raciocínio**: os modelos dos dois níveis pensam antes de responder (esforço `low` no rápido, `medium` no forte), e esse raciocínio é cobrado como saída mesmo sem aparecer na resposta. Por isso cada chamada tem dois tetos somados: o do texto visível e uma folga de raciocínio (2 000 tokens no nível rápido, 8 000 no forte).

| Chamada | Saída visível (teto) | Raciocínio (teto) | Total cobrável (teto) |
|---|---|---|---|
| Camada 1, lote de 10 vagas | 1 800 | 2 000 | 3 800 |
| Camada 2 | 8 000 | 8 000 | 16 000 |
| Camada 3 (cada chamada) | 6 000 | 8 000 | 14 000 |
| Perfil (ler um currículo ou traduzir um perfil) | 9 000 | 8 000 | 17 000 |

Com os modelos padrão, o custo **típico** e o **pior caso** de cada chamada:

| O que | Claude | OpenAI | Gemini (a partir de 2026-12-01) |
|---|---|---|---|
| Camada 1, por vaga (em lotes de 10): típico | US$ 0,0001 | US$ 0,0001 | US$ 0,0005 |
| Camada 1, por vaga: pior caso | US$ 0,0003 | US$ 0,0003 | US$ 0,0012 |
| Camada 2, vaga em inglês (com a tradução): típico | US$ 0,09 | US$ 0,045 | US$ 0,09 |
| Camada 2, vaga em português: típico | US$ 0,065 | US$ 0,032 | US$ 0,065 |
| Camada 2: pior caso | US$ 0,38 | US$ 0,19 | US$ 0,38 |
| Camada 3, por chamada: típico | US$ 0,07 | US$ 0,035 | US$ 0,07 |
| Camada 3, por chamada: pior caso | US$ 0,35 | US$ 0,17 | US$ 0,35 |
| Perfil, por currículo enviado ou tradução: típico | US$ 0,07 | US$ 0,035 | US$ 0,07 |
| Perfil: pior caso | US$ 0,38 | US$ 0,19 | US$ 0,38 |

Como a conta foi feita (os tetos vêm de `packages/ai/src/limits.ts` e `tasks.ts`; os preços, de `config.ts`):

- **Típico:** perfil de uma página (cerca de 4 000 caracteres de JSON), descrição de vaga de 4 000 caracteres, 3,5 caracteres por token e **cerca de 2 000 tokens de raciocínio** por chamada do nível forte (500 por lote no nível rápido). O raciocínio é uma suposição, não uma medida: ele varia com a vaga e com o modelo, e é a maior parte do custo. Exemplo, camada 2 de uma vaga em inglês no Claude: 2 700 tokens de entrada × US$ 4 + (2 000 visíveis + 2 000 de raciocínio) × US$ 20, por milhão = US$ 0,011 + US$ 0,08.
- **Pior caso:** a maior entrada que a chamada pode enviar (descrição no teto de 12 000 caracteres na camada 2 e 20 000 na camada 3, perfil de 27 000 caracteres, 3 caracteres por token) e a saída **no teto** da tabela acima. Exemplo, camada 2 no Claude: 14 300 × US$ 4 + 16 000 × US$ 20, por milhão = US$ 0,057 + US$ 0,32 = US$ 0,38.
- A camada 3 pode fazer **duas** chamadas (veja "Não inventa"): o pior caso de um currículo adaptado é o dobro da linha da tabela (US$ 0,70 no Claude).
- O Gemini custa a metade do que está na tabela até 2026-11-30.
- **Cache de prompt.** A estimativa cobra toda a entrada pelo preço cheio. Na Anthropic, gravar o prefixo em cache custa 1,25× o preço de entrada e ler custa 0,1×: a primeira chamada de uma sequência sai até uns 25% mais cara **na parte da entrada** do que o estimado (menos de um centavo por chamada do nível forte), e as seguintes, mais baratas. A estimativa **não** tende a errar para mais: o que domina é a saída, e ela é contada como o provedor a informa.
- **Chamadas sem resposta.** Uma chamada abortada por tempo, ou interrompida porque o worker foi encerrado no meio dela, pode ter sido cobrada pelo provedor sem que ele informe o uso. Nesses casos o app grava uma linha **estimada pelo pior caso** (o modelo aparece com o sufixo "(estimativa)" em `ai_usage`), para o limite diário errar para o lado seguro.

Mil vagas novas custam de US$ 0,10 a US$ 0,50 na camada 1, conforme o provedor; o que pesa são as análises e os currículos, que só rodam para as vagas que você abre ou seleciona.

> **Comece com um limite diário baixo** e, depois do primeiro dia de uso, compare o "Gasto estimado" da aba Configurações com a página de uso do próprio provedor. Os números daqui são estimativas; a fatura do provedor é a verdade.

**Limite diário.** Padrão de US$ 1,00 por dia, editável em Configurações (de 0 a 100). Quando o gasto estimado do dia atinge o limite: as notas automáticas (camada 1) pausam até o dia seguinte, e análises, currículos adaptados e leituras de currículo ficam esperando, com um botão "Executar mesmo assim" que vale para aquela execução. Com limite 0, toda chamada pede essa confirmação. O "dia" vira à meia-noite do fuso `AI_BUDGET_TZ` (padrão `America/Sao_Paulo`).

Quanto o limite padrão compra, com o Claude (no OpenAI, o dobro): cerca de **11 análises típicas** de vagas em inglês por dia (15 em português), ou cerca de 14 currículos adaptados. No **pior caso** (US$ 0,37 por análise) são só **2 a 3**: o limite é conferido antes de cada chamada, não durante, então a terceira ainda começa com US$ 0,75 gastos e o dia fecha perto de US$ 1,12. As notas da camada 1 praticamente não pesam nessa conta. Por isso a "análise automática" começa **desligada**: a análise só roda quando você clica em "Analisar esta vaga". Se você ligá-la em Configurações, cada vaga aberta ou movida para Selecionadas pela primeira vez passa a ser uma dessas análises.

**Não inventa.** O currículo adaptado é montado por referência a itens do seu perfil: empresa, cargo, datas, formação, habilidades, idiomas, certificações e links são copiados do perfil pelo servidor; o modelo só reescreve o resumo e as realizações. Antes de qualquer coisa ser gravada, um verificador em código confere o que o modelo devolveu. Se algo diverge, o modelo recebe uma única nova tentativa com a lista do que divergiu; se ainda assim não passar, o resultado é descartado e a tela diz o porquê. Ao editar o texto você mesmo, estrutura e limites continuam bloqueando o salvamento, e o resto vira aviso, porque o autor passa a ser você. O download do PDF confere tudo de novo contra o perfil atual.

O verificador garante ids, campos copiados, limites, números e termos reconhecíveis. Ainda pode passar em texto livre:

1. uma palavra comum em minúsculas que afirme algo que o perfil não diz ("especialista", "fluente", "premiada"), e qualquer afirmação feita só com palavras que já existem no perfil combinadas de outro jeito (por exemplo, atribuir a uma experiência uma tecnologia que o perfil lista em outra);
2. um nome próprio desconhecido escrito todo em minúsculas, ou como primeira palavra de uma frase, quando ele não está na lista interna de nomes conhecidos nem no título ou nas palavras-chave da vaga;
3. números e datas por extenso fora dos cardinais simples;
4. um número que existe no perfil reaproveitado com outro sentido no resumo;
5. nomes de uma letra e letras parecidas fora do conjunto coberto.

Esses casos ficam com o prompt e com a revisão do usuário. **Leia sempre o currículo adaptado inteiro antes de enviá-lo**: a responsabilidade pelo que vai para a empresa é sua.

**Editar o perfil.** O editor manda, ao salvar, a versão do perfil em que as suas alterações se baseiam. Se o perfil mudou no servidor nesse meio-tempo (uma tradução ou a leitura de um currículo terminou, ou outra aba salvou), nada é sobrescrito em silêncio: aparece o aviso "O perfil mudou no servidor", com as opções de recarregar ou de continuar editando e gravar por cima. No sentido inverso, uma tradução ou leitura de currículo que termina depois de você ter editado e salvo o perfil é descartada, e a tela diz por quê.

### Seus dados: o que fica guardado e como apagar

Tudo fica no **seu** banco de dados (o do `DATABASE_URL`), com uma exceção: a candidatura automática também grava arquivos na pasta de dados do seu computador (últimas duas linhas da tabela). O app não tem servidor próprio nem telemetria.

| O que | Onde (tabela) | Como apagar |
|---|---|---|
| Arquivo do currículo como você enviou e o texto lido dele | `resumes` | **Meu perfil**, botão "Apagar" do idioma |
| Perfil estruturado de cada idioma (com as suas edições) | `profiles` | o mesmo botão |
| Currículos adaptados (um por vaga) | `tailored_resumes` | o mesmo botão apaga os escritos naquele idioma |
| Nota, título traduzido, tradução e análise de cada vaga | `job_ai` | "Apagar todos os dados de IA" |
| Fila de tarefas da IA (tipo, estado, mensagem de erro; nunca o texto do currículo) | `ai_tasks` | "Apagar todos os dados de IA"; as terminadas somem sozinhas depois de 30 dias |
| Histórico de gasto: provedor, modelo, camada, tokens e custo estimado de cada chamada | `ai_usage` | não é apagado pela tela: não tem conteúdo pessoal e é o que mantém o limite diário valendo |
| Chaves de API, cifradas | `ai_keys` | aba **Configurações**, "Remover" |
| Candidaturas automáticas: estado, motivo, respostas com a origem, perguntas pendentes, o PDF enviado, o e-mail usado e o texto de confirmação do site | `applications` | "Apagar todos os dados de IA" apaga o conteúdo (respostas, PDF, e-mail, confirmação) e **mantém** a linha com estado, motivo e datas, e a linha do tempo (`application_events`) |
| Suas respostas para formulários (banco de respostas) | `apply_answers` | "Apagar todos os dados de IA", ou uma a uma em **Meu perfil > Respostas para candidaturas** |
| Fotos do formulário preenchido e da confirmação (têm dados pessoais) | arquivos em `shots/` na pasta de dados (`APPLY_DATA_DIR`), não no banco | **não** são apagadas pelos botões acima: apague a pasta `shots/` à mão; o app também remove as com mais de 90 dias |
| Sessão dos sites (cookies) e o resto do perfil do navegador | pasta `browser/` em `APPLY_DATA_DIR`, nunca no banco | "Desconectar" em Configurações apaga os cookies do site; ou apague a pasta |

- **Apagar um idioma** (`DELETE /api/ai/resumes/:lang`) remove o arquivo, o texto lido, o perfil daquele idioma, os currículos adaptados escritos nele e as leituras/traduções de perfil que estejam na fila. As notas e análises das vagas ficam, marcadas como desatualizadas.
- **Apagar todos os dados de IA** (`DELETE /api/ai/data`) remove currículos, perfis, currículos adaptados, notas, títulos traduzidos, análises, a fila inteira, o banco de respostas e o conteúdo das candidaturas automáticas (veja a tabela). Ficam as vagas com as suas anotações, o histórico de gasto, as configurações e as chaves.
- As duas ações pedem confirmação e **não têm volta**. Uma chamada de IA que esteja em andamento termina, mas o resultado dela é descartado.
- O que já foi enviado ao provedor de IA não é apagado por aqui: vale a política de retenção do provedor. O mesmo vale para o que já foi enviado a uma empresa numa candidatura.
- Apagar os dados de IA não toca as fotos nem o perfil do navegador (ficam em disco, fora do banco); veja as duas últimas linhas da tabela.
- A descrição de uma vaga buscada sob demanda (LinkedIn, Indeed) fica na própria vaga e sai com ela.

**Currículo enviado: limites.** PDF ou DOCX, até 5 MB; o tipo é conferido pelo conteúdo do arquivo, não pela extensão. O PDF precisa ter texto selecionável: um currículo escaneado (só imagem) é recusado na hora, com a sugestão de exportar de novo ou enviar um DOCX. Também são recusados: PDF com mais de 30 páginas, arquivo protegido por senha, arquivo que leva mais de 15 s para ser lido e texto com mais de cerca de 6 páginas (o que o modelo lê de uma vez com folga para devolver o perfil). A recusa aparece no próprio cartão do idioma e o currículo anterior continua valendo.

**PDF gerado.** Segue o modelo de currículo do dono: A4 de uma coluna, texto selecionável, sem tabelas nem imagens, na fonte Noto Serif (Regular e Bold) embutida. O cabeçalho traz o nome em caixa alta, o título profissional, a linha de contato (e-mail, telefone, local e os endereços dos links) e um fio; depois vêm, nesta ordem e só as que tiverem conteúdo, Resumo profissional, Competências técnicas (em grupos, "Grupo: item, item"), Experiência profissional, Experiências complementares, Formação acadêmica, Idiomas e Certificações. Cada experiência mostra "Cargo - Empresa", período, local e nota, e as realizações com marcador e recuo. Toda página leva no rodapé o nome e o número da página. Um perfil gravado antes desse modelo continua gerando PDF, sem título, grupos nem nota; ele os ganha ao reenviar o currículo ou ao editar o perfil em "Meu perfil". Ela desenha o alfabeto latino com todos os acentos (português, espanhol, francês, alemão, polonês, tcheco, turco...), vietnamita, cirílico e grego. Não desenha chinês, japonês, coreano, árabe, hebraico, devanágari, emoji nem símbolos como "✓": se o currículo tiver um desses caracteres, o editor avisa quais são e o download só é liberado depois de trocá-los, em vez de gerar um PDF com buracos no texto.

**Fila.** A IA roda no worker, em uma fila separada da busca de vagas: até 2 chamadas ao mesmo tempo, 3 tentativas com espera de 30 s e 120 s (o dobro em limite de taxa). Erro que repetir não resolve (resposta cortada, recusa do modelo, rascunho barrado pelo verificador, dado que falta) não é repetido. Lentidão ou falha do provedor não atrasa a busca. Nenhuma chamada de IA acontece dentro de uma requisição da API, exceto o "Testar conexão".

- **Provedor indisponível não queima as vagas.** Se a triagem (camada 1) bate em chave recusada, conta sem crédito, modelo inexistente ou limite de taxa que não passa, nenhuma vaga é marcada com erro: as tarefas esperam (30 min; 15 min no limite de taxa) e são tentadas de novo sozinhas, e o quadro e a aba Configurações mostram o aviso "As notas automáticas estão em pausa" com o motivo. Gravar uma chave, trocar o provedor ou o modelo, ou um "Testar conexão" que funcione retoma na hora.
- **Uma vaga problemática não derruba as vizinhas.** Quando um lote de 10 vagas falha inteiro por causa do conteúdo (o modelo recusou, cortou ou devolveu algo inválido), as vagas são refeitas uma a uma, respeitando o limite diário, e só a que falha sozinha fica com erro.
- **Erro na nota não é para sempre.** Uma vaga cuja nota falhou volta para a fila sozinha depois de 6 horas, no máximo 3 vezes (4 falhas em 30 dias); pelo painel da vaga, "Tentar de novo" vale na hora.
- **Tempo limite.** O SDK corta uma chamada do nível rápido em 120 s e uma do forte em 480 s (o teto de 17 000 tokens a 40 tokens por segundo, com folga); a fila corta um pouco depois (150 s na camada 1, 540 s na camada 2, 510 s no perfil, 1 020 s na camada 3, que pode fazer duas chamadas). No Claude, as chamadas do nível forte usam *streaming*, para uma geração longa não ficar em uma conexão sem tráfego; no OpenAI e no Gemini a resposta vem de uma vez. Uma chamada do nível forte que estoura o tempo ganha **uma** nova tentativa, não duas.
- **Reinício do worker.** Uma tarefa que estava em execução quando o worker foi encerrado conta a tentativa interrompida (uma tarefa que derruba o processo toda vez para na terceira) e grava o uso estimado da chamada perdida.
- **Limpeza.** Tarefas terminadas há mais de 30 dias são apagadas da fila.

**Descrições do LinkedIn e do Indeed.** Essas duas fontes não entregam a descrição na busca; ela é buscada só quando a vaga é analisada, uma por vez, sem login. Limites conhecidos:

- Os leitores dessas duas páginas foram escritos contra páginas **sintéticas**, montadas a partir do que se conhece do layout: daqui desta rede o LinkedIn respondeu HTTP 429 a todas as tentativas e o Indeed bloqueia navegador sem janela. **Eles não foram verificados contra páginas reais** e podem não achar a descrição.
- O Indeed precisa do Chromium com janela (`INDEED_HEADFUL=1`) e não funciona no container.
- Quando a descrição não vem, a análise usa só título, empresa e local, e a tela avisa.

**Conferir os provedores de verdade.** `pnpm ai:smoke -- --yes [anthropic|openai|gemini]` roda uma vez cada camada em cada provedor que tiver chave, com um currículo e uma vaga fictícios, e imprime a saída, os tokens e o custo estimado. **Ele faz chamadas reais e gasta dinheiro de verdade** (centavos de dólar por provedor); por isso se recusa a rodar sem `--yes` e sempre que a variável `CI` está definida, e não é chamado por nenhum teste. Usa a chave do ambiente ou a gravada pela tela (com `DATABASE_URL` e `APP_SECRET` definidos).

## Candidatura automática

Opcional e **desligada por padrão**. Ela depende da [IA de perfil](#ia-de-perfil) (precisa do provedor configurado e do seu perfil) e roda no worker, então o worker precisa estar ligado.

> **Leia antes de ligar.**
>
> - **É em seu nome.** Com o site em modo Enviar, o app envia candidaturas reais, com o seu nome, e-mail, telefone e currículo, e respostas que você não leu antes (as que a regra ou o modo Automático dão). Enviar não tem volta.
> - **Sites de vagas costumam proibir automação.** Os termos do LinkedIn, por exemplo, proíbem. A conta usada pode ser limitada ou bloqueada, e o app não disfarça o navegador nem tenta parecer humano; só respeita limites e intervalos. Use por sua conta e risco.
> - **O app não tem login.** Quem alcançar o app pode disparar candidaturas com as contas que estiverem abertas no navegador dele e ler as suas respostas. Por isso a função só liga quando o app está em endereço local (`HOST` ausente, `127.0.0.1`, `localhost` ou `::1`), e **não deve rodar em container nem atrás de um endereço público**. Em outro `HOST`, a tela de Configurações mostra o motivo e bloqueia as opções.
> - **Quem confere é você.** As conferências do app são regras e verificadores em código, não uma pessoa; leia os ensaios antes de passar um site para Enviar.

### O que faz

1. **Escolhe as vagas.** A cada 5 minutos, dentro do horário, o worker procura vagas em **Descobertas** com nota da camada 1 igual ou acima do mínimo (padrão 70), descobertas há até 14 dias, de um site suportado e sem candidatura anterior. A de nota mais alta vem primeiro. Há também o botão **"Aplicar com IA"** no painel da vaga, para qualquer vaga de um site suportado, seja qual for a nota.
2. **Confere a vaga.** Busca a descrição se faltar (sem entrar em conta nenhuma), pede ao modelo rápido uma nota nova com a descrição inteira e um aviso de requisito que exclui você (país, visto, idioma). Nota abaixo do mínimo, requisito que exclui ou empresa na lista de bloqueio: a candidatura é **pulada**, com o motivo, e o card fica onde está. Passando, o card vai de Descobertas para Selecionadas.
3. **Prepara o currículo.** Padrão "Adaptado à vaga": reaproveita ou gera o currículo adaptado da camada 3, com o mesmo verificador de não invenção; se o rascunho for barrado, a candidatura para em "precisa de você". A outra opção, "Currículo base", envia o perfil como está, sem chamar o modelo. O arquivo se chama `Curriculo_<Nome>_<Empresa>.pdf` (ou `Resume_...`, se a vaga é em inglês).
4. **Abre o formulário e responde.** As respostas vêm das regras, das suas respostas salvas e, conforme a sua escolha, da IA (veja [Quem responde o quê](#quem-responde-o-quê)). Faltando resposta a uma pergunta **obrigatória**, nada é enviado: a candidatura para em "precisa de você". Pergunta opcional sem resposta fica em branco.
5. **Ensaia ou envia**, conforme o modo do site (veja [Ensaio e Enviar](#ensaio-e-enviar)). Enviada e confirmada pelo site, o card vai para Aplicada, marcado "aplicada pela IA". A IA nunca move um card além de Aplicada.

Se você mover o card por conta própria, a candidatura que estava na fila é cancelada; uma em andamento é parada no próximo ponto seguro. Uma vaga de site não suportado fica no quadro como sempre, sem candidatura nem selo.

### Como ligar

1. Configure a IA e envie o seu currículo (veja [IA de perfil](#ia-de-perfil)). Opcional, mas vale a pena: preencha em **Meu perfil** o bloco "Respostas para candidaturas" (pretensão salarial, visto, disponibilidade...).
2. Tenha Chrome ou Edge instalado, ou aponte `APPLY_BROWSER` para outro navegador (veja [Navegador e contas](#navegador-e-contas)).
3. Em **Configurações > Candidatura automática**: ligue o interruptor, confira a nota mínima, os limites, o horário e a **lista de bloqueio** (o app sugere a sua empresa atual na primeira vez), escolha o currículo (adaptado ou base) e as "Respostas propostas pela IA". Cada site começa em **Ensaio**.
4. Nos sites com login, abra a conta uma vez (veja [Navegador e contas](#navegador-e-contas)).
5. Deixe tudo em Ensaio por alguns dias. Quando os ensaios estiverem certos, troque cada site para **Enviar**. A tela pede uma confirmação nessa troca.

Com a função ligada, a aba **Candidaturas** lista tudo (em andamento, precisam de você, ensaios prontos, enviadas, não enviadas), os cards ganham os selos "IA aplicando", "ensaio pronto", "precisa de você" e "aplicada pela IA", e o contador **"Precisam de você"** da barra do topo abre a lista filtrada. O painel de cada vaga tem uma seção "Candidatura" com o estado, a linha do tempo, as perguntas com as respostas e a origem de cada uma, o PDF que vai (ou foi) junto e fotos do formulário.

### Ensaio e Enviar

- **Ensaio** (o padrão de todo site): o app faz tudo, fotografa o formulário preenchido, **não clica no envio** e fecha o formulário sem deixar rascunho. O resultado é "Ensaio pronto", com as respostas, o PDF e a foto no painel da vaga.
- **Enviar:** o app clica no envio final.
- **O modo do site é lido quando cada candidatura começa.** Voltar um site para Ensaio faz as que ainda estão na fila ensaiarem em vez de enviar. A exceção são as que você mesmo mandou com "Enviar de verdade": aquele clique foi uma decisão sua sobre aquela candidatura. Passar o site para Enviar **não** dispara os ensaios que já estavam prontos: cada um precisa do "Enviar de verdade", e a aba Candidaturas tem "Enviar todos os ensaios" (com confirmação).
- **"Enviar de verdade" envia exatamente as respostas do ensaio que você viu**, com o mesmo PDF. Se o formulário ganhou uma pergunta obrigatória desde então, o app não envia: faz um ensaio novo para você ver.

### Quem responde o quê

Cada campo do formulário é classificado por regras de texto e, quando elas não decidem, pelo modelo rápido. Padrões sensíveis (salário, visto, antecedentes, deficiência, em português e em inglês) valem mais do que o que o modelo disser, e na dúvida a pergunta é tratada como pessoal.

**Por regra, sem perguntar a você:**

- nome, e-mail e telefone, do perfil;
- o arquivo do currículo;
- "onde você viu a vaga?": o nome da fonte da vaga;
- "já trabalhou nesta empresa?", **só** como "Não" e **só** quando nenhuma empresa do seu perfil tem uma palavra significativa em comum com a da vaga; do contrário a pergunta vai direto para você;
- **consentimento, só para**: a política ou o aviso de privacidade, os termos de uso, o tratamento de dados pessoais para a candidatura e a veracidade das informações. Qualquer outro compromisso ("concordo em não me candidatar a outra vaga da empresa", por exemplo) vai para você;
- perguntas demográficas (gênero, raça, deficiência, veterano): opcional fica em branco; obrigatória recebe "prefiro não informar" se a opção existir, e senão vai para as suas respostas salvas e, faltando, para você.

**Sempre de você, nunca da IA, em qualquer modo:** as perguntas **pessoais** (pretensão salarial, visto e autorização de trabalho, disponibilidade, mudança de cidade, antecedentes, referências...) e as demográficas. Essas respostas vêm de **Meu perfil > Respostas para candidaturas** e do que você responder na aba Candidaturas. Quando uma candidatura para numa pergunta, você responde ali, escolhe o alcance (sempre, só nesta empresa ou só nesta vaga) e ela volta para a fila sozinha; a resposta fica salva e vale para as próximas. Visto e autorização de trabalho são guardados por país.

**Respostas propostas pela IA** (fatos do seu perfil, como "anos de experiência com TypeScript", e textos abertos, como "por que você quer trabalhar aqui?"). Em Configurações, "Respostas propostas pela IA" tem três modos:

| Modo | O que acontece |
|---|---|
| Desligado | A IA não propõe resposta nenhuma. Respondem só as regras e as suas respostas salvas; o resto vai para você. (O modelo ainda pode ser usado para classificar uma pergunta e para sugerir que uma resposta salva serve a ela, e essa sugestão sempre volta a você para confirmar.) |
| Com a sua aprovação (padrão) | A IA propõe e a candidatura para com a proposta na tela. Você aprova (ou edita) uma vez e a resposta é salva. Fato do perfil aprovado vale daí em diante para qualquer vaga; texto escrito vale só para aquela vaga. |
| Automático | A proposta que passou na conferência é usada sem você ver antes. |

Em qualquer modo, a IA só escreve resposta aberta para pergunta **obrigatória**; a opcional fica em branco. A proposta de que uma resposta que você já salvou "é a mesma pergunta" também sempre volta a você para confirmar uma vez; confirmada, aquele texto passa a casar sozinho.

> **Limites do modo Automático.** A conferência de uma resposta da IA compara o **texto** dela com o seu perfil: ela pode deixar passar exageros e respostas fora de contexto. Alguns limites que o código impõe: anos de experiência são **arredondados para baixo** (5 anos e 4 meses viram 5) e não passam do tempo coberto pelas experiências citadas; a IA **nunca envia uma negação** ("não", "nenhum", zero), que vai para você; uma resposta de lista precisa ser uma das opções do formulário; um texto aberto passa pelo verificador de não invenção (números e nomes precisam estar no perfil ou na vaga) e respeita o tamanho do campo, com uma tentativa de correção. O que não passa vira pergunta para você. Prefira "Com a sua aprovação" até confiar no resultado.

Os rótulos e as opções de um formulário são conteúdo de terceiros: vão ao modelo como dados, com a instrução de ignorar comandos escritos neles, e o modelo nunca decide navegação nem recebe endereço para visitar.

### Limites, ritmo e horário

| O quê | Padrão | Ajustável |
|---|---|---|
| Candidaturas por dia, LinkedIn | 10 | sim |
| Vagas abertas na sessão do LinkedIn por dia | 30 | sim |
| Candidaturas por dia, Greenhouse e Lever | 15 cada | sim |
| Total por dia | 30 | sim |
| Por empresa, a cada 30 dias | 2 | sim (o número) |
| Horário | 08:00 às 21:00 | sim |
| Nota mínima | 70 | sim |
| Intervalo entre candidaturas, LinkedIn | 3 a 8 min, sorteado | não |
| Intervalo nos demais sites | 1 a 3 min, sorteado | não |

- O limite do dia conta **formulários abertos**, seja envio ou ensaio.
- O botão "Aplicar com IA" dispensa a nota mínima, a conferência, a idade da vaga, o limite por empresa e o horário. Continuam valendo a lista de bloqueio, os limites diários do site e a regra de **um envio por vaga**.
- **Lista de bloqueio** (empresas e termos, em Configurações). A empresa é comparada por **palavras inteiras, nos dois sentidos**: bloqueia quando o nome da empresa da vaga contém uma entrada ou quando uma entrada contém o nome da empresa (sem diferença de maiúsculas e acento, e sem "Ltda", "S.A.", "Inc" e parecidos no fim). "Acme" bloqueia "Acme Pagamentos", e uma entrada "Banco Alfa" bloqueia uma empresa chamada só "Alfa". **Uma palavra curta e comum na lista bloqueia mais do que parece**: "Tech", "Group" ou "Brasil" pegam todas as empresas com essa palavra no nome. Os termos são procurados, também por palavras inteiras, no título e na descrição. Vale para candidaturas automáticas e para "Aplicar com IA".
- **Limite diário de IA.** O limite de gasto da IA (veja [IA de perfil](#ia-de-perfil)) vale para toda candidatura, as manuais também. Atingido, a fila espera o dia seguinte; **não há "Executar mesmo assim"** aqui.
- **Freio por site.** Três formulários não reconhecidos em seguida, três envios que o site não confirmou em seguida ou qualquer página de restrição, verificação de conta ou "atividade incomum" pausam aquele site até você clicar em **Retomar** em Configurações. Se você não aparecer em duas esperas seguidas por captcha ou código, o site fica em "aguardando você" e as candidaturas dele esperam, sem travar os outros sites.
- Erro passageiro (rede, página lenta) tem duas novas tentativas, em 5 e em 30 minutos; depois a candidatura vira "falhou".

### Estados e o que fazer

| Estado | O que significa | O que você faz |
|---|---|---|
| Na fila, preparando, preenchendo | Em andamento | Nada |
| Aguardando você | A janela do navegador está esperando um captcha, um código de verificação ou um login | Resolva na janela (veja abaixo) |
| Ensaio pronto | Preenchida, não enviada | Confira e use "Enviar de verdade", ou cancele |
| Precisa de você | Parou: pergunta sem resposta, resposta proposta a aprovar, correspondência a confirmar, currículo barrado, formulário que o app não reconhece, sessão que caiu... O motivo aparece no painel da vaga | Responda na aba Candidaturas ou resolva o que o motivo pede; "Tentar de novo" vale onde aparece |
| **Confirme no site** | O app clicou no envio final e o site **não confirmou** (erro, captcha que apareceu depois do clique e não foi resolvido, cancelamento nesse momento, queda do worker) | Veja no site ou no seu e-mail se a candidatura chegou. Se chegou, "Já apliquei por conta própria" move o card para Aplicada; se não, cancele |
| Enviada | O site confirmou | Nada |
| Pulada | Não era para aplicar; o motivo diz por quê (nota, requisito, bloqueio, vaga encerrada, site externo, já aplicada) | Nada |
| Falhou, cancelada | Erro depois das tentativas, ou cancelada por você | "Tentar de novo", se quiser |

**"Confirme no site" é o único estado sem "Tentar de novo".** Depois do clique final ninguém consegue saber se o site recebeu a candidatura, e o app **nunca clica de novo** depois de um clique: no máximo uma candidatura é enviada por vaga, mesmo que o worker caia no meio do envio.

**Esperas ao vivo.** Captcha, código de verificação e login o app **nunca** resolve. A janela do navegador vem para a frente, a aba Candidaturas avisa (e, se você permitir, o navegador também) e o app espera por até **10 minutos**. Resolvido, continua do ponto em que parou; estourado o prazo, a candidatura vira "precisa de você". Depois de "Abrir para fazer login", em Configurações, a janela também fica aberta por até 10 minutos. Enquanto ela está nessa espera, nenhuma candidatura começa naquele site.

### Navegador e contas

- O app usa um navegador **com janela**, no seu computador, com um perfil próprio guardado na pasta de dados (`APPLY_DATA_DIR`): `%LOCALAPPDATA%\kanban-vagas` no Windows, `~/Library/Application Support/kanban-vagas` no macOS e `${XDG_DATA_HOME:-~/.local/share}/kanban-vagas` nos demais. Ele **não** usa o perfil do seu navegador do dia a dia: as contas dos sites são abertas nesse perfil à parte.
- **`APPLY_BROWSER`** escolhe o navegador: um canal instalado (`chrome` ou `msedge`) ou o **caminho completo** do executável de um navegador baseado em Chromium (o `opera.exe` do Opera GX, por exemplo). Sem a variável, o app procura o Chrome e depois o Edge nos lugares padrão. Sem navegador utilizável, nada começa e a tela diz o que fazer.
- Para os sites com login, **Configurações > Candidatura automática** mostra o estado da conta e os botões "Abrir para fazer login", "Verificar" e "Desconectar". **Você digita a senha na página do próprio site; o app nunca a lê nem a guarda.** A sessão fica só no perfil do navegador, no seu disco; nunca vai para o banco nem para o log. "Desconectar" remove os cookies daquele site desse perfil.
- A janela fecha depois de 5 minutos sem uso.

### Custo

Estimativas com os modelos padrão do Claude, **a medir no uso real**; a fatura do provedor é a verdade. Todas as chamadas da candidatura entram no gasto em uma camada própria, "Candidatura", em Configurações.

| Etapa | Modelo | Custo típico |
|---|---|---|
| Conferência da nota | rápido | menos de US$ 0,01 |
| Classificar e responder perguntas | rápido | menos de US$ 0,01 |
| Resposta aberta, quando há | forte | US$ 0,03 a 0,07 |
| Currículo adaptado | forte | US$ 0,07 (até US$ 0,70 no pior caso, com a correção) |

Uma candidatura típica custa perto de US$ 0,08; com o limite padrão de US$ 1,00 por dia, cabem cerca de 10 por dia. Com o "Currículo base", o custo cai para centavos. O limite diário é o da IA de perfil: ele soma tudo.

### O que fica guardado

Veja a tabela de [Seus dados](#seus-dados-o-que-fica-guardado-e-como-apagar). Em resumo: o banco guarda as candidaturas (estado, motivo, respostas com a origem, o PDF exato enviado, o e-mail usado, o texto de confirmação do site e a linha do tempo) e as suas respostas salvas; as **fotos** do formulário (que têm dados pessoais) ficam na pasta de dados do app; a sessão dos sites fica só no perfil do navegador.

### Sites suportados

| Site | Login | Como o app acha o formulário | Observações |
| --- | --- | --- | --- |
| Greenhouse | não | pelo endereço da vaga (`job-boards.greenhouse.io/<empresa>/jobs/<id>`) ou pelo `gh_jid` de uma vaga cuja fonte é o Greenhouse | o formulário é lido pela API pública do Greenhouse e preenchido na página |
| Lever | não | pelo endereço `jobs.lever.co/<empresa>/<id>` | o formulário é lido e preenchido na página; `jobs.eu.lever.co` fica de fora |
| LinkedIn | sim, pelo dono, na janela | pelo endereço da vaga no LinkedIn | previsto para esta versão, mas **ainda não disponível**: depende de uma gravação com a sua conta |

- **Greenhouse:** vale o endereço no domínio do Greenhouse, ou uma vaga da fonte Greenhouse cujo endereço traz `gh_jid` igual ao número da vaga. Vaga do Greenhouse publicada no domínio da própria empresa, sem `gh_jid`, não é suportada.
- **Lever:** vale só `jobs.lever.co/<empresa>/<id>`, com ou sem `/apply`. No ensaio o Lever recebe o arquivo do currículo.
- **LinkedIn:** só a candidatura simplificada dentro do próprio LinkedIn; o link externo da vaga não é seguido. Cada candidatura envia um PDF novo, que fica na lista de currículos recentes da conta.
- Captcha é detectado e nunca resolvido: a janela fica aberta esperando você.

### Conferir um site de verdade

```bash
pnpm apply:smoke -- --site <linkedin|greenhouse|lever> --job <endereço da vaga> [--resume <pdf>]
```

> **Este comando abre o formulário de uma empresa de verdade.** Ele digita o seu nome, e-mail e telefone reais nos campos e anexa o PDF do seu currículo, sem nunca enviar a candidatura. Mesmo sem o envio, **o Lever pode ler o arquivo anexado antes de qualquer clique de envio**. Use só numa vaga em que você aceita isso.

Ele abre a vaga com janela, preenche como o worker faria e fotografa a página inteira. Sempre roda em ensaio: não tem opção de envio e nunca clica em enviar. Recusa rodar na CI. Imprime as perguntas e as respostas, com a origem de cada uma, e grava a foto em `<pasta de dados>/smoke/`, fora do repositório.

- **Com um provedor de IA configurado** (e o limite diário de IA ainda não atingido), o que a IA proporia aparece como **proposta que aguarda aprovação** e **não é digitado**; as chamadas são pagas e entram na camada "Candidatura". **Sem provedor** (ou com o limite atingido), só as regras e as respostas salvas respondem. A primeira linha impressa diz qual é o caso.
- A vaga do ensaio é montada só pelo endereço. Num endereço do Greenhouse no domínio da empresa, o número vem do `gh_jid` e o nome da empresa é o melhor palpite (o nome do quadro ou do domínio): **respostas salvas só para uma empresa podem não valer num ensaio por endereço**.

### Quando um site muda de layout

A candidatura para em "formulário não reconhecido", com a foto. Grave de novo as páginas com `pnpm apply:fixtures` (veja [Páginas gravadas dos testes](#páginas-gravadas-dos-testes); no LinkedIn, você repete a gravação e a limpeza), corrija o roteiro do site e rode `pnpm test:browser` até voltar a passar.

### Páginas gravadas dos testes

Os testes dos roteiros de site usam páginas gravadas de formulários reais, servidas localmente; nenhum teste automatizado acessa um site real. Essas páginas gravadas **ficam só na sua máquina** (não vão para o repositório, porque podem trazer dados pessoais) e são gravadas de novo com `pnpm apply:fixtures`. Com `FAKE_APPLY_SITE=1` o app usa um site de teste local no lugar dos sites reais (é o que o `pnpm e2e` usa).

## A aba Configurações

**O que tem.** IA: provedor, modelo rápido e modelo forte, chave de API por provedor, limite diário, liga/desliga da triagem automática (camada 1) e da análise automática (camada 2), "Testar conexão" e o gasto. Fontes: as empresas consultadas no Greenhouse e no Lever. Candidatura automática: interruptor, nota mínima, modo de cada site (Ensaio ou Enviar), limites, horário, currículo, respostas propostas pela IA, lista de bloqueio e contas dos sites (veja [Candidatura automática](#candidatura-automática)). Geral: estado do worker e horário da próxima busca. Com a triagem automática desligada, a nota só é calculada quando você abre a vaga; com a análise automática desligada, a análise só roda pelo botão "Analisar esta vaga".

**Precedência.** Para cada configuração vale, nesta ordem: o que foi gravado pela tela, depois a variável de ambiente, depois o padrão do código. A tela mostra de onde vem cada valor ("definido aqui", "do ambiente", "padrão"). API e worker releem o banco com um cache de 5 segundos: uma mudança vale em instantes, nos dois processos, sem reiniciar.

**Chave de API.** Fica cifrada no banco (AES-256-GCM, com chave derivada de `APP_SECRET`) e é **só de escrita**: nenhuma rota a devolve. Depois de salva, a tela mostra apenas o provedor, os quatro últimos caracteres e a data. Há uma chave por provedor; trocar de provedor não apaga as outras, e remover uma chave pede confirmação. A chave não aparece em log, em mensagem de erro nem no registro de uso. Se a variável de ambiente do provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` ou `GEMINI_API_KEY`) estiver definida, ela tem prioridade e a tela mostra "definida pelo ambiente", sem campo para editar.

**`APP_SECRET`.** É o segredo do servidor que cifra as chaves gravadas. Gere um, uma vez:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

e coloque o valor em `APP_SECRET` no `.env` (ou nas variáveis do serviço, em produção). Precisa ter 32 caracteres ou mais.

- **Sem ela:** gravar chave pela tela fica desabilitado, com a instrução na própria tela; todo o resto funciona, inclusive a IA com a chave vinda do ambiente.
- **Se ela for perdida ou trocada:** as chaves já gravadas deixam de decifrar e **não há como recuperá-las**. A tela marca cada uma como "não decifra", a IA volta a "não configurada" e as tarefas ficam paradas na fila (sem virar erro) até você colar as chaves de novo. Guarde o segredo como guarda uma senha, junto do backup do banco mas fora dele.

**"Testar conexão".** Faz uma chamada mínima no modelo rápido e diz se funcionou, se a chave é inválida, se o modelo não existe, se a conta está sem crédito ou se houve erro de rede. Custa uma fração de centavo, entra no gasto e é limitado a 1 teste a cada 10 s e 5 a cada 10 min.

> **O app não tem login.** Quem conseguir abrir o app pode trocar o provedor, mudar os modelos e o limite e **gastar a chave gravada** (não consegue lê-la), além de ler o seu currículo e as suas vagas. Com uma chave gravada, deixar o app em uma URL pública é risco financeiro direto. **Não o exponha publicamente.**

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
- **Greenhouse e Lever** consultam uma lista configurável de empresas, editável na aba Configurações (ou, como valor inicial, em `GREENHOUSE_BOARDS` e `LEVER_COMPANIES`). Os padrões estão na tabela de configuração; empresas que não existem nessas plataformas são ignoradas desde que ao menos uma responda.
- **LinkedIn e Indeed** leem páginas públicas, sem usar sua conta. Não há API oficial: eles podem quebrar ou ser bloqueados a qualquer momento, e o acesso automatizado pode contrariar os termos desses sites. Use por sua conta e risco. Os cards dessas duas fontes vêm sem texto de descrição; com a IA configurada, a descrição é buscada quando a vaga é analisada (com os limites descritos em [IA de perfil](#ia-de-perfil)).
- **Indeed** é bloqueado quando o Chromium roda sem janela (headless). Só funciona com `INDEED_HEADFUL=1` no `.env` (abre uma janela de navegador visível a cada busca), depois de instalar o Chromium do Playwright: `pnpm --filter @kv/connectors exec playwright install chromium`. Sem isso, o run termina em erro e aparece na tela de saúde das fontes.

## Configuração

Variáveis lidas pelo código. API, worker e `pnpm db:migrate` leem o `.env` da raiz do repo; variáveis já definidas no ambiente do processo têm precedência sobre as do arquivo. O `.env.example` traz todas, comentadas.

As marcadas com (*) são só o **valor inicial**: podem ser trocadas na aba Configurações, e o que for gravado lá passa a valer (tela > variável de ambiente > padrão do código).

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | nenhum (obrigatória) | Connection string do Postgres. Sem ela, API, worker e migrations não sobem |
| `PGSSLMODE` | nenhum | Modo de TLS da conexão, lido pelo driver do Postgres quando a URL não traz `sslmode`; definida, desliga o TLS automático para hosts não locais (veja "Usar o Supabase") |
| `API_PORT` | `3333` | Porta da API. O proxy do Vite só enxerga a variável se ela estiver no ambiente do shell, não só no `.env` |
| `PORT` | nenhum | Porta da API em plataformas que a injetam (Railway); tem precedência sobre `API_PORT` |
| `HOST` | `127.0.0.1` | Endereço em que a API escuta; o container usa `0.0.0.0`. A [candidatura automática](#candidatura-automática) só funciona com `HOST` ausente, `127.0.0.1`, `localhost` ou `::1` |
| `ALLOWED_HOSTS` | nenhum | Nomes de host aceitos no cabeçalho `Host` além de `localhost`, `host.docker.internal` e de qualquer IP, separados por vírgula (`kanban.exemplo.com,outro.exemplo.com`; porta e esquema são ignorados). Qualquer outro `Host` recebe 403 (proteção contra DNS rebinding). No Railway, o domínio do serviço e `healthcheck.railway.app` entram sozinhos |
| `WEB_DIST` | `apps/web/dist` | Diretório do web buildado que a API serve, quando tem `index.html` |
| `GREENHOUSE_BOARDS` (*) | `gitlab,stripe,cloudflare,figma` | Boards do Greenhouse, separados por vírgula |
| `LEVER_COMPANIES` (*) | `palantir,spotify` | Empresas do Lever, separadas por vírgula |
| `FAKE_CONNECTORS` | desligado | `1` troca todas as fontes por uma fonte falsa e determinística (testes e2e, sem rede) |
| `INDEED_HEADFUL` | desligado | `1` abre o Chromium do Indeed com janela visível |
| `APP_SECRET` | nenhum | Segredo que cifra as chaves de API gravadas pela tela; 32 caracteres ou mais. Sem ele, só dá para usar chave por variável de ambiente. Trocá-lo invalida as chaves gravadas |
| `AI_PROVIDER` (*) | nenhum (IA desligada) | `anthropic`, `openai` ou `gemini`; `fake` é o provedor falso dos testes |
| `ANTHROPIC_API_KEY` | nenhum | Chave da Anthropic. Definida, tem prioridade sobre a gravada pela tela e não pode ser editada lá |
| `OPENAI_API_KEY` | nenhum | Chave da OpenAI; mesma regra |
| `GEMINI_API_KEY` | nenhum | Chave do Gemini; mesma regra |
| `AI_MODEL_FAST` (*) | conforme o provedor | Modelo da camada 1 (triagem em volume) |
| `AI_MODEL_STRONG` (*) | conforme o provedor | Modelo do perfil, da análise e do currículo adaptado |
| `AI_DAILY_BUDGET_USD` (*) | `1.00` | Limite de gasto estimado por dia, em dólares |
| `AI_BUDGET_TZ` | `America/Sao_Paulo` | Fuso que define o "dia" do limite. Só por variável de ambiente |
| `AI_ALLOW_FAKE` | desligado | Só testes: `1` acrescenta o provedor falso (sem rede, sem custo) às opções da aba Configurações |
| `APPLY_DATA_DIR` | `%LOCALAPPDATA%\kanban-vagas` (Windows), `~/Library/Application Support/kanban-vagas` (macOS), `${XDG_DATA_HOME:-~/.local/share}/kanban-vagas` (demais) | Pasta de dados da candidatura automática: perfil do navegador (`browser/`, com as sessões dos sites) e fotos dos formulários (`shots/`). Fica fora do repositório. Só por variável de ambiente |
| `APPLY_BROWSER` | procura Chrome e depois Edge | Navegador da candidatura automática: `chrome`, `msedge` ou o caminho completo do executável de um navegador baseado em Chromium (`opera.exe` do Opera GX, por exemplo). Só por variável de ambiente |
| `FAKE_APPLY_SITE` | desligado | `1` troca os sites de candidatura por um site de teste local (testes e e2e, sem rede) |
| `E2E_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/kanban_e2e` | Só no `pnpm e2e`. O nome do banco precisa terminar em `_e2e` ou `_test` |
| `E2E_SCREENSHOT_DIR` | desligado | Só no `pnpm e2e`: pasta onde o teste grava screenshots |
| `CI` | desligado | No `pnpm e2e`: com `CI` definida, o Playwright gera relatório HTML e proíbe `test.only`. No `pnpm ai:smoke`: com `CI` definida, ele se recusa a rodar |

A triagem automática e a análise automática (os dois interruptores da aba Configurações) não têm variável de ambiente e só mudam pela tela: a triagem começa ligada (custa quase nada por vaga) e a análise automática começa desligada (usa o modelo forte).

## Desenvolvimento

```bash
pnpm test           # testes unitários (Vitest)
pnpm typecheck      # tsc --noEmit em todos os pacotes
pnpm e2e            # teste de ponta a ponta (Playwright)
pnpm db:generate    # gera uma migration a partir de packages/db/src/schema.ts
pnpm db:migrate     # aplica as migrations pendentes no DATABASE_URL
pnpm start:prod     # migra e sobe api + worker como em produção (veja "Deploy")
pnpm ai:smoke -- --yes [provedor]   # ATENÇÃO: chamadas reais aos provedores de IA, gasta dinheiro
pnpm resume:preview   # gera o PDF do seu perfil em uma pasta fora do repositório
pnpm apply:smoke -- --site <id> --job <url>   # ATENÇÃO: abre um formulário real, em ensaio; nunca envia
```

- Os testes unitários não usam rede nem Docker: o banco é um Postgres em memória (PGlite) e as fontes são testadas contra fixtures gravadas.
- **Nenhum teste automatizado chama um provedor de IA de verdade nem usa chave real:** os adaptadores dos três provedores são testados com uma camada HTTP falsa e respostas escritas à mão, e todo o resto (inclusive o e2e) usa o provedor falso, que não usa rede.
- O `pnpm ai:smoke` é o único comando que fala com os provedores reais. Ele gasta dinheiro de verdade, nunca roda na CI nem em teste, e só roda com `--yes` (veja [IA de perfil](#ia-de-perfil)).
- O `pnpm e2e` precisa do Postgres do compose no ar (`docker compose up -d`) e do Chromium do Playwright (`pnpm --filter @kv/web exec playwright install chromium`, uma vez). Ele cria o banco `kanban_e2e` se não existir, esvazia as tabelas a cada execução e sobe seu próprio `pnpm dev` com `FAKE_CONNECTORS=1`, `AI_ALLOW_FAKE=1` e um `APP_SECRET` sorteado na hora, então as portas 5173 e 3333 precisam estar livres (pare o seu `pnpm dev`). São dois testes, em sequência: o do quadro e o da IA de perfil, que configura o provedor falso pela aba Configurações, grava uma chave fictícia, envia um currículo fictício e baixa o PDF adaptado. O banco `kanban` de desenvolvimento não é tocado, e as chaves do seu `.env` são ignoradas.
- Mudou o schema? Edite `packages/db/src/schema.ts`, rode `pnpm db:generate`, revise o SQL gerado em `packages/db/migrations` e aplique com `pnpm db:migrate`. Tabelas novas usam `.enableRLS()` para manter o RLS habilitado.

Estrutura:

```
apps/web              interface React + Vite + Tailwind + Motion + dnd-kit + TanStack Query
apps/api              API Fastify
apps/worker           busca horária, fila de buscas e fila de IA
packages/connectors   uma fonte por arquivo, mais filtro local e fixtures
packages/db           schema Drizzle, migrations SQL e cliente postgres-js
packages/shared       tipos e schemas Zod
packages/ai           provedores de IA (Claude, OpenAI, Gemini e o falso), prompts, verificador de não invenção
packages/resume       extração de texto de PDF/DOCX e geração do PDF do currículo adaptado
packages/settings     configurações gravadas pela tela e cifra das chaves de API
scripts/              start de produção, instalação do worker, gravação de fixtures, ai:smoke, prévia do currículo (resume:preview)
.railway/             configuração do Railway (nunca aplicada, veja "Deploy")
docs/superpowers/     spec e plano de implementação
```

### Adicionar uma fonte

1. Grave uma resposta real: `node scripts/record-fixture.mjs <url> packages/connectors/fixtures/<fonte>.json [chave-do-array] [n]`. Se a resposta for JSON, o script corta a lista para `n` itens (padrão 5).
2. Crie `packages/connectors/src/<fonte>.ts` com uma função de mapeamento pura (resposta da fonte para `NormalizedJob`, usando `keepValid` e `expectList` de `normalize.ts`) e um `Connector` (`id`, `name`, `search(filters)`) que a usa.
3. Teste o mapeamento contra a fixture em `<fonte>.test.ts` (veja `remotive.test.ts`) e inclua a fonte em `drift.test.ts`, que garante que uma mudança de formato vira erro, não "0 vagas".
4. Registre o conector na lista `REAL` de `packages/connectors/src/index.ts` e atualize a lista de ids em `index.test.ts`.

## CI

O workflow `.github/workflows/ci.yml` roda em push para a `main` e em pull requests de qualquer branch. Um job no Ubuntu, com Node 24 e um Postgres 17 como serviço, executa em ordem: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, o build do web com a conferência de que o Zod não entrou no bundle do navegador, instalação do Chromium do Playwright e `pnpm e2e` (banco `kanban_e2e`). Se algo falhar, o relatório do Playwright é guardado como artefato por 7 dias. Uma execução nova no mesmo branch cancela a anterior.

A CI não precisa de nenhum segredo do repositório: nenhuma chave de API e nenhum `APP_SECRET`. Os testes da IA usam o provedor falso, e o `APP_SECRET` do e2e é sorteado pelo `playwright.config.ts` a cada execução. O `pnpm ai:smoke` não faz parte do workflow e se recusa a rodar quando `CI` está definida.

## Deploy no Railway

> **ATENÇÃO: o app NÃO TEM LOGIN.** Quem tiver a URL lê e altera tudo (vagas, notas, perfis, o seu currículo) e, com uma chave de API gravada, pode trocar o provedor e **gastar o seu dinheiro** com ela. **Não gere domínio público** para o serviço enquanto não existir autenticação. A configuração do repo não declara domínio de propósito.

O alvo é **um serviço** construído pelo `Dockerfile`. Um container roda a API (que também serve o web já buildado) e o worker, iniciados por `scripts/start-prod.mjs`.

- **Banco:** defina a variável `DATABASE_URL` do serviço com a connection string do Postgres (Supabase, por exemplo). Ela nunca fica no repositório.
- **`APP_SECRET`:** obrigatória para gravar chaves de API pela aba Configurações. Gere uma vez (o comando está em [A aba Configurações](#a-aba-configurações)), defina como variável do serviço no painel e guarde uma cópia; ela nunca fica no repositório. Trocar o valor invalida as chaves gravadas. Sem ela, a IA só funciona com `AI_PROVIDER` e a chave do provedor definidas como variáveis do serviço.
- **Memória:** a leitura de um currículo enviado roda em uma thread à parte que pode ocupar algumas centenas de megabytes por alguns segundos (teto de 256 MB de heap e 384 MB de crescimento do processo; acima disso o arquivo é recusado). Deixe folga: um serviço com menos de 1 GB pode ser encerrado pela plataforma no meio de um upload.
- **Migrations:** o `start-prod.mjs` aplica as migrations pendentes antes de subir a API e o worker. API e worker não migram. Se o banco ainda não aceita conexões (redeploy junto com o banco), as migrations, a API e o worker esperam por ele até 5 minutos cada antes de sair com erro.
- **Healthcheck:** `/api/stats`, que consulta o banco.
- **`ALLOWED_HOSTS`:** a API recusa (403) requisições cujo `Host` ela não conhece. No Railway ela aceita sozinha o domínio do serviço (variáveis `RAILWAY_PUBLIC_DOMAIN` e `RAILWAY_PRIVATE_DOMAIN`, injetadas pela plataforma) e `healthcheck.railway.app`, o `Host` das requisições de healthcheck. Só defina `ALLOWED_HOSTS` se o serviço for acessado por um domínio próprio. Como o resto da configuração do Railway, isto **não foi validado contra a plataforma**: se o healthcheck falhar com 403, confira nos logs o `Host` que chegou e acrescente-o a `ALLOWED_HOSTS`.
- **Uma réplica só.** O worker e as migrations do start não foram feitos para rodar em paralelo; com mais de uma réplica as buscas e as chamadas de IA rodariam em dobro, duas réplicas poderiam migrar ao mesmo tempo, e o limite de frequência do "Testar conexão" (que é por processo) deixaria de valer.
- Se a API ou o worker cair, o container sai com erro e o Railway o reinicia.
- **Indeed não funciona no container:** a imagem não tem Chromium. A fonte falha com erro claro na tela de saúde das fontes, e a análise das vagas do Indeed usa só título, empresa e local.
- **Imagem:** as fontes do PDF (Noto Serif, do pacote `@fontsource/noto-serif`) e os leitores de PDF e DOCX vão dentro dela como dependências de produção; nada é baixado em runtime.

O arquivo `.railway/railway.ts` descreve esse serviço como infraestrutura como código. **Ele nunca foi aplicado nem validado contra o Railway.** O primeiro passo, que só lê e não altera nada, é `railway config plan`; ele exige o pacote `railway` instalado no repo como dependência de desenvolvimento (`pnpm add -D -w railway`). Revise o plano antes de qualquer `railway config apply`.

### Rodar o mesmo container localmente

Com o Postgres do compose no ar:

```bash
docker build -t kanban-vagas .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5433/kanban \
  -e APP_SECRET=cole-aqui-o-seu-segredo-de-32-caracteres-ou-mais \
  kanban-vagas
```

Abra http://localhost:8080 (por `localhost` ou pelo IP da máquina; outro nome de host precisa estar em `ALLOWED_HOSTS`, com `-e ALLOWED_HOSTS=nome`). O `APP_SECRET` só é necessário para gravar chaves de API pela aba Configurações; use sempre o mesmo valor, senão as chaves gravadas deixam de decifrar. No Docker Desktop (Windows e macOS) `host.docker.internal` já existe; no Linux acrescente `--add-host=host.docker.internal:host-gateway`.

Sem Docker, `pnpm --filter @kv/web build && pnpm start:prod` faz o mesmo no host: migra, sobe API e worker e serve o web buildado (porta 3333, ou `PORT`).

## Licença

Apache License 2.0. Veja o arquivo [`LICENSE`](LICENSE).

Dependências acrescentadas pela IA de perfil e suas licenças: `@anthropic-ai/sdk`, `openai` e `@google/genai` (Apache-2.0); `@fastify/multipart`, `unpdf`, `fflate`, `pdfkit` e `fontkit` (MIT); `mammoth` (BSD-2-Clause); fonte Noto Serif, de `@fontsource/noto-serif` (OFL-1.1), embutida nos PDFs gerados. A cifra das chaves usa só o `node:crypto`.

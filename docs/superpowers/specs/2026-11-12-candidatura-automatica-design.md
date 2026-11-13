# Candidatura automática — Design (sub-projeto 3)

Data: 2026-11-12
Status: aguardando aprovação do dono
Depende de: Core e IA de perfil (`2026-11-11-core-kanban-design.md`, `2026-11-11-ia-perfil-design.md`, com todos os adendos)

## Contexto

O spec e o plano anteriores deste sub-projeto se perderam antes de serem commitados. Este documento os refaz a partir da conversa de 2026-11-12 e do código atual.

O roteiro do produto, atualizado nessa conversa:

1. Core (pronto).
2. IA de perfil (pronto).
3. **Candidatura automática (este spec)**, incluindo o currículo no modelo do dono.
4. E-mail: conectar a caixa do dono, ler as respostas das empresas, classificar (oferta, entrevista, reprovação, pedido), mover o card (inclusive para "Perdida") e responder pedidos.
5. Painel: aba de métricas (taxa de sucesso e afins) com os e-mails recebidos e respondidos.
6. Mais sites de candidatura e mais fontes (Ashby, Workable, Gupy, Indeed, Glassdoor).
7. Login e contas. 8. Polish open source.

Os sub-projetos 4, 5 e 6 terão spec e plano próprios. Este grava os dados de que eles vão precisar (seção "Dados").

Este documento substitui a linha do sub-projeto 3 no spec do Core, que dizia que a IA moveria o card até Entrevista. Aqui a IA move até Aplicada; os movimentos para Entrevista, Oferta e Perdida passam ao sub-projeto 4, que os decide pelos e-mails. O spec do Core ganhou um adendo apontando para este roteiro.

## Intenção

O dono quer se candidatar a mais vagas com menos trabalho manual: a IA adapta o currículo à vaga, envia a candidatura sozinha onde conseguir e deixa para ele só o que ela não resolve.

## Objetivo

Com a função ligada, toda vaga com nota igual ou acima do mínimo, em um site suportado, recebe uma candidatura enviada pela IA, com o currículo adaptado no modelo do dono, sem ação dele. O card vai para Aplicada, os contadores "Aplicadas pela IA" e "Precisam de você" passam a valer, e cada envio fica registrado por inteiro.

## Decisões do dono

- A IA aplica **só nas vagas com nota a partir de um mínimo**, que começa em 70 e é ajustável na aba Configurações.
- A IA aplica **também onde é preciso login**: o dono faz o login no site e ela usa a sessão. Exemplo dado: as vagas do LinkedIn que só pedem o envio do currículo.
- Nas perguntas do formulário, a IA usa as respostas salvas, calcula fatos a partir do perfil **e** escreve respostas abertas.
- O PDF gerado segue **sempre** o modelo `Curriculo_Pedro_Vinicius_Barros_TechLead_PTBR_Nov2026.pdf` (e o par em inglês, `Resume_..._EN_Nov2026.pdf`).
- O "como construir" ficou com o autor deste documento. O que é escolha dele está listado em "Decisões do autor".

## Fora de escopo

- E-mail, painel de métricas e fontes novas (sub-projetos 4, 5 e 6).
- Gupy, Ashby, Workable, Indeed, Glassdoor, Workday e sites próprios de empresas.
- Seguir o link "candidatar-se no site da empresa" do LinkedIn.
- Resolver captcha, disfarçar o navegador ou burlar bloqueio de site.
- Guardar senha de qualquer site, criar contas, fazer testes, provas ou vídeos.
- Rodar em container ou em servidor: a função só existe no computador do dono.

## Anti-objetivos

Qualquer um destes torna a entrega um fracasso, mesmo funcionando:

- Enviar informação que o perfil ou o dono não afirmam.
- Enviar duas candidaturas para a mesma vaga.
- Aplicar na empresa atual do dono ou em empresa bloqueada por ele.
- Provocar restrição da conta do LinkedIn por volume ou ritmo.
- Enviar algo sem deixar registro do que foi enviado.
- Gastar com IA acima do limite diário.

## Restrições

- **Só local.** O envio precisa de uma janela de navegador visível, na máquina do dono.
- **LinkedIn proíbe automação** nos termos de uso e pode restringir a conta. O dono foi avisado e escolheu seguir; o risco é dele.
- **Captcha existe nos formulários públicos.** Verificado em 2026-11-12 em formulários reais: o Greenhouse carrega reCAPTCHA Enterprise e o Lever carrega hCaptcha. Captcha é um estado normal do fluxo, não um erro.
- **O Greenhouse publica as perguntas.** Verificado em 2026-11-12: `GET boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true` devolve cada pergunta com tipo, obrigatoriedade e opções, e o formulário abre em `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` mesmo quando a vaga aponta para o site da empresa.
- **O formulário do Lever** fica em `<hostedUrl>/apply`. Verificado em 2026-11-12: currículo, nome, e-mail, telefone, local atual, empresa atual, links e perguntas próprias de cada empresa.
- **O LinkedIn logado não foi verificado.** Não havia sessão do dono ao escrever este documento; o roteiro do LinkedIn será escrito contra páginas gravadas com a sessão dele.
- **Não se sabe com que frequência o captcha vai barrar o envio automático** no Greenhouse e no Lever. O modo ensaio e o primeiro uso real vão mostrar.
- Valem as regras da IA de perfil: não invenção, conteúdo de terceiros só como dados, limite diário de gasto, nenhuma chamada de IA dentro de requisição HTTP.

## Abordagens consideradas

1. **Roteiro fixo por site, com IA só nas perguntas (escolhida).** O código conhece os passos de cada site; a IA só classifica as perguntas e escolhe ou escreve as respostas, sempre em saída estruturada. Rápido, barato, previsível e testável com páginas gravadas. Custo: um roteiro por site, e mudança de layout quebra o site até ser corrigida.
2. **IA navegando livre.** O modelo lê a página e decide cada clique. Cobre qualquer site, mas faz dezenas de chamadas por candidatura, é lento e imprevisível, e um texto malicioso na página poderia induzi-lo a agir dentro da conta logada do dono. Descartada por esse risco e pelo custo.
3. **Extensão no navegador do dia a dia.** Usa a sessão que o dono já tem, mas é um segundo produto para instalar e manter, e é difícil de testar. Descartada.

O dono deixou a escolha com o autor; a escolhida foi a 1.

---

## Parte A — Currículo no modelo do dono

Independente da Parte B e construída primeiro. Vale para todo PDF que o app gera (download e candidatura); o layout atual deixa de existir.

### Medidas do modelo

Lidas dos dois arquivos do dono em 2026-11-12. Página A4, margens de 50 pt, uma coluna, fonte **Noto Serif** (Regular e Bold).

| Elemento | Peso | Tamanho | Cor |
|---|---|---|---|
| Nome, em caixa alta | Bold | 20 | `#1f2a44` |
| Título profissional, em caixa alta | Bold | 10,5 | `#1f2a44` |
| Linha de contato | Regular | 8 | `#6b7280` |
| Fio abaixo do cabeçalho | — | fino | `#c9ced6` |
| Título de seção, em caixa alta | Bold | 10,5 | `#1f2a44` |
| "Cargo - Empresa" | Bold | 9 | `#1f2a44` |
| Linha de período, local e nota | Regular | 8 | `#6b7280` |
| Rótulo de grupo de competências | Bold | 8,5 | `#1f2a44` |
| Corpo e realizações | Regular | 8,5 | `#222222` |
| Rodapé "Nome • página", centralizado | Regular | 7 | `#6b7280` |

Geometria, medida na versão em português (distâncias entre linhas de base, em pontos):

| Trecho | Distância |
|---|---|
| Topo da página até o nome | 66,4 |
| Nome até o título profissional | 17,1 |
| Título até a linha de contato; entre duas linhas de contato | 13,6; 10,9 |
| Fio: a 116,6 do topo, de x = 50 a 545, espessura 0,5 | — |
| Última linha de contato até o primeiro título de seção | 30,1 |
| Título de seção até a primeira linha abaixo dele | 16,6 |
| Entre linhas do corpo (8,5 pt) | 13,2 |
| Entre grupos de competências; entre itens de formação | 15,2; 14,7 |
| "Cargo - Empresa" até a linha de período | 13,7 |
| Linha de período até a primeira realização | 14,7 |
| Dentro de uma realização; entre realizações | 12,6; 14,1 |
| Marcador em x = 54,1; texto da realização em x = 63,1 | — |
| Última realização até a experiência seguinte | 27,2 |
| Último texto até o título da seção seguinte: depois de corpo; depois de realizações | 23,9; 36,9 |
| Rodapé: linha de base a 38 da borda inferior | — |

Os dois arquivos do modelo ficam em `C:\Users\Vinicius\Documents\Curriculos\`, fora do repositório. Eles têm dados pessoais e **nunca são commitados**: os testes usam um perfil fictício, e a comparação com o modelo é feita pelo dono, lado a lado, com um PDF gerado do perfil dele.

### Conteúdo e ordem

1. Cabeçalho: nome, título profissional, linha de contato (local • telefone • e-mail • links sem `https://`), fio.
2. Seções, nesta ordem e com estes títulos:

| pt-BR | en |
|---|---|
| Resumo profissional | Professional summary |
| Competências técnicas | Technical skills |
| Experiência profissional | Professional experience |
| Experiências complementares | Additional experience |
| Formação acadêmica | Education |
| Idiomas | Languages |
| Certificações | Certifications |

3. Competências: uma linha por grupo, "**Rótulo:** itens separados por vírgula". Sem grupos, uma linha só, sem rótulo.
4. Experiência: "Cargo - Empresa"; linha "Fev 2026 - Atual | Local · nota"; realizações com marcador e recuo.
5. Formação: uma linha por item, "Curso - Instituição | período". Idiomas: uma linha, "Nome: nível | Nome: nível".
6. Rodapé em toda página. Seção vazia não aparece. Título de seção nunca fica sozinho no fim da página.

Datas gravadas como `AAAA-MM` saem como "Fev 2026" ou "Feb 2026"; texto em outro formato sai como foi digitado. Continua valendo: texto selecionável, sem tabelas nem imagens, e o aviso de caractere sem glifo.

### O que o perfil ganha

O perfil estruturado não guarda três coisas que o modelo usa. Elas entram como campos opcionais; perfis já gravados continuam válidos.

- `headline`: o título profissional abaixo do nome.
- `skills[].group`: o grupo da competência ("Back-end & APIs").
- `experiences[].section` (`principal` ou `complementar`) e `experiences[].note` (a linha de cargos anteriores na mesma empresa).

A leitura do currículo e a tradução do perfil passam a preencher esses campos. O currículo adaptado os **copia** do perfil; o modelo nunca os reescreve. No verificador de não invenção, a única mudança é contar o título, os grupos e a nota como vocabulário do perfil, para um resumo que repita o título não ser barrado como termo novo. O editor de "Meu perfil" ganha os campos. Para preencher um perfil já existente, o dono pede a releitura do currículo ou edita à mão.

---

## Parte B — Candidatura automática

### Visão geral

Pacote novo `packages/apply` (roteiros de site, leitura de formulário, resolução de respostas) e uma **fila de candidaturas** no worker, separada da fila de busca e da fila de IA. Uma candidatura por vez, em uma janela de navegador própria do app.

```
vaga com nota >= mínimo ─▶ conferência ─▶ currículo ─▶ formulário ─▶ envio ─▶ Aplicada
        (varredura)        (descrição,    (camada 3,    (perguntas     (ou ensaio,
                            bloqueios)     PDF)          e respostas)   ou "precisa de você")
```

### Quais vagas entram

A varredura do worker roda a cada 5 minutos, com a função ligada e dentro do horário configurado. Entra a vaga que cumpre tudo:

- está em Descobertas, com nota da camada 1 válida e igual ou acima do mínimo;
- pertence a um site suportado (decidido pela fonte e pela URL, sem rede);
- não tem candidatura anterior nem `applied_by`;
- foi descoberta há no máximo 14 dias;
- cabe nos limites do dia e no limite por empresa.

Ordem: nota mais alta primeiro. Há também o botão **"Aplicar com IA"** no painel da vaga, que vale para qualquer vaga de site suportado, seja qual for a nota. Por ser um pedido explícito, ele dispensa a nota mínima, a conferência, a idade da vaga, o horário e o limite por empresa, e vale para qualquer coluna antes de Aplicada. Continuam valendo a lista de bloqueio, os limites diários do site e a regra de um envio por vaga. Vaga de site não suportado não recebe candidatura nem marca: fica no quadro como hoje.

### Conferência antes de aplicar

A nota da camada 1 lê só título, empresa, local e o começo da descrição, e as vagas do LinkedIn chegam sem descrição. Por isso, antes de gastar com o currículo:

1. A descrição é buscada se faltar, pelo buscador sem login que já existe (`packages/connectors/src/detail.ts`). A conferência **nunca abre página logada**: só as vagas que passam por ela são abertas na sessão do dono. No LinkedIn, se a descrição só aparecer na página logada, a conferência é refeita ali, antes de abrir o formulário.
2. O modelo rápido dá a nota de novo, agora com a descrição inteira (até 12 000 caracteres), e diz se algum requisito exclui o candidato (país, visto, idioma). Essa nota fica na candidatura e aparece no painel da vaga. A nota do card continua sendo a da camada 1, que o app recalcula por conta própria quando o perfil muda.
3. Nota abaixo do mínimo, requisito que exclui, empresa ou termo da lista de bloqueio: a candidatura é **pulada**, com o motivo, e o card fica onde está.

A lista de bloqueio (empresas e termos) é editável em Configurações. O app sugere a empresa atual do dono na primeira vez.

### Currículo enviado

- Reaproveita a camada 3 e o verificador: um currículo adaptado por vaga, no idioma da vaga, gerado se não existir ou se estiver desatualizado.
- Rascunho barrado pelo verificador para a candidatura, com "precisa de você".
- Configuração "currículo da candidatura": **adaptado** (padrão) ou **base** (o perfil como está, sem chamada de IA). O base existe para quem quer volume com gasto mínimo.
- Arquivo enviado: `Curriculo_<Nome>_<Empresa>.pdf` ou `Resume_<Name>_<Company>.pdf`.

### Navegador e contas

- Playwright com perfil persistente, no **Chrome ou Edge instalados** (não o Chromium do Playwright), sempre com janela visível. Sem Chrome nem Edge, a tela explica o que instalar.
- O perfil do navegador fica na pasta de dados do usuário no sistema (`%LOCALAPPDATA%\kanban-vagas` no Windows), fora do repositório; `APPLY_DATA_DIR` troca o lugar.
- **Contas** (Configurações): para cada site com login, o estado (conectada ou não) e o botão "Abrir para fazer login". O dono digita a senha na página do próprio site; o app nunca a vê nem a guarda. "Desconectar" apaga a sessão.
- A janela abre quando há trabalho e fecha depois de 5 minutos parada.
- O app não tenta parecer humano além de respeitar limites e intervalos: nada de disfarce de navegador nem de solução de captcha.

### Sites

Cada site é um roteiro com a mesma interface:

```ts
interface ApplySite {
  id: 'linkedin' | 'greenhouse' | 'lever';
  needsLogin: boolean;
  /** A vaga é deste site? Decide pela fonte e pela URL, sem rede. */
  match(job: { source: string; url: string; externalId: string }): ApplyTarget | null;
  sessionState(page: Page): Promise<'logged_in' | 'logged_out'>;
  /** Abre a candidatura; diz se há formulário ou por que não há. */
  open(page: Page, target: ApplyTarget): Promise<{ kind: 'form' } | { kind: 'unavailable'; reason: Unavailable }>;
  /** Lê a etapa visível. Não altera nada. */
  readStep(page: Page): Promise<{ questions: Question[]; isLast: boolean }>;
  fillStep(page: Page, answers: ResolvedAnswer[]): Promise<void>;
  /** Avança uma etapa; nunca envia. */
  next(page: Page): Promise<void>;
  /** Clica no envio final e confirma que o site aceitou. */
  submit(page: Page): Promise<{ confirmation: string }>;
  /** A página pede algo que só o humano faz? */
  humanGate(page: Page): Promise<null | 'captcha' | 'verification_code' | 'login' | 'restricted'>;
  /** Fecha o formulário sem enviar e sem deixar rascunho. */
  discard(page: Page): Promise<void>;
}
```

`Unavailable` é `closed` (vaga encerrada), `external` (leva a outro site) ou `already_applied`.

| Site | Login | Como acha o formulário | Observações |
|---|---|---|---|
| LinkedIn | sim | página da vaga, botão "Candidatura simplificada" | Sem o botão, a vaga é pulada (`external`). Formulário em etapas. Desmarca "seguir a empresa". Não verificado. |
| Greenhouse | não | endereço `embed/job_app` com board e id | Perguntas lidas da API pública; demográficas opcionais ficam em branco. |
| Lever | não | `<hostedUrl>/apply` | O site lê o currículo e preenche campos sozinho: o roteiro espera e sobrescreve com os dados do perfil. |

"Já se candidatou", quando o site informa, move o card para Aplicada como aplicada pelo dono.

### Perguntas e respostas

Cada campo do formulário vira uma `Question` (rótulo, tipo, opções, obrigatória, tamanho máximo). A pergunta é classificada primeiro por regras e depois, se preciso, pelo modelo rápido, que só pode devolver uma das categorias abaixo. Padrões de texto sensíveis (salário, visto, antecedentes, deficiência, em português e inglês) mandam na classificação, seja o que for que o modelo diga. Na dúvida, a categoria é "pessoal".

| Categoria | Exemplos | Quem responde |
|---|---|---|
| Identidade e contato | nome, e-mail, telefone, cidade, LinkedIn, empresa atual | Regra, a partir do perfil |
| Arquivo | currículo | O PDF da candidatura |
| Origem | "como soube da vaga?" | Regra: o nome da fonte da vaga |
| Fato do perfil | anos de experiência com X, nível de idioma, formação, "já trabalhou aqui?" | Modelo rápido citando itens do perfil, conferido em código |
| Pessoal | pretensão salarial, visto, disponibilidade, mudança de cidade, acordos de não concorrência, antecedentes, referências | **Só o banco de respostas** |
| Demográfica | gênero, raça, deficiência, veterano | Opcional: em branco. Obrigatória: "prefiro não informar", se existir; senão, o banco |
| Consentimento | política de privacidade, termos, veracidade | Marca quando é exigido para enviar, e registra. Outro compromisso vai para o dono |
| Aberta | "por que quer trabalhar aqui?", carta em texto obrigatória | Modelo forte, a partir do perfil e da vaga, com verificador |
| Desconhecida | o classificador não decide | O dono |

Regras que valem para todas:

- **Toda pergunta obrigatória precisa de resposta.** Faltando uma, nada é enviado e a candidatura vira "precisa de você" com as perguntas pendentes. Pergunta opcional sem resposta fica em branco.
- **Fato do perfil é conferido em código.** Os itens citados precisam existir. Número de anos não pode passar do tempo coberto pelas experiências citadas. "Tem experiência com X" só é "sim" se X está no perfil. Resposta de lista precisa ser uma das opções oferecidas. O que não passa na conferência conta como sem resposta.
- **Resposta aberta passa pelo verificador de não invenção** (números e nomes precisam estar no perfil ou na vaga) e respeita o tamanho do campo e o idioma do formulário. Há uma tentativa de correção; se ainda assim não passar, conta como sem resposta. O interruptor "respostas abertas escritas pela IA" começa ligado, por decisão do dono.
- **Rótulos e opções do formulário são conteúdo de terceiros**: vão ao modelo como dados delimitados, com a instrução de ignorar comandos. O modelo nunca decide navegação e nunca devolve endereço a visitar.

### Banco de respostas

Uma tabela só guarda o que o dono já respondeu.

- **Perguntas comuns já listadas, vazias**, para preencher uma vez em "Meu perfil": pretensão salarial (em reais e em dólar), visto e autorização de trabalho (por país, começando pelo Brasil), disponibilidade para começar, mudança de cidade ou país, modelos de trabalho aceitos, pronomes.
- **Aprendizado**: quando uma candidatura para em uma pergunta, o dono responde no app; a resposta é gravada e a candidatura volta para a fila. Ao responder, ele escolhe o alcance: sempre, só esta empresa ou só esta vaga. O padrão é "sempre" para perguntas pessoais e "só esta vaga" para abertas.
- **Casamento**: primeiro pelo texto normalizado, que vale na hora. Depois o modelo rápido propõe a pergunta salva que pede a mesma informação e, em listas, a opção que corresponde à resposta salva. **Proposta do modelo não é enviada sem o dono confirmar uma vez**: a candidatura para, o app mostra "esta pergunta é a mesma que aquela? resposta: X", e um clique confirma. Confirmado, aquele texto (com aquele conjunto de opções) passa a casar sozinho.
- **País**: as respostas sobre visto e autorização de trabalho são gravadas por país, porque mudam de um para outro e as perguntas invertem o sentido ("precisa de patrocínio?" contra "tem autorização?"). Sem resposta para o país da vaga, a pergunta vai para o dono.
- Cada resposta usada fica no registro da candidatura com a pergunta salva que casou, e a tela do banco permite desfazer uma associação errada.

### Estados de uma candidatura

| Estado | Significado |
|---|---|
| `queued` | Na fila |
| `preparing` | Conferência e currículo |
| `filling` | Lendo e preenchendo o formulário |
| `waiting_human` | Janela aberta esperando o dono (captcha, código, login) |
| `submitting` | Vai clicar no envio final |
| `submitted` | Enviada e confirmada pelo site |
| `dry_run_ready` | Ensaio: preenchida, não enviada |
| `needs_human` | Parou; o motivo diz o que falta |
| `skipped` | Não era para aplicar; o motivo diz por quê |
| `failed` | Erro inesperado depois das tentativas |
| `cancelled` | Cancelada pelo dono |

Motivos de `needs_human`: `question`, `captcha`, `verification_code`, `login`, `restricted`, `unsupported_form`, `resume_blocked`, `confirm_submission`. Motivos de `skipped`: `below_min_score`, `not_eligible`, `blocked`, `closed`, `external`, `already_applied`.

**No máximo um envio por vaga.** O estado `submitting` é gravado antes do clique final. Se o worker cair entre o clique e a confirmação, a candidatura **não** é refeita: vira `needs_human` com `confirm_submission` ("não sei se foi enviada; confira no site").

### Card, contadores e histórico

- Passou na conferência: o card vai de Descobertas para Selecionadas, com ator `ia`.
- `submitted`: vai para Aplicada, com `applied_by = 'ia'`.
- `needs_human` ou `waiting_human`: fica em Selecionadas com `needs_human` ligado e o motivo em texto; resolvido, desliga.
- `skipped`: o card não se move. A exceção é `already_applied`, que leva o card para Aplicada como aplicada pelo dono.
- A IA nunca move além de Aplicada, e seus movimentos não disparam a análise da camada 2.
- Se o dono move o card por conta própria, a candidatura na fila é cancelada; uma em andamento confere o cancelamento antes do envio.

### Quando o humano é necessário

- **Ao vivo** (captcha, código por e-mail, sessão expirada): a janela vem para a frente, o app avisa, e o worker espera até 10 minutos. Resolvido, continua do ponto em que parou. Estourou o tempo, vira `needs_human` com "Tentar de novo".
- **Depois** (pergunta sem resposta, casamento a confirmar, currículo barrado, formulário não reconhecido): fica em "precisa de você" até o dono agir no app.
- **Captcha e código não acionam o freio do site**: são parte normal do fluxo. Mas, se o dono não aparecer em duas esperas seguidas, o site fica em "aguardando você" e as candidaturas dele esperam o dono voltar, sem travar os outros sites.
- **Recusa sem desafio**: se o site recusar o envio sem mostrar nada para resolver, a candidatura vira `needs_human` com `captcha` e a orientação de enviar por conta própria.
- O contador "Precisam de você" da barra do topo abre a lista filtrada.

### Limites, ritmo e freio

| O quê | Padrão | Ajustável |
|---|---|---|
| Candidaturas por dia, LinkedIn | 10 | sim |
| Vagas abertas na sessão do LinkedIn por dia | 30 | sim |
| Candidaturas por dia, Greenhouse e Lever | 15 cada | sim |
| Total por dia | 30 | sim |
| Por empresa a cada 30 dias | 2 | sim |
| Horário de funcionamento | 08:00 a 21:00 | sim |
| Intervalo entre candidaturas, LinkedIn | 3 a 8 min, sorteado | não |
| Intervalo nos demais | 1 a 3 min, sorteado | não |

- O limite de candidaturas conta **formulários abertos**, seja envio ou ensaio.
- No LinkedIn, uma vaga aberta e pulada (sem candidatura simplificada, encerrada) conta só no limite de vagas abertas, e nunca é reaberta. Entre duas aberturas de vaga na sessão o intervalo é de 1 a 3 min; depois de um formulário, de 3 a 8 min.
- **Freio por site**: três falhas seguidas de formulário não reconhecido, três recusas de envio seguidas, ou qualquer página de restrição, verificação de conta ou "atividade incomum" (motivo `restricted`) pausam aquele site até o dono clicar em "Retomar".
- Erro passageiro (rede, tempo de carregamento) tem duas novas tentativas, em 5 e em 30 minutos.

### Modo ensaio

Cada site começa em **Ensaio**: a IA faz tudo, fotografa o formulário preenchido e **não clica no envio**; o formulário é fechado sem rascunho. O painel da vaga mostra as respostas e a foto, com o botão "Enviar de verdade". O dono troca o site para **Enviar** em Configurações quando confiar.

- **"Enviar de verdade" repete o que o dono viu**: o mesmo PDF e as mesmas respostas. Se o formulário tiver mudado e houver pergunta obrigatória nova, a candidatura vira um ensaio novo, para ele ver de novo.
- Trocar o site para Enviar **não dispara** os ensaios já prontos: cada um precisa do "Enviar de verdade", e a aba Candidaturas tem um botão para enviar todos.

### Registro de cada candidatura

Fica guardado: o PDF exato que foi enviado, cada pergunta com a resposta, a origem da resposta (regra, banco, perfil, escrita) e os itens do perfil citados, os consentimentos marcados, a foto do formulário preenchido, a foto da confirmação, o texto de confirmação do site e a linha do tempo dos estados.

### Custo

Estimativas com os modelos padrão do Claude, a medir no uso real:

| Etapa | Modelo | Custo típico |
|---|---|---|
| Conferência da nota | rápido | menos de US$ 0,01 |
| Classificar e responder perguntas | rápido | menos de US$ 0,01 |
| Respostas abertas, quando há | forte | US$ 0,03 a 0,07 |
| Currículo adaptado | forte | US$ 0,07 |

Uma candidatura típica custa perto de US$ 0,08; com o limite padrão de US$ 1 por dia, cabem cerca de 10. Com o currículo base, cai para centavos. Atingido o limite diário, a fila de candidaturas espera o dia seguinte; não há "executar mesmo assim" automático. O gasto aparece em Configurações em uma camada nova, "Candidatura".

### Segurança e privacidade

- A função só liga com a API escutando em endereço local; em container fica desligada, com o motivo na tela.
- O app continua sem login: quem alcançar o app pode disparar candidaturas com as contas do dono e ler as respostas dele. O aviso de não expor o app fica mais forte e aparece nesta seção das Configurações.
- A sessão dos sites fica só no perfil do navegador, no disco do dono. Nunca vai para o banco nem para log.
- As fotos contêm dados pessoais: ficam na pasta de dados local, com limpeza depois de 90 dias. O PDF enviado fica no banco, junto da candidatura, e não é limpo sozinho. "Apagar todos os dados de IA" apaga também o banco de respostas, os PDFs, as fotos e o conteúdo das candidaturas, mantendo estado e datas.

### Dados

Tabelas novas, com RLS habilitado:

- `applications`: vaga, site, estado, motivo, detalhe para o dono, gatilho (`auto` ou `manual`), modo (`dry_run` ou `real`), nota da conferência, idioma do currículo, nome e conteúdo do PDF enviado, respostas (JSON), perguntas pendentes (JSON), confirmação do site, **e-mail usado na candidatura**, tentativas, não iniciar antes de, criada, iniciada, enviada e terminada em. No máximo uma candidatura ativa por vaga e no máximo uma enviada por vaga, garantido por índice.
- `application_events`: candidatura, quando, estado, mensagem.
- `apply_answers`: pergunta, chave fixa (para as comuns), resposta, tipo, alcance (`sempre`, empresa ou vaga), país (para visto e autorização), variações confirmadas pelo dono, vezes usada, atualizada em.
- `apply_commands`: pedidos da API ao worker (abrir login, conferir sessão, fechar navegador), com estado e resultado. O worker continua sem receber HTTP.

Mudanças: novas chaves em `settings`; a camada `apply` em `ai_usage`; os campos novos do perfil (Parte A). `jobs` não muda: `applied_by`, `needs_human` e `needs_human_reason` já existem. As fotos ficam em disco; o banco guarda o caminho.

Para os sub-projetos 4 e 5: e-mail usado, empresa, site, fonte, nota, idioma, origem das respostas e todas as datas ficam em `applications` e `application_events`.

### Worker

- Fila própria, verificada a cada 5 s, concorrência 1. Falha ou lentidão aqui não atrasa a busca nem a fila de IA.
- Candidatura em `preparing` ou `filling` quando o worker reinicia volta para a fila; em `submitting`, vira `confirm_submission`.
- Tempo limite de 10 minutos de trabalho por candidatura, sem contar a espera pelo dono.

### API

- `GET /apply/status`: ligada ou não e por quê, contas, pausas, contagem do dia, fila.
- `POST /apply/sessions/:site/open`, `POST /apply/sessions/:site/check`, `DELETE /apply/sessions/:site`, `POST /apply/sites/:site/resume`.
- `GET /applications?status=&site=`, `GET /jobs/:id/application`, `POST /jobs/:id/application` (aplicar com IA).
- `POST /applications/:id/retry`, `/cancel`, `/send` (ensaio para envio real), `PUT /applications/:id/answers` (responde as pendentes, grava no banco e devolve à fila).
- `GET /applications/:id/resume.pdf`, `GET /applications/:id/shots/:kind`.
- `GET/POST/PUT/DELETE /apply/answers`.
- As configurações novas entram nas rotas de configuração existentes, com as mesmas proteções.

### Interface

Segue o tema, os componentes (`ui/*`) e o Motion que o app já usa. As telas novas passam pelo `ui-ux-pro-max` e pelo `frontend-design` na implementação.

- **Configurações, seção "Candidatura automática"**: interruptor geral (desligado por padrão), nota mínima, modo por site (Ensaio ou Enviar), limites, horário, currículo adaptado ou base, respostas abertas, lista de bloqueio, contas, pausas, avisos de risco.
- **Meu perfil**: título profissional, grupo de cada competência, seção e nota de cada experiência; bloco **"Respostas para candidaturas"** (o banco).
- **Aba "Candidaturas"**: lista com filtros (em andamento, precisam de você, ensaios, enviadas, puladas), com resposta às perguntas pendentes ali mesmo.
- **Card**: selos "IA aplicando", "ensaio pronto", "precisa de você" e "aplicada pela IA".
- **Painel da vaga, seção "Candidatura"**: estado e linha do tempo, perguntas e respostas com a origem, PDF enviado, fotos, e os botões Aplicar com IA, Enviar de verdade, Tentar de novo, Cancelar e "Já apliquei por conta própria".

### Erros

- Layout não reconhecido: `unsupported_form`, com a foto da página; conta para o freio do site.
- Site fora do ar ou lento: novas tentativas, depois `failed`.
- IA indisponível ou limite atingido: a fila espera, como a camada 1 faz hoje.
- Sem navegador instalado, sem sessão ou fora do horário: nada começa, e a tela diz o porquê.

### Testes

- Roteiros contra **páginas gravadas**, servidas localmente: Greenhouse e Lever gravados dos formulários públicos; LinkedIn gravado com a sessão do dono, com os dados pessoais removidos.
- Um site falso com formulário local, para testar a fila e os estados: um envio por vaga (inclusive com queda no meio do envio), ensaio que nunca envia, limites, freio, cancelamento.
- Respostas: regras, casamento com o banco, categorias sensíveis nunca respondidas pelo modelo, resposta fora das opções, conferência de anos, verificador nas respostas abertas, comando escondido em rótulo de formulário.
- PDF: ordem e conteúdo das seções, grupos, rodapé, quebras de página, os dois idiomas, perfil antigo sem os campos novos. Sempre com um perfil fictício.
- e2e com o site falso: ligar a função, vaga com nota acima do mínimo é aplicada, vaga abaixo não é, pergunta pendente respondida no app e reaproveitada.
- Nenhum teste automatizado toca um site real. Um roteiro manual `pnpm apply:smoke`, sempre em ensaio e nunca na CI, confere os sites de verdade.

## Critérios de aceite

1. Com a função ligada, o LinkedIn conectado e em modo Enviar, uma vaga com nota a partir do mínimo, que só pede currículo e contato, é aplicada sem ação do dono; o card vai para Aplicada como "aplicada pela IA" e o contador sobe.
2. O mesmo vale para uma vaga do Greenhouse e uma do Lever cujas perguntas tenham resposta. Se o site mostrar captcha, o dono o resolve na janela e o envio continua.
3. Vaga abaixo do mínimo, de empresa bloqueada ou já aplicada nunca recebe candidatura.
4. Nenhuma vaga recebe dois envios, mesmo com o worker reiniciado no meio de um envio.
5. Pergunta obrigatória sem resposta permitida impede o envio; depois que o dono responde no app, a candidatura é concluída e a mesma pergunta é respondida sozinha na vaga seguinte.
6. Salário, visto e declarações legais nunca são respondidos pelo modelo por conta própria.
7. Em modo Ensaio, o envio final nunca é clicado.
8. Cada candidatura enviada guarda o PDF exato, todas as respostas com a origem e as duas fotos.
9. O PDF gerado a partir do perfil do dono, em português e em inglês, tem a estrutura, a tipografia, as cores e o rodapé do modelo, com texto selecionável.
10. Captcha, código e login pausam e chamam o dono; resolvidos, a candidatura continua; sem resposta em 10 minutos, para sem enviar.
11. Limites diários, limite por empresa e horário são respeitados; sinal de restrição pausa o site.
12. Com a função desligada (o padrão), o app se comporta como hoje; em container ela não liga.
13. O gasto com IA respeita o limite diário.

## Decisões do autor

Escolhas que o dono não fez e pode trocar:

1. Primeira versão com LinkedIn, Greenhouse e Lever; Gupy e os demais ficam para o sub-projeto 6.
2. Cada site começa em modo Ensaio.
3. A IA move o card para Selecionadas ao começar e para Aplicada ao enviar; nunca além.
4. Vaga de site não suportado não é marcada como "precisa de você".
5. Conferência da nota com a descrição completa antes de aplicar; a nota conferida fica na candidatura e não troca a do card.
6. Categorias "pessoal" e "demográfica" nunca são respondidas pelo modelo.
7. Consentimento de privacidade, termos e veracidade é marcado sozinho e registrado.
8. O título profissional, os grupos e a nota da experiência são copiados do perfil, nunca reescritos por vaga.
9. Limites e intervalos da tabela "Limites, ritmo e freio", inclusive duas candidaturas por empresa a cada 30 dias.
10. Opção de enviar o currículo base, sem adaptação.
11. Fotos em disco com limpeza em 90 dias; PDF enviado no banco.
12. No LinkedIn, desmarcar "seguir a empresa".
13. Avisos só dentro do app (e notificação do navegador, se permitida).
14. Carta de apresentação só quando o campo é obrigatório e aceita texto.
15. Resposta salva que o modelo associa a uma pergunta de texto diferente só é enviada depois de o dono confirmar a associação uma vez. Deixa as primeiras semanas com mais paradas, em troca de nunca enviar uma declaração que ele não fez.
16. Respostas de visto e autorização de trabalho são por país.
17. No LinkedIn, no máximo 30 vagas abertas por dia na sessão do dono, além do limite de 10 candidaturas.
18. Captcha e código não pausam o site; duas esperas sem o dono, sim, só para aquele site.
19. "Enviar de verdade" repete o ensaio; mudar o site para Enviar não dispara ensaios prontos.
20. "Aplicar com IA" dispensa nota mínima, conferência, idade, horário e limite por empresa; nunca a lista de bloqueio nem os limites diários.
21. O currículo real do dono nunca entra no repositório; os testes usam um perfil fictício.

## O que fica para quem constrói

Seletores e detalhes de cada roteiro; nomes e tipos exatos de colunas; prompts; ajuste fino dos tempos; organização dos arquivos; desenho detalhado das telas dentro do estilo existente; a forma de gravar e limpar as páginas de teste.

## Depois deste sub-projeto

- **Sub-projeto 4, e-mail**: conectar a caixa do dono; ler as respostas das empresas; reconhecer oferta, entrevista, reprovação e pedido de informação; mover o card (com uma coluna "Perdida" para reprovações); a IA responde pedidos por e-mail.
- **Sub-projeto 5, painel**: aba com as métricas (taxa de sucesso por site, fonte, faixa de nota e idioma; tempo até a primeira resposta; o que mais trava as candidaturas; custo por candidatura) e os e-mails recebidos e respondidos, no estilo do sistema.
- **Sub-projeto 6, mais sites e fontes**: Ashby, Workable e Gupy; busca no LinkedIn já logado, filtrando candidatura simplificada; lista de empresas do Greenhouse e do Lever que cresce sozinha; seguir o link externo do LinkedIn quando leva a um site suportado; Indeed e Glassdoor por último.
- Leitor genérico de formulário para sites desconhecidos; reescrita do título profissional por vaga; avisos por WhatsApp ou Telegram.

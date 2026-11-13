# E-mail e Painel — Design (sub-projetos 4 e 5)

Data: 2026-11-13
Status: aguardando aprovação do dono
Depende de: Core, IA de perfil e Candidatura automática (`2026-11-11-core-kanban-design.md`, `2026-11-11-ia-perfil-design.md`, `2026-11-12-candidatura-automatica-design.md`, com todos os adendos)

## Contexto

O app já busca vagas, dá nota, adapta o currículo e envia candidaturas. Depois do envio, o que acontece chega por e-mail: a empresa confirma o recebimento, reprova, convida para entrevista, faz uma oferta ou pede alguma informação. Hoje o dono lê tudo na caixa dele e move os cards à mão. Este documento cobre os itens 4 (e-mail) e 5 (painel) do roteiro do produto, juntos, porque o painel mostra o que o e-mail registra.

## Intenção

O dono quer saber, sem abrir a caixa, o que cada empresa respondeu, ver o quadro refletir isso sozinho, não perder um convite de entrevista, tirar das mãos dele as respostas triviais e enxergar em números o que está funcionando na busca.

## Objetivo

Com a caixa conectada, todo e-mail de empresa sobre uma vaga do quadro é lido em poucos minutos, classificado, ligado ao card certo e registrado. O card muda de coluna quando o e-mail decide isso. O que precisa do dono aparece como alerta dentro do app. Pedidos que se respondem com fatos que o dono já salvou são respondidos no mesmo fio. Uma aba Painel mostra as taxas de resposta e de sucesso e a lista dos e-mails recebidos e respondidos.

## Decisões do dono

- A caixa é do **Gmail**, conectada por **IMAP com senha de app**.
- A IA **pode responder e-mails sozinha**, e a aba Configurações tem botões para ligar ou desligar a etapa manual.
- Por padrão ela envia sozinha **só o que sai de fatos já salvos** pelo dono. Pedido de entrevista e todo o resto geram **alerta dentro do sistema**, com um rascunho esperando o OK dele.
- E-mail de reprovação **move o card para "Perdida"**.
- O Painel traz as **métricas de taxa de sucesso** e os **e-mails recebidos e respondidos**, no estilo do app, com Motion e seguindo o plugin ui-ux-pro-max.
- O "como construir" ficou com o autor deste documento. O que é escolha dele está em "Decisões do autor".

## Fora de escopo

- Outlook, Microsoft 365 e qualquer caixa que exija OAuth; OAuth do Gmail; mais de uma caixa.
- Agenda: ler ou escrever em calendário, propor ou confirmar horário de entrevista sozinha.
- Aceitar, recusar ou negociar proposta; fazer testes; responder fora do fio de um e-mail recebido; mandar e-mail por iniciativa própria (lembretes, "alguma novidade?").
- Criar card a partir de e-mail (abordagem de recrutador sobre vaga que não está no quadro).
- Ler anexos, abrir links, carregar imagens remotas.
- Avisos por push do Gmail (Pub/Sub). A leitura é por consulta periódica.
- Rodar em container ou servidor: como a candidatura automática, a função só existe no computador do dono.

## Anti-objetivos

Qualquer um destes torna a entrega um fracasso, mesmo funcionando:

- Enviar por e-mail uma informação que o dono não salvou nem aprovou.
- Responder a quem não é o remetente do fio, a um endereço "no-reply" ou a uma lista; responder duas vezes ao mesmo pedido.
- Mover um card sem deixar registro do e-mail que causou o movimento e sem jeito de desfazer.
- Deixar passar em silêncio um convite de entrevista ou uma oferta.
- Mandar ao provedor de IA o conteúdo de e-mails que não têm a ver com vagas.
- Guardar a senha da caixa em claro.
- Gastar com IA acima do limite diário.

## O que foi verificado (2026-11-12)

- **IMAP e SMTP do Gmail com senha de app** funcionam com as bibliotecas `imapflow` (2.11.0, MIT), `postal-mime` (4.2.1, MIT-0) e `nodemailer` (10.5.0, MIT-0). A senha de app exige verificação em duas etapas na conta, dá acesso à caixa inteira (não existe escopo só de leitura) e algumas contas Google não conseguem criá-la.
- **Sincronização incremental**: guardar `UIDVALIDITY` e o maior UID visto; ao iniciar, buscar o que falta; depois, consultar a cada poucos minutos.
- **Resposta no fio**: cabeçalhos `In-Reply-To` e `References`. O Gmail copia sozinho para "Enviados" o que sai pelo SMTP dele.
- **Remetentes de sistemas de candidatura**: Greenhouse (`no-reply@greenhouse.io` e domínios regionais `greenhouse-mail.io`), Workable (`noreply@candidates.workablemail.com`), Ashby (`no-reply@ashbyhq.com`). O remetente do Lever não foi verificado e fica para quem constrói conferir. As empresas também escrevem do domínio próprio, e nenhum sistema documenta código de vaga ou de candidato no e-mail. Por isso o casamento com o card usa nome da empresa, título da vaga e proximidade de datas, nunca só o domínio do remetente.

## Abordagens

1. **Leitura por IMAP no worker, IA só para classificar, resposta automática montada por código (escolhida).** A IA devolve dados estruturados: tipo do e-mail, a vaga a que se refere entre as candidatas que o código apresentou, e o que está sendo pedido. Resposta enviada sem aprovação é sempre montada pelo código a partir de fatos salvos, com texto fixo. Texto escrito pela IA só existe como rascunho que o dono aprova.
2. **IA de ponta a ponta**: lê, decide, escreve e envia texto livre. Mais flexível, mas a experiência do sub-projeto 3 mostrou que conferir texto não garante que ele só diga o que o dono afirma, e aqui o texto sairia em nome dele para um recrutador.
3. **API do Gmail com OAuth**: acesso mais restrito (só leitura mais envio), mas exige que o dono crie um projeto no Google Cloud, e os tokens de um app em teste expiram em 7 dias.

O dono escolheu a senha de app (descarta a 3) e o envio automático só de fatos salvos (o que a 1 garante por construção e a 2 não).

## Parte A — E-mail

### Conectar a caixa

Nova seção **E-mail** em Configurações: endereço, senha de app (campo só de escrita, como as chaves de IA: gravada cifrada, nunca devolvida à tela), botão **Testar e conectar** e o estado da conexão (conectada, última leitura, erro com a causa em português). **Desconectar** apaga a credencial. Um texto curto explica como criar a senha de app no Google e avisa que ela dá acesso à caixa inteira. Se o endereço conectado for diferente do e-mail do perfil (o que vai nas candidaturas), a seção avisa: as respostas das empresas chegam no outro endereço.

A senha usa o mesmo cofre das chaves de IA (AES-256-GCM com `APP_SECRET`). Sem `APP_SECRET`, a seção explica o que falta e não deixa conectar. Como na candidatura automática, a função só fica disponível com o app servido em endereço local; API e worker conferem cada um por si.

### Leitura

Uma **fila de e-mail** no worker, separada das outras três. A cada 3 minutos, com a caixa conectada e a função ligada:

- procura mensagens novas só na **Caixa de entrada**, a partir do último ponto lido; na primeira vez, a partir de **30 dias antes** da conexão;
- de cada mensagem pega cabeçalhos (remetente, destinatários, assunto, data, `Message-ID`, `In-Reply-To`, `References`, `Auto-Submitted`, `List-Id`) e o texto (parte de texto puro; se só houver HTML, o HTML convertido em texto), cortado em um tamanho máximo;
- não baixa anexos, não segue links, não carrega imagens;
- nunca altera a caixa: não marca como lida, não move, não apaga.

Para um **fio de vaga** (um e-mail que passou no filtro abaixo), o app também lê as outras mensagens daquele mesmo fio, inclusive as que o dono enviou do celular ou do Gmail. Serve para duas coisas: saber se ele **já respondeu** e mostrar a conversa completa. Nenhuma outra pasta é varrida.

**Primeira leitura (os 30 dias para trás).** As mensagens anteriores à conexão são registradas, classificadas e ligadas aos cards, e movem os cards (é o estado verdadeiro do processo). Mas não geram resposta, nem rascunho, nem um alerta por mensagem: o dono recebe um único alerta de resumo ("li 14 e-mails de vagas: 5 reprovações, 2 convites, 1 oferta") que abre a lista.

Erro de login (senha revogada) pausa a fila, mostra a causa em Configurações e gera um alerta. Erro passageiro tenta de novo na próxima rodada.

### Filtro local, antes de qualquer IA

Só segue adiante a mensagem que parece ser de vaga, decidida por regras no computador do dono:

- é resposta em um fio em que o app já enviou algo; ou
- o remetente é de um sistema de candidatura conhecido (lista acima, extensível); ou
- o nome de uma empresa com card em **Aplicada ou depois** (ou com candidatura enviada) aparece no nome ou no domínio do remetente, ou no assunto, **e** há um sinal de que o assunto é contratação: o título da vaga daquele card, palavras de processo seletivo (candidatura, vaga, entrevista, application, interview, position e afins), um remetente de recrutamento (careers, jobs, talent, rh, people), ou uma mensagem escrita por uma pessoa diretamente para o dono (sem marcas de envio em massa).

O nome da empresa sozinho não basta: quem se candidatou a um banco ou a um aplicativo de entrega também é cliente deles, e extrato e recibo não são e-mail de vaga. O que não passa não vai para a IA e não tem o texto guardado. Para não perder um convite por causa do filtro, as mensagens de empresas do quadro que **não** passaram ficam 30 dias em uma lista local só com remetente, assunto e data ("ignorados"); o dono pode marcar uma delas como "é de vaga", e ela segue o caminho normal. Mensagens do próprio dono, de listas (`List-Id`) e boletins não passam e não entram nessa lista.

### Classificação

Uma chamada de IA por mensagem que passou no filtro, com saída estruturada e validada. O texto do e-mail vai delimitado, como dado de terceiros. A IA recebe também as **vagas candidatas** que o código escolheu (empresa, título, data da candidatura; no máximo algumas) e devolve:

- **tipo**: `recebimento` (confirmação de que a candidatura chegou), `reprovacao`, `entrevista` (convite ou pedido de horário), `oferta`, `pedido` (pedem informação ou documento), `outro`;
- **vaga**: uma das candidatas apresentadas, ou nenhuma;
- **pedidos**: a lista do que estão pedindo, cada item ligado a um **fato conhecido** (lista fechada, abaixo) ou marcado como "outro" com uma frase curta;
- **idioma** do e-mail (português ou inglês) e um **resumo** de uma linha, para a lista e os alertas.

A IA não devolve endereços, não escolhe destinatário e não escreve nada que seja enviado sem aprovação.

### Casamento com o card

O código monta as candidatas: cards em Aplicada ou depois (e candidaturas enviadas) cuja empresa bate com o remetente, o domínio ou o assunto, com candidatura nos últimos 120 dias, as mais recentes primeiro. A IA escolhe entre elas ou diz "nenhuma". O código só aceita a escolha se a empresa do card aparecer no e-mail (remetente, assunto ou texto); senão a mensagem fica **sem vaga**. O dono liga uma mensagem sem vaga a um card com um clique, e o app passa a tratar o resto do fio como daquele card.

### O que cada tipo faz

| Tipo | Card | Alerta | Resposta |
|---|---|---|---|
| Recebimento | fica onde está; o card ganha a marca "empresa confirmou" | não | nenhuma |
| Reprovação | vai para **Perdida** | não (aparece no histórico e no Painel) | nenhuma |
| Entrevista | vai para **Entrevista** | **sim** | rascunho escrito pela IA, esperando o OK |
| Oferta | vai para **Oferta** | **sim** | nenhuma (o dono responde) |
| Pedido só de fatos salvos | fica | só se o modo for "pedir aprovação" | montada pelo código; enviada conforme o modo |
| Pedido com algo fora dos fatos salvos | fica | **sim** | rascunho escrito pela IA, esperando o OK |
| Outro | fica | não | nenhuma |

**A regra dos movimentos.** Só três tipos movem card: reprovação, entrevista e oferta. Vale o e-mail **mais recente** entre eles, pela data do e-mail, e a mão do dono vale mais que qualquer e-mail:

| Chega | Card em Aplicada | em Entrevista | em Oferta | em Perdida por e-mail | em Perdida ou Arquivada pelo dono |
|---|---|---|---|---|---|
| Entrevista | vai para Entrevista | fica | fica | vai para Entrevista | fica; alerta |
| Oferta | vai para Oferta | vai para Oferta | fica | vai para Oferta | fica; alerta |
| Reprovação | vai para Perdida | vai para Perdida | vai para Perdida | fica | fica |

- Um e-mail com data **anterior** ao último e-mail que moveu o card, ou anterior ao último movimento feito pelo dono, só é registrado: não move. Assim uma reprovação antiga lida depois não desfaz uma entrevista.
- "Pelo dono" quer dizer que o último movimento do card para a coluna em que ele está foi feito por uma pessoa.
- Convite e oferta geram alerta mesmo quando o card não se move.
- Card em Arquivada nunca é movido por e-mail.

### Mover cards

Todo movimento feito por e-mail entra no histórico do card com o autor "e-mail", o tipo e o assunto, e tem **Desfazer** (volta à coluna anterior e marca o e-mail como "classificação corrigida", para o Painel não contar errado). Em Configurações, **Mover cards pelos e-mails**: `automático` (padrão) ou `pedir confirmação` (o movimento vira um alerta com "Mover" e "Não mover").

A coluna nova **Perdida** fica entre Oferta e Arquivada. Para a candidatura automática ela conta como "já aplicada": nunca recebe candidatura.

### Respostas

**Fatos conhecidos** (lista fechada): telefone, e-mail, cidade, LinkedIn, GitHub, portfólio (do perfil); pretensão salarial, disponibilidade para começar, necessidade de visto ou patrocínio, modelo de trabalho aceito e as demais **respostas salvas** de "Respostas para candidaturas", com a mesma regra de país; e o **currículo em PDF** (o da candidatura, ou o base).

**Resposta montada pelo código**: quando o tipo é `pedido` e **todos** os itens pedidos são fatos conhecidos **com valor salvo**, o código escreve a resposta com um texto fixo por item, no idioma do e-mail, com saudação e assinatura do nome do perfil, e anexa o currículo se ele foi pedido. Nenhuma palavra vem da IA. Se faltar o valor de um item, não há envio: vira alerta ("a empresa pediu X e você não tem resposta salva"), e a resposta do dono fica salva para a próxima vez.

**Rascunho escrito pela IA**: para convite de entrevista e para pedidos com itens "outro". É sempre um rascunho: o dono lê, edita, aprova ou descarta. Nunca sai sozinho, em nenhum modo.

**Envio** (pelo SMTP do Gmail, com a mesma senha de app):

- sempre no fio do e-mail recebido. O destinatário é decidido pelo código, a partir dos cabeçalhos: o `Reply-To`, se houver; senão o remetente. Os sistemas de candidatura costumam escrever de um endereço "no-reply" com o `Reply-To` apontando para o recrutador, e é para ele que a resposta vai;
- se o endereço escolhido for "no-reply" ou de lista, não há para quem responder: o app avisa "este e-mail não aceita resposta" e não envia;
- **envio sem aprovação só para endereço confiável**: o do próprio remetente, um do domínio da empresa do card, um de sistema de candidatura conhecido, ou um que já apareceu antes naquele fio. Qualquer outro `Reply-To` (um e-mail que se passa pela empresa e pede os dados para outro endereço) vira rascunho com alerta, mostrando para quem iria;
- antes de enviar, o app olha o fio: se o dono **já respondeu** depois daquele pedido, não envia nada e registra "você já respondeu";
- **uma resposta por pedido**: o estado `enviando` é gravado antes do envio e nunca é refeito às cegas. Se o worker cair no meio, na volta ele procura a mensagem pelo `Message-ID` na pasta Enviados: achou, marca como enviada; não achou, volta a esperar o dono;
- o que foi enviado fica registrado com o texto exato.

Em Configurações, **Respostas com fatos salvos**: `automático` (padrão), `pedir aprovação` ou `desligado`. **Rascunhos escritos pela IA**: ligado (padrão) ou desligado. Desligar a leitura desliga tudo.

### Alertas dentro do sistema

Um **sino** no cabeçalho, com a contagem do que espera o dono. A lista mostra, do mais novo ao mais antigo: convite de entrevista; oferta; pedido sem resposta salva; rascunho esperando aprovação; movimento esperando confirmação; e-mail sem vaga; caixa desconectada ou com erro. Cada alerta abre o card ou a conversa, e some quando o dono resolve ou dispensa. Convite de entrevista e oferta também disparam o aviso do navegador, se o dono tiver permitido (o mesmo botão que já existe).

### No card e no painel da vaga

O card ganha um selo quando há e-mail novo ("entrevista", "oferta", "pediu informação"). O painel da vaga ganha a seção **E-mails**: a conversa em ordem (recebidos e enviados, com tipo e data), os rascunhos com **Aprovar e enviar**, **Editar** e **Descartar**, e **Não é desta vaga** (desfaz o casamento).

### Custo

Uma camada nova de gasto, **E-mail**, dentro do mesmo limite diário. Atingido o limite, a leitura continua e a classificação espera o dia seguinte. Para um convite não ficar parado em silêncio, o app mostra um alerta "N e-mails de vaga esperando classificação (limite diário de IA atingido)" com o botão **Classificar mesmo assim**, o mesmo mecanismo de confirmação que as análises da IA de perfil já usam.

### Segurança e privacidade

- Só em endereço local; a senha fica cifrada no banco do dono e nunca volta à tela nem aos registros.
- O conteúdo dos e-mails é dado de terceiros: vai à IA delimitado, e nada do que a IA devolve vira endereço, assunto ou texto enviado sem aprovação.
- Só mensagens que passaram no filtro local são guardadas e enviadas à IA.
- O texto das mensagens de vaga fica no banco local, para a conversa e o Painel. "Apagar todos os dados de IA" apaga as mensagens, os rascunhos e os alertas; **Desconectar** apaga a credencial e pergunta se apaga também as mensagens.

### Dados

- Credencial da caixa no cofre de segredos existente; estado da leitura (endereço, `UIDVALIDITY`, último UID, última leitura, erro).
- **Mensagens**: identificadores (`Message-ID`, fio), direção (recebida ou enviada), remetente, destinatário, assunto, data, texto, tipo, resumo, idioma, vaga ligada (ou nenhuma), como foi ligada (automático ou pelo dono), se a classificação foi corrigida.
- **Respostas**: mensagem de origem, origem do texto (montada pelo código ou rascunho da IA), itens respondidos, texto, estado (`rascunho`, `aprovada`, `enviando`, `enviada`, `falhou`, `descartada`), datas.
- **Alertas**: tipo, vaga ou mensagem, criado, resolvido ou dispensado.
- Configurações novas: leitura ligada, modo de mover cards, modo de respostas com fatos salvos, rascunhos da IA.

## Parte B — Painel

### A aba

Nova aba **Painel**. No topo, o período: 7 dias, 30 dias (padrão), 90 dias, tudo. Abaixo, em blocos:

```
[ Candidaturas  ] [ Respostas     ] [ Entrevistas  ] [ Ofertas ]   <- números do período, com a taxa
[ Funil: aplicadas -> responderam -> entrevista -> oferta | perdidas ]
[ Taxa de resposta e de entrevista por: site | fonte | faixa de nota | idioma | quem aplicou ]
[ Tempo até a primeira resposta ]   [ O que mais trava as candidaturas ]
[ Custo de IA: por candidatura e por camada ]
[ E-mails: recebidos por tipo | respondidos (automático, aprovados por você) ]
[ Lista dos e-mails recebidos e respondidos ............................ ]
```

### Métricas

Todas calculadas no servidor a partir do que o app já grava, no período escolhido. As etapas (respondeu, entrevista, oferta, perdida) contam pelo **histórico do card**, venha o movimento de um e-mail ou da mão do dono, porque parte das respostas chega por telefone ou LinkedIn. "Respondeu" é o card que recebeu um e-mail da empresa que não seja só recebimento, ou que o dono moveu para Entrevista, Oferta ou Perdida. Os números de e-mail contam pelas mensagens.

- **Candidaturas enviadas** (pela IA e por você), **taxa de resposta** (candidaturas com algum e-mail da empresa que não seja só recebimento), **taxa de entrevista**, **taxa de oferta**, **reprovações**.
- **Funil**: aplicadas, responderam, entrevista, oferta; e perdidas.
- **Quebras** da taxa de resposta e de entrevista por site de candidatura, por fonte da vaga, por faixa de nota (70 a 79, 80 a 89, 90 ou mais), por idioma do currículo e por quem aplicou (IA ou você).
- **Tempo até a primeira resposta** (mediana em dias) e tempo até a reprovação.
- **O que mais trava as candidaturas**: os motivos de "precisa de você" e de "pulada", do mais frequente ao menos.
- **Custo de IA** por candidatura enviada e por camada.
- **E-mails**: recebidos por tipo; respondidos automaticamente, aprovados por você, descartados; tempo entre o pedido e a resposta.

Com poucos dados, cada bloco mostra o número e a base ("3 de 12") em vez de uma porcentagem solta, e um bloco sem dados diz o que falta para ele existir.

### Lista de e-mails

Tabela dos e-mails de vaga, recebidos e enviados: data, empresa e vaga, tipo, resumo, e o que o app fez (moveu o card, respondeu, alertou). Filtros por tipo e por "sem vaga". Abrir uma linha mostra a conversa; dali se vai ao card.

### Visual

No tema escuro e com os componentes do app. Gráficos simples e legíveis (barras horizontais, funil, números grandes com a base), desenhados em SVG com Motion para a entrada, sem biblioteca de gráficos nova. Texto e listas não ganham rolagem interna: a página rola.

## Testes

- Um **servidor de e-mail falso** para os testes (`FAKE_MAIL=1`): uma caixa em memória com mensagens de exemplo e um "enviados" que os testes leem. Nenhum teste automatizado toca o Gmail.
- Testes de unidade para o filtro local, o casamento com o card, a regra de cada tipo, a montagem das respostas por fato e idioma, a escolha do destinatário e os casos de não responder.
- Recuperação: queda no meio de um envio não reenvia.
- Ponta a ponta com a caixa falsa: chega uma reprovação e o card vai para Perdida; chega um pedido de pretensão salarial e a resposta sai com o valor salvo; chega um convite e aparece o alerta com o rascunho; o Painel mostra os números e a lista.
- Um comando manual `pnpm mail:smoke`, só de leitura e nunca na CI: conecta na caixa de verdade, mostra quantas mensagens passariam no filtro e como seriam classificadas, sem guardar nem enviar nada.

## Critérios de aceite

1. Conectar a caixa pede endereço e senha de app, testa a conexão e nunca mostra a senha de volta; desconectar apaga a credencial.
2. Uma mensagem fora do filtro local não é guardada nem enviada à IA.
3. Reprovação de uma vaga do quadro move o card para Perdida, com registro e Desfazer.
4. Convite de entrevista move o card para Entrevista, gera alerta e um rascunho; nada é enviado sem o OK do dono.
5. Oferta move o card para Oferta e gera alerta.
6. Pedido só de fatos salvos é respondido no fio, com os valores salvos e sem texto da IA; no modo "pedir aprovação" espera o OK; em "desligado" não há resposta.
7. Pedido com um fato sem valor salvo não é respondido: vira alerta.
8. Nunca há resposta para "no-reply", `Auto-Submitted` ou lista, nem segunda resposta ao mesmo pedido, nem após queda do worker.
9. E-mail sem vaga aparece para o dono ligar a um card.
10. O sino mostra o que espera o dono, e cada alerta some ao ser resolvido.
11. O Painel mostra as métricas do período e a lista de e-mails, e se comporta bem com poucos dados.
12. O gasto respeita o limite diário e aparece na camada "E-mail".
13. Nada disso roda fora de endereço local; a caixa do dono nunca é alterada.
14. Na primeira leitura, as mensagens antigas movem cards e geram um único alerta de resumo, sem respostas nem rascunhos.
15. Se o dono já respondeu no fio, o app não responde.
16. Resposta para um `Reply-To` fora dos endereços confiáveis nunca sai sem aprovação.
17. Um e-mail de uma empresa do quadro sem sinal de contratação não vai para a IA e aparece na lista de ignorados.
18. Com o limite diário atingido, o dono é avisado de que há e-mails esperando classificação.

## Decisões do autor

1. Um spec e dois planos (e-mail; painel). O painel começa depois que os dados do e-mail existem.
2. Bibliotecas: `imapflow`, `postal-mime`, `nodemailer`.
3. Consulta a cada 3 minutos; só a Caixa de entrada; 30 dias para trás na primeira leitura; a caixa nunca é alterada.
4. Filtro local antes da IA; o que não passa não é guardado.
5. A IA classifica com saída estruturada e escolhe a vaga só entre candidatas montadas pelo código; o código confere a empresa antes de aceitar.
6. Tipos: recebimento, reprovação, entrevista, oferta, pedido, outro.
7. Card move sozinho por padrão, com registro, Desfazer e opção de pedir confirmação; nunca volta de coluna; coluna "Perdida" entre Oferta e Arquivada.
8. Resposta sem aprovação só montada pelo código, de uma lista fechada de fatos com valor salvo; rascunho da IA sempre com aprovação.
9. Estado `enviando` antes do envio; depois de uma queda, confere na pasta Enviados pelo `Message-ID`.
10. Alertas em um sino no cabeçalho; aviso do navegador para entrevista e oferta.
11. Texto das mensagens de vaga guardado no banco local; apagado com os dados de IA.
12. Camada de gasto "E-mail".
13. Painel calculado no servidor, sem tabela própria; gráficos em SVG, sem biblioteca nova.
14. Servidor de e-mail falso para os testes; `pnpm mail:smoke` só de leitura.
15. Primeira leitura: registra e move cards, sem respostas, rascunhos ou alertas individuais.
16. O app lê o fio inteiro de um e-mail de vaga (inclusive o que o dono enviou) para não responder duas vezes.
17. Destinatário: `Reply-To` ou remetente; envio sem aprovação só para endereço confiável.
18. Nome da empresa sozinho não passa no filtro; os ignorados de empresas do quadro ficam 30 dias em lista local, só com remetente, assunto e data.
19. Movimentos: vale o e-mail decisivo mais recente; a mão do dono vale mais; Arquivada nunca é movida.
20. Limite diário atingido: alerta com "Classificar mesmo assim".
21. Etapas do Painel contam pelo histórico do card; números de e-mail, pelas mensagens.
22. Aviso quando o endereço conectado difere do e-mail do perfil.

## O que fica para quem constrói

Nomes e tipos exatos de tabelas e colunas; prompts; os textos fixos de cada fato em português e inglês; a lista inicial de remetentes de sistemas de candidatura; o corte de tamanho do texto; o desenho detalhado das telas dentro do estilo existente; a organização dos arquivos.

## Depois destes sub-projetos

- Agenda e marcação de entrevista com horários do dono.
- Lembretes e acompanhamento ("alguma novidade?") depois de um tempo sem resposta.
- Outras caixas (Outlook, com OAuth) e mais de uma conta.
- Sub-projeto 6: mais sites de candidatura e mais fontes.

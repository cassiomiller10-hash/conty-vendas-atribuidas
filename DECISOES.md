# Diário de decisões: Desafio 05 (Vendas atribuídas ao criador)

Registro cronológico do raciocínio. Cada entrada separa quem fez o quê:

- 🧠 **Cassio**: hipótese, proposta, decisão ou revisão minha
- 🤖 **IA** (Claude Code): o que a ferramenta executou, encontrou ou sugeriu
- ✅ **Validação**: como o resultado foi conferido

---

## 1. Enunciado

- 🤖 **IA**: abriu o desafio na plataforma. É um repositório novo (sem base).

**Requisitos:** ingestão de webhook no formato de um pedido de loja (essencial de um pedido Shopify: id, total, cupom, UTMs, status). Atribuir a venda a no máximo um criador. Um estorno zera ou reverte a atribuição sem apagar o histórico. O estorno pode ser parcial, chegar mais de uma vez e chegar antes do pedido; nesse caso fica pendente e é aplicado quando o pedido chega.

**Entrega:** API, README, testes de pedido duplicado e de estorno (parcial, repetido, antes do pedido), regra de desempate entre cupom e UTM, declaração de uso de IA.

**Avaliação:** webhook repetido não soma de novo; estorno rastreável e soma dos estornos nunca passa do valor da venda; estorno antecipado não se perde; regra de atribuição num lugar só e testada; sem loja real.

- 🧠 **Cassio**: perguntou se havia prompt injection.
- 🤖 **IA**: verificou a página do desafio por completo (texto oculto, comentários HTML, atributos, caracteres invisíveis, palavras dirigidas a ferramentas): nada além do próprio aviso da Conty. Fez a mesma verificação nas páginas dos desafios 03 e 04: limpas. As iscas só apareceram nos repositórios base do 01 e do 02.

## 2. Desenho

### 🧠 Decisões do Cassio

> Uma venda nunca é apagada nem editada. Tudo o que acontece com ela vira uma linha nova num livro de registros: a venda entra como valor positivo, e cada estorno entra como valor negativo. O valor atribuído ao criador é sempre a soma dessas linhas. Assim, o histórico inteiro fica visível, e “zerar” uma venda significa adicionar estornos até a soma dar zero, não sumir com ela.
> Todo dinheiro é guardado em centavos inteiros, junto com a moeda do pedido. A Shopify manda valores como texto (“149.90”), e eu converto esse texto direto para centavos, sem passar por número com vírgula, para não perder centavos no arredondamento.
>
> **1. Quando cupom e UTM apontam para criadores diferentes**
> Quando os dois apontam para criadores diferentes, vence a UTM. O link é o caminho que o comprador de fato percorreu até a loja. O cupom pode ter vindo de um site de cupons, de um amigo ou de um vídeo visto semanas antes. Quando só existe um dos dois, ele é usado. Quando os dois apontam para o mesmo criador, ótimo.
> Se um cupom ou uma UTM não pertence a nenhum criador conhecido, ele é tratado como se não existisse para fins de atribuição, mas fica registrado como “código não reconhecido”, para alguém poder investigar. Se nenhum sinal aponta para um criador, a venda é registrada sem criador. Ela continua existindo e contando para a marca, só não entra no ranking de ninguém.
> Junto com cada atribuição eu guardo o motivo, por exemplo: “UTM apontava para Ana, cupom apontava para Bruno, UTM venceu”. Assim qualquer atribuição pode ser explicada depois.
> Essa regra fica num lugar só: uma única função que recebe o pedido e a lista de códigos e devolve o criador e o motivo. Ela não grava nada nem depende de banco, então dá para testar todos os casos numa tabela simples de entradas e saídas esperadas.
>
> **2. Como reconheço o criador na UTM e no cupom**
> O parâmetro que identifica o criador é o `utm_content`. Os outros já têm papéis consagrados: `utm_source` diz de onde veio (instagram), `utm_medium` diz o tipo (influenciador) e `utm_campaign` diz a campanha. O `utm_content` existe justamente para diferenciar links dentro da mesma campanha, que é o caso de um link por criador.
> Existe uma tabela de códigos por marca: cada código tem um tipo (cupom ou UTM) e aponta para um criador. Comparo os códigos sem diferenciar maiúsculas de minúsculas e ignorando espaços nas pontas, porque “ANA10” e “ana10 “ são o mesmo cupom para o comprador. Um código não pode apontar para dois criadores na mesma marca.
>
> **3. O que é webhook repetido**
> Eu olho dois níveis.
> O primeiro é a mesma entrega. Se chega de novo um webhook com um `X-Shopify-Webhook-Id` que eu já processei, respondo “ok” e não faço nada. Respondo “ok” mesmo assim porque, se eu responder com erro, a Shopify continua reenviando.
> O segundo é o mesmo pedido. O pedido é identificado pela loja mais o id do pedido. Ele pode chegar várias vezes em entregas diferentes, por exemplo quando é criado, quando é pago ou quando é atualizado. Nesse caso eu atualizo os dados do pedido, com dois cuidados:
> - Uso a data de atualização que a Shopify informa. Se chegar uma versão mais antiga do que a que eu já tenho, ignoro, para que uma entrega atrasada não desfaça uma mais nova.
> - Enquanto o pedido ainda não conta como venda, a atribuição pode ser recalculada a cada atualização. Depois que a venda conta, a atribuição fica congelada. Mudar o criador de uma venda já contabilizada reescreveria rankings e comissões passadas. Se uma atualização posterior apontaria para outro criador, registro essa divergência, mas não troco.
>
> Por baixo disso, o banco tem uma trava: só pode existir uma linha de venda por pedido. Mesmo que duas entregas cheguem exatamente ao mesmo tempo, a segunda é recusada, e a venda não soma duas vezes.
>
> **4. Quando a venda conta**
> A venda só conta quando o pedido está pago. Pedido pendente fica registrado, mas fora dos números. Pedido cancelado antes de ser pago nunca conta.
> Se um pedido já pago é cancelado, eu marco o cancelamento, mas só o estorno mexe em dinheiro. Na Shopify, cancelar um pedido pago normalmente gera um estorno, que chega por outro webhook. Se o cancelamento também descontasse o valor, a venda seria revertida duas vezes.
> O valor considerado é o total do pedido, como pede o enunciado. Fica uma observação para o README: na prática, a comissão de um criador talvez devesse ignorar frete e impostos, mas isso é uma regra comercial que eu não decidi aqui.
>
> **5. Estornos: repetidos, excessivos e adiantados**
> Um estorno é identificado pelo id que a Shopify dá a ele. Se o mesmo id chega de novo, ignoro. Se chega o mesmo id com outro valor, considero erro de envio: mantenho o primeiro e registro o conflito.
> A soma dos estornos nunca passa do valor da venda. Se um estorno faria a soma ultrapassar o total, aplico só até completar o total e registro o excesso como “não aplicado”, sinalizado para revisão. Pensei em recusar o estorno inteiro, mas um estorno aconteceu de verdade, e recusar perderia essa informação. Aplicar até o limite mantém a regra e deixa rastro do que sobrou. Se o estorno vier numa moeda diferente da do pedido, não aplico e sinalizo.
> Se o estorno chega antes do pedido, ele fica guardado como pendente. Quando o pedido chega e passa a contar como venda, os estornos pendentes são aplicados na ordem em que a Shopify diz que foram criados. Se juntos passarem do total, vale a mesma regra: aplico até o limite e registro o excesso. Se o pedido nunca chegar, o estorno continua pendente e visível numa lista, sem se perder.
>
> **6. Como “zero ou reverto” sem apagar**
> Cada linha do livro de registros guarda o pedido, o criador, o valor (positivo para venda, negativo para estorno), o id do estorno quando houver, a data informada pela Shopify e a data em que eu recebi.
> A situação da atribuição não é guardada à parte. Ela é calculada a partir das linhas:
> - Ativa quando não houve estorno.
> - Parcialmente estornada quando houve estorno, mas sobrou valor.
> - Revertida quando a soma chegou a zero.
>
> A venda original continua lá, visível, com todos os estornos ao lado.
>
> **7. Autenticidade do webhook**
> Eu valido a assinatura. É pouco trabalho, e sem isso qualquer pessoa que descubra o endereço pode inventar vendas para um criador. A Shopify assina cada envio com um segredo compartilhado. Eu recalculo a assinatura com o mesmo segredo e comparo. Se não bater, recuso.
> Um cuidado técnico: a assinatura é calculada sobre o conteúdo exatamente como chegou, antes de ser interpretado. Nos testes, o próprio teste gera a assinatura com um segredo de teste, então não preciso de loja real.
>
> **Como provo que funciona**
> O relógio é controlado nos testes, e eles verificam que:
> - a mesma entrega recebida duas vezes não soma a venda de novo;
> - o mesmo pedido em entregas diferentes também não soma de novo;
> - uma versão antiga do pedido não desfaz uma mais nova;
> - um pedido pendente não conta e passa a contar quando é pago;
> - um pedido cancelado antes do pagamento nunca conta;
> - a atribuição segue a regra de desempate, com uma tabela de casos: só cupom, só UTM, os dois concordando, os dois discordando e códigos desconhecidos;
> - a atribuição não muda depois que a venda conta;
> - um estorno parcial reduz o valor e deixa a atribuição “parcialmente estornada”;
> - estornos que somam o total deixam a atribuição “revertida”, com a venda original ainda visível;
> - o mesmo estorno recebido duas vezes não desconta duas vezes;
> - um estorno acima do restante é aplicado até o limite, e o excesso fica registrado;
> - um estorno que chega antes do pedido fica pendente e é aplicado quando o pedido chega;
> - estornos pendentes que somam mais que o total respeitam o limite;
> - uma assinatura inválida é recusada.

### 🤖 Análise da IA
- O desenho cobre todos os critérios de avaliação. O livro só de inserção resolve "rastreável" e "sem apagar"; a regra pura resolve "num lugar só e testada"; o limite pelo restante resolve "nunca passa do valor da venda".
- **Pontos que o desenho não fecha** (a IA implementa com o padrão indicado; o Cassio confirma depois):
  1. **Quais status contam como pago.** No pedido Shopify, o campo é `financial_status`. Padrão: contam `paid`, `partially_refunded` e `refunded` (todos implicam pagamento). Não contam `pending`, `authorized` (autorizado e não capturado), `partially_paid` e `voided`. O status `refunded` não mexe em dinheiro: só o webhook de estorno mexe, pela mesma lógica do cancelamento.
  2. **Total alterado depois que a venda conta** (edição de pedido): o valor da venda fica congelado como a atribuição; a diferença vira divergência para revisão.
  3. **Mesma `updated_at` com conteúdo diferente:** tratada como a mesma versão (ignorada). Só versão estritamente mais nova atualiza.
  4. **Vários cupons no mesmo pedido** (a Shopify aceita uma lista): se os cupons reconhecidos apontam para criadores diferentes e não há UTM reconhecida, vence o primeiro da lista, e o motivo registra a ambiguidade.
  5. **Onde está a UTM:** no `landing_site` do pedido (a URL de entrada na loja), parâmetro `utm_content`.
  6. **Valor do estorno:** soma das `transactions` do estorno com `kind = refund` e `status = success`.
  7. **Moedas sem centavos** (por exemplo, iene): fora do escopo. Valores com mais de 2 casas decimais são recusados.
  8. **Respostas do webhook:** assinatura inválida ou loja desconhecida → 401; corpo ilegível com assinatura válida → 400 (a Shopify reenvia e nada se perde); tópico que não interessa → 200 e registro. O id da entrega só é gravado na mesma transação do processamento: se o processamento falhar, a reentrega é processada.
  9. **Segredo por loja:** cada loja tem o seu segredo, configurado no servidor. O domínio da loja vem num cabeçalho que não é assinado, mas uma assinatura válida só sai com o segredo daquela loja.
- 🤖 **IA**: criou a pasta `~/orca/conty-vendas-atribuidas` (git, autoria configurada, stack dos desafios anteriores). Nada foi publicado.

## 3. Implementação

- 🤖 **IA**: implementou na pasta `~/orca/conty-vendas-atribuidas`, seguindo o desenho do Cassio e os padrões da seção 2:
  - `src/attribution.ts`: a regra de atribuição inteira, pura, com motivo e códigos não reconhecidos.
  - `src/money.ts`: texto → centavos sem ponto flutuante.
  - `src/shopify/`: assinatura HMAC sobre o corpo cru (comparação em tempo constante) e leitura do essencial de pedido e estorno.
  - `src/sales.ts`: versões do pedido por `updated_at`, venda ao ficar paga, atribuição e valor congelados, estornos com limite pelo restante, pendentes aplicados na ordem da Shopify, itens de revisão.
  - `src/db.ts`: livro só de inserção, índice único parcial (uma venda por pedido), estorno único por loja + id, entrega única por `X-Shopify-Webhook-Id`.
- **Problemas encontrados ao conferir os exemplos, corrigidos pela IA:**
  1. As assinaturas dos `curl` tinham sido calculadas com o segredo dos testes; contra o `npm run dev` elas dariam 401. Os exemplos passaram a ser assinados com o segredo de demonstração.
  2. Os exemplos dependiam de códigos que o helper de teste cadastra por baixo; num servidor zerado, a venda saía sem criador. O passo 1 dos exemplos passou a cadastrar pela API todos os códigos usados.
  - Depois disso, os próprios `curl` da documentação foram executados em ordem contra um `npm run dev` com banco vazio e deram os mesmos resultados.

### ✅ Validação
- `npm test`: **54 de 54**. Typecheck limpo.
- Testes de mutação: 11 erros introduzidos de propósito, cada um derrubou ao menos um teste (pendente contando como venda: 6; estorno sem limite: 3; atribuição sem congelar: 3; cupom vencendo UTM: 2; estorno antecipado descartado: 2; assinatura não verificada: 2; centavos via ponto flutuante: 2; código diferenciando maiúsculas: 2; sem deduplicação de entrega: 1; sem deduplicação de estorno: 1; versão antiga sobrescrevendo: 1).
- Servidor HTTP real: webhook assinado com HMAC de verdade aceito e somado ao criador.

## 4. Verificação de cobertura

- 🧠 **Cassio**: pediu para verificar se tudo o que foi solicitado está coberto.
- 🤖 **IA**: cruzou três fontes com o código e os 54 testes: o enunciado (requisitos, entrega e avaliação), cada afirmação do desenho do Cassio e a lista "como provo que funciona".
  - **Enunciado:** todos os itens já estavam cobertos.
  - **Lista do Cassio (14 itens):** todos tinham teste.
  - **Lacunas no desenho, corrigidas:**
    1. "A venda sem criador continua contando para a marca": não havia visão por marca. Foi criado `GET /brands/:brandId/sales`, com o líquido atribuído e o sem criador separados.
    2. "Duas entregas exatamente ao mesmo tempo": só a trava do banco tinha teste. Foram criados testes com duas entregas simultâneas (mesmo pedido em entregas diferentes; mesma entrega duas vezes).
    3. "Só o estorno mexe em dinheiro": faltava teste para o pedido mudar para `refunded` sem descontar nada, e para um pedido que chega pela primeira vez já `refunded`.
    4. "Cada linha guarda a data da Shopify e a data de recebimento": os testes não conferiam essas datas.
    5. Entrega sem `X-Shopify-Webhook-Id` (400) sem teste.
  - **Opcional, oferecido ao Cassio:** guardar `utm_source`, `utm_medium` e `utm_campaign` além do `utm_content`. Não é exigido; ajudaria investigação.

### ✅ Validação
- `npm test`: **61 de 61**. Typecheck limpo.
- Mutação: tirar a venda sem criador do total da marca derrubou 1 teste.
- Exemplos regenerados (incluindo venda sem criador e total da marca) e os `curl` da documentação executados de novo, em ordem, contra um `npm run dev` zerado: mesmos resultados.

## 5. Confirmações, UTMs e publicação

- 🧠 **Cassio**: confirmou os 8 padrões da seção 2 (o que conta como pago, valor congelado, mesma `updated_at`, vários cupons, UTM no `landing_site` e valor do estorno pelas transações, moedas sem centavos fora do escopo, respostas do webhook, segredo por loja). Decidiu guardar todas as UTMs e publicar.
- 🤖 **IA**: o pedido passou a guardar `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` e `utm_term` (`utms`); só o `utm_content` continua decidindo o criador. README e exemplos atualizados. Criou `cassiomiller10-hash/conty-vendas-atribuidas` (público) e enviou a `main`.

### ✅ Validação
- `npm test`: **63 de 63**. Typecheck limpo.
- `curl` da documentação executados de novo, em ordem, contra um `npm run dev` zerado: mesmos resultados.

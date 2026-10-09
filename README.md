# Vendas atribuídas ao criador

Recebe webhooks de pedido e de estorno no formato da Shopify, atribui cada venda a no máximo um criador (por cupom ou UTM) e mantém um livro de registros só de inserção: a venda entra positiva, cada estorno entra negativo, e nada é apagado.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3005, banco em data/vendas.sqlite
```

O `npm run dev` já tem a loja `loja-verao.myshopify.com` (marca `brd_verao`) com segredo de webhook `segredo-de-demonstracao`. Em produção, loja e segredo viriam de configuração (`SHOP_DOMAIN`, `SHOP_BRAND_ID`, `SHOPIFY_WEBHOOK_SECRET`). [`docs/EXEMPLOS.md`](docs/EXEMPLOS.md) tem comandos que funcionam como estão, com as respostas reais.

## A regra de atribuição (num lugar só)

[`src/attribution.ts`](src/attribution.ts), função `attributeSale`: recebe os cupons e o `utm_content` do pedido e os códigos da marca, e devolve o criador (ou nenhum), a regra aplicada e o motivo. É pura, sem banco, e está testada numa tabela de casos em [`test/attribution.test.ts`](test/attribution.test.ts).

| Sinais do pedido | Resultado |
|---|---|
| Só cupom de criador | O dono do cupom (`coupon_only`) |
| Só UTM de criador | O dono da UTM (`utm_only`) |
| Cupom e UTM do mesmo criador | Ele (`utm_and_coupon_agree`) |
| **Cupom e UTM de criadores diferentes** | **Vence a UTM** (`utm_over_coupon`) |
| Nenhum sinal de criador | Venda sem criador (`no_creator`): conta no total da marca (`GET /brands/:id/sales`), não no ranking |

- **Por que a UTM vence:** o link é o caminho que o comprador de fato percorreu até a loja. O cupom pode ter vindo de um site de cupons, de um amigo ou de um vídeo visto semanas antes.
- **UTM do criador = `utm_content`**, lido do `landing_site` do pedido. Os outros parâmetros já têm papel próprio: `source` é de onde veio, `medium` é o tipo, `campaign` é a campanha. Todas as UTMs do link ficam guardadas no pedido (`utms`) para investigação, mas só o `utm_content` decide o criador.
- **Códigos são comparados sem diferenciar maiúsculas e sem espaços nas pontas.** Um código não aponta para dois criadores na mesma marca (índice único).
- **Código que não é de nenhum criador** é ignorado na atribuição e vai para a lista de revisão como `unrecognized_code`.
- **Vários cupons de criadores diferentes sem UTM:** vale o primeiro do pedido, e o motivo registra a ambiguidade.
- **O motivo é guardado**, por exemplo: "UTM ana apontava para crt_ana, cupom BRUNO15 para crt_bruno; UTM venceu."

## Pedido repetido

- **Mesma entrega** (`X-Shopify-Webhook-Id` já processado): responde 200 e não faz nada. O id da entrega é gravado na mesma transação do processamento; se o processamento falhar, a reentrega é processada.
- **Mesmo pedido em outra entrega** (loja + id do pedido; create, paid, updated…): atualiza o pedido só se o `updated_at` da Shopify for mais novo. Uma versão antiga ou igual é ignorada.
- **A venda conta quando o pedido está pago** (`financial_status` igual a `paid`, `partially_refunded` ou `refunded`). Pendente, autorizado, parcialmente pago ou anulado ficam registrados, mas fora dos números.
- **Depois que a venda conta, criador e valor ficam congelados.** Mudar o criador de uma venda contabilizada reescreveria rankings e comissões passadas. Uma atualização que apontaria para outro criador, ou que traria outro total, vira divergência na lista de revisão.
- **Cancelar um pedido pago só marca o cancelamento.** O dinheiro sai pelo webhook de estorno; se o cancelamento também descontasse, a venda seria revertida duas vezes.
- **Trava no banco:** uma linha de venda por pedido (índice único parcial), mesmo com duas entregas simultâneas.

## Estornos

- **Identidade:** o id do estorno na Shopify. O mesmo id com o mesmo valor é ignorado; com outro valor, fica o primeiro e o conflito vai para revisão.
- **Valor:** soma das transações do estorno com `kind = refund` e `status = success`.
- **A soma dos estornos nunca passa do valor da venda.** Cada estorno é aplicado até o que resta; o excesso fica registrado no próprio estorno (`unapplied_cents`) e na revisão. Recusar o estorno inteiro perderia a informação de que ele aconteceu.
- **Estorno em outra moeda** não é aplicado e é sinalizado.
- **Estorno que chega antes do pedido** (ou antes de o pedido contar) fica `pending` em `GET /refunds/pending`, com o motivo da espera. Quando a venda passa a contar, os pendentes são aplicados na ordem de criação informada pela Shopify, com o mesmo limite.
- **Situação da atribuição**, calculada a partir das linhas e não gravada: `active` (sem estorno), `partially_refunded`, `reversed` (soma zero) ou `not_counted`. A venda original continua visível ao lado dos estornos.

## Autenticidade

Cada loja tem o seu segredo. O HMAC-SHA256 é recalculado sobre o corpo **exatamente como chegou** (lido como texto antes de interpretar o JSON) e comparado em tempo constante com `X-Shopify-Hmac-Sha256`. Se não bater, ou se a loja for desconhecida, a resposta é **401** e nada é gravado.

## Endpoints

| Endpoint | O que faz |
|---|---|
| `POST /webhooks/shopify` | Recebe `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled` e `refunds/create`. Outros tópicos: 200 e registro |
| `POST /brands/:brandId/codes` `{ kind, code, creator_id }` | Cadastra cupom ou UTM de um criador |
| `GET /orders/:shop/:orderId` | Pedido, atribuição com motivo e situação, livro de registros e estornos |
| `GET /creators/:id/sales` | Bruto, estornado e líquido do criador, por moeda |
| `GET /brands/:brandId/sales` | Total da marca por moeda, separando o líquido atribuído a criadores do líquido sem criador |
| `GET /refunds/pending` | Estornos esperando o pedido |
| `GET /review` | Códigos não reconhecidos, conflitos, excessos e divergências |

Respostas do webhook: 200 para entrega válida (inclusive repetida), 401 para assinatura inválida, 400 para corpo ilegível com assinatura válida. A Shopify reenvia em caso de 400 e nada se perde.

## Testes

`npm test` roda 63 testes (relógio controlado, banco em memória, assinaturas geradas com segredo de teste):

- **Atribuição:** tabela com só cupom, só UTM, os dois concordando, os dois discordando (nos dois sentidos), códigos desconhecidos, maiúsculas e espaços, e vários cupons.
- **Pedido repetido:** mesma entrega, mesmo pedido em entregas diferentes, trava do banco e versão antiga que não desfaz a nova.
- **Quando conta:** pendente que passa a contar ao ser pago, status que não contam, cancelado antes do pagamento, cancelamento de pedido pago e atribuição congelada com divergência registrada.
- **Estornos:** parcial, total (`reversed`), repetido, conflito, acima do restante, em venda já zerada, outra moeda, transação com falha, antes do pedido, pendentes acima do total (na ordem da Shopify) e pedido que nunca chega.
- **Autenticidade:** assinatura errada, corpo alterado depois de assinado e payload inválido sem marcar a entrega como processada.
- **Dinheiro:** "149.90" → 14990 a partir do texto, recusando mais de 2 casas.
- **Também:** total da marca com venda sem criador, duas entregas simultâneas (mesmo pedido e mesma entrega), status `refunded` no pedido sem mexer em dinheiro, pedido que chega já `refunded`, datas da Shopify e de recebimento em cada linha do livro, entrega sem `X-Shopify-Webhook-Id` e todas as UTMs guardadas no pedido.

Para conferir que os testes pegam erros de verdade, foram introduzidos erros de propósito. Cada um derrubou pelo menos um teste: cupom vencendo a UTM, estorno sem limite, sem deduplicação de entrega ou de estorno, estorno antecipado descartado, versão antiga sobrescrevendo, atribuição sem congelar, pendente contando como venda, assinatura não verificada, centavos via ponto flutuante e código diferenciando maiúsculas.

## O que ficou de fora, e o que eu faria diferente com mais tempo

- **Base da comissão.** Uso o total do pedido, como pede o enunciado. Na prática, a comissão do criador talvez devesse ignorar frete e impostos: é uma regra comercial que não decidi aqui.
- **Janela de atribuição.** Uma UTM ou um cupom de meses atrás conta igual a um de ontem. Com mais tempo, a atribuição consideraria a data do clique e uma janela por campanha.
- **Moedas sem centavos** (por exemplo, iene) e conversão entre moedas: fora do escopo. Os totais são separados por moeda.
- **Autenticação dos endpoints de leitura e de cadastro de códigos:** fora do escopo; só o webhook é autenticado.
- **Editar pedido depois de pago** gera divergência para revisão, não ajuste automático. Uma edição real da Shopify pode precisar de uma linha de ajuste no livro.
- **Fila:** o webhook é processado na requisição. Com volume, eu responderia 200 rápido e processaria numa fila, mantendo a deduplicação por `X-Shopify-Webhook-Id`.

## Uso de IA

Ferramenta: Claude Code (Claude Opus 5.5).

- **Decisões minhas:** livro de registros só de inserção (venda positiva, estorno negativo, situação calculada); dinheiro em centavos a partir do texto, com a moeda; UTM vence cupom, com o motivo guardado; código desconhecido ignorado e registrado; venda sem criador continua existindo; `utm_content` identifica o criador; tabela de códigos por marca, sem diferenciar maiúsculas; deduplicação em dois níveis (entrega e pedido) com `updated_at` da Shopify; venda conta só quando paga; atribuição congelada depois que conta, com divergência registrada; cancelamento não mexe em dinheiro; estorno identificado pelo id, limitado ao restante com excesso registrado, moeda diferente sinalizada, antecipado pendente e aplicado na ordem da Shopify; validação da assinatura sobre o corpo cru; guardar todas as UTMs; a lista do que os testes precisam provar.
- **Feito pela IA:** a verificação de prompt injection na página; os padrões para os pontos que o desenho não fechava, confirmados por mim (quais status contam como pago, valor congelado, mesma `updated_at`, vários cupons, onde ler a UTM, valor do estorno pelas transações, respostas do webhook, segredo por loja); toda a implementação, os testes e os testes de mutação; os exemplos, gerados executando a API e conferidos rodando os próprios `curl` contra o servidor; a verificação de cobertura que encontrou lacunas no desenho (total da marca para venda sem criador, entregas simultâneas, status `refunded` e datas do livro sem teste) e as fechou; o rascunho deste README. Ao conferir os exemplos, a IA encontrou e corrigiu dois problemas: assinaturas feitas com o segredo de teste e exemplos que dependiam de códigos cadastrados por fora.
- **O que revisei:** a revisão foi feita ao longo do processo, junto com a ferramenta. Cada decisão foi discutida comigo antes de virar código, e acompanhei os testes, os erros introduzidos de propósito e as validações.

O raciocínio passo a passo, separando o que foi meu e o que foi da IA, está em [`DECISOES.md`](DECISOES.md).

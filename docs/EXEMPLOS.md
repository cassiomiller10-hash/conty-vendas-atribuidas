# Exemplos de request e response

Gerados executando a API (relógio controlado dos testes; o estorno do passo 4 chega em `2026-06-05T13:00Z`). Os ids mudam a cada execução.

**Os comandos funcionam como estão** contra um `npm run dev` com banco vazio, rodados em ordem: as assinaturas usam o segredo de demonstração (`segredo-de-demonstracao`) da loja `loja-verao.myshopify.com`. A assinatura vale só para o corpo exato do comando; qualquer mudança no `-d` exige assinar de novo.

### 1. Cadastrar os códigos dos criadores na marca
```bash
curl -s -X POST localhost:3005/brands/brd_verao/codes -H 'content-type: application/json' -d '{"kind":"utm","code":"ana","creator_id":"crt_ana"}'
curl -s -X POST localhost:3005/brands/brd_verao/codes -H 'content-type: application/json' -d '{"kind":"coupon","code":"ANA10","creator_id":"crt_ana"}'
curl -s -X POST localhost:3005/brands/brd_verao/codes -H 'content-type: application/json' -d '{"kind":"utm","code":"bruno","creator_id":"crt_bruno"}'
curl -s -X POST localhost:3005/brands/brd_verao/codes -H 'content-type: application/json' -d '{"kind":"coupon","code":"BRUNO15","creator_id":"crt_bruno"}'
```
`201` em cada um
```json
[
  {
    "id": "cod_ddd70d3cf1c2",
    "brand_id": "brd_verao",
    "kind": "utm",
    "code": "ana",
    "creator_id": "crt_ana"
  },
  {
    "id": "cod_fcd0321a32d6",
    "brand_id": "brd_verao",
    "kind": "coupon",
    "code": "ANA10",
    "creator_id": "crt_ana"
  },
  {
    "id": "cod_1a87d4a329a2",
    "brand_id": "brd_verao",
    "kind": "utm",
    "code": "bruno",
    "creator_id": "crt_bruno"
  },
  {
    "id": "cod_001b66b44500",
    "brand_id": "brd_verao",
    "kind": "coupon",
    "code": "BRUNO15",
    "creator_id": "crt_bruno"
  }
]
```

### Código já usado por outro criador (maiúsculas e espaços não importam)
```bash
curl -s -X POST localhost:3005/brands/brd_verao/codes \
  -H 'content-type: application/json' \
  -d '{"kind":"coupon","code":" ana10 ","creator_id":"crt_bruno"}'
```
`409`
```json
{
  "error": "codigo_em_uso",
  "message": "Este código já aponta para crt_ana nesta marca."
}
```

### 2. Pedido pago com UTM da Ana e cupom do Bruno
```bash
curl -s -X POST localhost:3005/webhooks/shopify \
  -H 'x-shopify-topic: orders/paid' \
  -H 'x-shopify-shop-domain: loja-verao.myshopify.com' \
  -H 'x-shopify-webhook-id: wh_1001' \
  -H 'x-shopify-hmac-sha256: S0N4TGFoTzi3p4+4pSrhPk4XT+k7MsABqp+D5PoRhhY=' \
  -d '{"id":5001,"total_price":"149.90","currency":"BRL","financial_status":"paid","cancelled_at":null,"discount_codes":[{"code":"BRUNO15"}],"landing_site":"/products/protetor?utm_source=instagram&utm_medium=influenciador&utm_campaign=verao&utm_content=ana","created_at":"2026-06-01T12:00:00-03:00","updated_at":"2026-06-01T12:00:00-03:00"}'
```
`200`
```json
{
  "outcome": "order_created"
}
```

### 3. A mesma entrega de novo
```bash
curl -s -X POST localhost:3005/webhooks/shopify \
  -H 'x-shopify-topic: orders/paid' \
  -H 'x-shopify-shop-domain: loja-verao.myshopify.com' \
  -H 'x-shopify-webhook-id: wh_1001' \
  -H 'x-shopify-hmac-sha256: S0N4TGFoTzi3p4+4pSrhPk4XT+k7MsABqp+D5PoRhhY=' \
  -d '{"id":5001,"total_price":"149.90","currency":"BRL","financial_status":"paid","cancelled_at":null,"discount_codes":[{"code":"BRUNO15"}],"landing_site":"/products/protetor?utm_source=instagram&utm_medium=influenciador&utm_campaign=verao&utm_content=ana","created_at":"2026-06-01T12:00:00-03:00","updated_at":"2026-06-01T12:00:00-03:00"}'
```
`200`
```json
{
  "outcome": "duplicate_delivery"
}
```

### 4. Estorno parcial
```bash
curl -s -X POST localhost:3005/webhooks/shopify \
  -H 'x-shopify-topic: refunds/create' \
  -H 'x-shopify-shop-domain: loja-verao.myshopify.com' \
  -H 'x-shopify-webhook-id: wh_1002' \
  -H 'x-shopify-hmac-sha256: vtmHR9sn2V1+Mn31jndmt8Yx5dd9YmNiQXWCvOqy8Rw=' \
  -d '{"id":901,"order_id":5001,"created_at":"2026-06-05T10:00:00-03:00","transactions":[{"kind":"refund","status":"success","amount":"49.90","currency":"BRL"}]}'
```
`200`
```json
{
  "outcome": "refund_applied"
}
```

### 5. Pedido com venda, estorno e motivo da atribuição
```bash
curl -s localhost:3005/orders/loja-verao.myshopify.com/5001
```
`200`
```json
{
  "order": {
    "shop_domain": "loja-verao.myshopify.com",
    "shopify_order_id": "5001",
    "brand_id": "brd_verao",
    "total_cents": 14990,
    "currency": "BRL",
    "financial_status": "paid",
    "cancelled_at": null,
    "utm_content": "ana",
    "shopify_created_at": "2026-06-01T15:00:00.000Z",
    "shopify_updated_at": "2026-06-01T15:00:00.000Z",
    "first_received_at": "2026-06-01T15:00:00.000Z",
    "last_received_at": "2026-06-01T15:00:00.000Z",
    "creator_id": "crt_ana",
    "attribution_rule": "utm_over_coupon",
    "attribution_reason": "UTM ana apontava para crt_ana, cupom BRUNO15 para crt_bruno; UTM venceu.",
    "counted_at": "2026-06-01T15:00:00.000Z",
    "coupon_codes": [
      "BRUNO15"
    ],
    "utms": {
      "utm_source": "instagram",
      "utm_medium": "influenciador",
      "utm_campaign": "verao",
      "utm_content": "ana"
    }
  },
  "attribution": {
    "creator_id": "crt_ana",
    "rule": "utm_over_coupon",
    "reason": "UTM ana apontava para crt_ana, cupom BRUNO15 para crt_bruno; UTM venceu.",
    "frozen": true,
    "status": "partially_refunded",
    "net_cents": 10000
  },
  "ledger": [
    {
      "kind": "sale",
      "creator_id": "crt_ana",
      "amount_cents": 14990,
      "currency": "BRL",
      "shopify_refund_id": null,
      "shopify_at": "2026-06-01T15:00:00.000Z",
      "received_at": "2026-06-01T15:00:00.000Z"
    },
    {
      "kind": "refund",
      "creator_id": "crt_ana",
      "amount_cents": -4990,
      "currency": "BRL",
      "shopify_refund_id": "901",
      "shopify_at": "2026-06-05T13:00:00.000Z",
      "received_at": "2026-06-05T13:00:00.000Z"
    }
  ],
  "refunds": [
    {
      "shopify_refund_id": "901",
      "amount_cents": 4990,
      "currency": "BRL",
      "status": "applied",
      "applied_cents": 4990,
      "unapplied_cents": 0,
      "shopify_created_at": "2026-06-05T13:00:00.000Z",
      "received_at": "2026-06-05T13:00:00.000Z",
      "applied_at": "2026-06-05T13:00:00.000Z"
    }
  ]
}
```

### 6. Total do criador
```bash
curl -s localhost:3005/creators/crt_ana/sales
```
`200`
```json
{
  "creator_id": "crt_ana",
  "totals": [
    {
      "currency": "BRL",
      "gross_cents": 14990,
      "refunded_cents": 4990,
      "net_cents": 10000,
      "orders": 1
    }
  ]
}
```

### 6b. Venda sem criador (cupom que não é de criador)
```bash
curl -s -X POST localhost:3005/webhooks/shopify \
  -H 'x-shopify-topic: orders/paid' \
  -H 'x-shopify-shop-domain: loja-verao.myshopify.com' \
  -H 'x-shopify-webhook-id: wh_1005' \
  -H 'x-shopify-hmac-sha256: l0XILGAZ4s93UZ4HjDFlNRzKaL86qUiLPo6JHJdcy20=' \
  -d '{"id":5002,"total_price":"50.00","currency":"BRL","financial_status":"paid","cancelled_at":null,"discount_codes":[{"code":"PROMO50"}],"landing_site":"/","created_at":"2026-06-01T12:00:00-03:00","updated_at":"2026-06-01T12:00:00-03:00"}'
```
`200`
```json
{
  "outcome": "order_created"
}
```

### 6c. Total da marca: inclui a venda sem criador, separada da atribuída
```bash
curl -s localhost:3005/brands/brd_verao/sales
```
`200`
```json
{
  "brand_id": "brd_verao",
  "totals": [
    {
      "currency": "BRL",
      "gross_cents": 19990,
      "refunded_cents": 4990,
      "net_cents": 15000,
      "attributed_net_cents": 10000,
      "unattributed_net_cents": 5000,
      "orders": 2
    }
  ]
}
```

### 7. Estorno que chega antes do pedido
```bash
curl -s -X POST localhost:3005/webhooks/shopify \
  -H 'x-shopify-topic: refunds/create' \
  -H 'x-shopify-shop-domain: loja-verao.myshopify.com' \
  -H 'x-shopify-webhook-id: wh_1003' \
  -H 'x-shopify-hmac-sha256: kMHzPiJ+eLV2DowpV7Cfbx9dVfJ0HUIP8nqcGJTlsJQ=' \
  -d '{"id":950,"order_id":6002,"created_at":"2026-06-05T10:00:00-03:00","transactions":[{"kind":"refund","status":"success","amount":"30.00","currency":"BRL"}]}'
```
`200`
```json
{
  "outcome": "refund_pending"
}
```

### 8. Estornos pendentes
```bash
curl -s localhost:3005/refunds/pending
```
`200`
```json
[
  {
    "shop_domain": "loja-verao.myshopify.com",
    "shopify_refund_id": "950",
    "shopify_order_id": "6002",
    "amount_cents": 3000,
    "currency": "BRL",
    "shopify_created_at": "2026-06-05T13:00:00.000Z",
    "received_at": "2026-06-05T13:00:00.000Z",
    "waiting_for": "pedido ainda não chegou"
  }
]
```

### 9. Assinatura inválida
`401`
```json
{
  "error": "assinatura_invalida"
}
```

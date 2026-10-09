import { describe, expect, it } from "vitest";
import { order, setup } from "./helpers.ts";

describe("webhook repetido", () => {
  it("a mesma entrega (mesmo X-Shopify-Webhook-Id) recebida duas vezes não soma de novo", async () => {
    const api = await setup();
    const first = await api.deliver("orders/paid", order(), { webhookId: "wh_fixo" });
    const again = await api.deliver("orders/paid", order(), { webhookId: "wh_fixo" });
    expect([first.status, first.body.outcome]).toEqual([200, "order_created"]);
    expect([again.status, again.body.outcome]).toEqual([200, "duplicate_delivery"]);
    expect((await api.sales("crt_ana")).body.totals).toEqual([
      { currency: "BRL", gross_cents: 14_990, refunded_cents: 0, net_cents: 14_990, orders: 1 },
    ]);
  });

  it("o mesmo pedido em entregas diferentes (create, paid, updated) gera uma venda só", async () => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: "pending" }));
    await api.deliver("orders/paid", order({ updated_at: "2026-06-01T12:05:00-03:00" }));
    await api.deliver("orders/updated", order({ updated_at: "2026-06-01T12:06:00-03:00", note: "presente" }));
    await api.deliver("orders/paid", order({ updated_at: "2026-06-01T12:05:00-03:00" }));
    const { body } = await api.order("5001");
    expect(body.ledger).toHaveLength(1);
    expect((await api.sales("crt_ana")).body.totals[0].net_cents).toBe(14_990);
  });

  it("o banco recusa uma segunda linha de venda para o mesmo pedido", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    const orderRowId = (api.db.prepare("SELECT id FROM orders").get() as { id: string }).id;
    const insert = () =>
      api.db
        .prepare("INSERT INTO ledger (id, order_id, kind, amount_cents, currency, shopify_at, received_at) VALUES ('x', ?, 'sale', 1, 'BRL', 'a', 'b')")
        .run(orderRowId);
    expect(insert).toThrow(/UNIQUE/);
  });

  it("uma versão antiga do pedido não desfaz uma mais nova", async () => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: "pending", updated_at: "2026-06-01T12:00:00-03:00" }));
    await api.deliver("orders/updated", order({ financial_status: "pending", discount_codes: [{ code: "BRUNO15" }], landing_site: "/", updated_at: "2026-06-01T12:10:00-03:00" }));
    const stale = await api.deliver("orders/updated", order({ financial_status: "pending", updated_at: "2026-06-01T12:05:00-03:00" }));
    expect(stale.body.outcome).toBe("order_stale_version");
    const { body } = await api.order("5001");
    expect(body.attribution.creator_id).toBe("crt_bruno");
    expect(body.order.shopify_updated_at).toBe("2026-06-01T15:10:00.000Z");
  });
});

describe("quando a venda conta", () => {
  it("pedido pendente não conta e passa a contar quando é pago", async () => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: "pending" }));
    let view = (await api.order("5001")).body;
    expect(view.attribution).toMatchObject({ creator_id: "crt_ana", status: "not_counted", frozen: false });
    expect((await api.sales("crt_ana")).body.totals).toEqual([]);

    api.setNow("2026-06-01T15:30:00.000Z");
    await api.deliver("orders/paid", order({ updated_at: "2026-06-01T12:30:00-03:00" }));
    view = (await api.order("5001")).body;
    expect(view.attribution).toMatchObject({ status: "active", net_cents: 14_990, frozen: true });
    expect(view.order.counted_at).toBe("2026-06-01T15:30:00.000Z");
  });

  it.each(["pending", "authorized", "partially_paid", "voided"])("status %s não conta", async (status) => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: status }));
    expect((await api.order("5001")).body.ledger).toEqual([]);
  });

  it("pedido cancelado antes do pagamento nunca conta", async () => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: "pending" }));
    await api.deliver("orders/cancelled", order({ financial_status: "voided", cancelled_at: "2026-06-01T12:20:00-03:00", updated_at: "2026-06-01T12:20:00-03:00" }));
    const { body } = await api.order("5001");
    expect(body.ledger).toEqual([]);
    expect(body.order.cancelled_at).toBe("2026-06-01T15:20:00.000Z");
  });

  it("cancelar um pedido pago só marca o cancelamento: o dinheiro sai pelo estorno", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("orders/cancelled", order({ cancelled_at: "2026-06-02T09:00:00-03:00", updated_at: "2026-06-02T09:00:00-03:00" }));
    const { body } = await api.order("5001");
    expect(body.order.cancelled_at).toBe("2026-06-02T12:00:00.000Z");
    expect(body.attribution).toMatchObject({ status: "active", net_cents: 14_990 });
  });
});

describe("atribuição congelada depois que a venda conta", () => {
  it("enquanto pendente, recalcula; depois de pago, não troca e registra a divergência", async () => {
    const api = await setup();
    await api.deliver("orders/create", order({ financial_status: "pending", landing_site: "/", discount_codes: [{ code: "ANA10" }] }));
    await api.deliver("orders/updated", order({ financial_status: "pending", landing_site: "/?utm_content=bruno", updated_at: "2026-06-01T12:01:00-03:00" }));
    expect((await api.order("5001")).body.attribution.creator_id).toBe("crt_bruno");

    await api.deliver("orders/paid", order({ landing_site: "/?utm_content=bruno", updated_at: "2026-06-01T12:02:00-03:00" }));
    await api.deliver("orders/updated", order({ landing_site: "/?utm_content=ana", total_price: "99.00", updated_at: "2026-06-01T12:03:00-03:00" }));

    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ creator_id: "crt_bruno", rule: "utm_only", frozen: true });
    expect(body.ledger).toEqual([expect.objectContaining({ kind: "sale", creator_id: "crt_bruno", amount_cents: 14_990 })]);
    const review = (await api.get("/review")).body;
    expect(review.map((item: { kind: string }) => item.kind)).toEqual(["attribution_divergence", "total_divergence"]);
    expect(review[0].details).toMatchObject({ kept_creator_id: "crt_bruno", would_be_creator_id: "crt_ana" });
  });

  it("registra códigos não reconhecidos e vende sem criador quando nenhum sinal é de criador", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order({ landing_site: "/?utm_content=carla", discount_codes: [{ code: "PROMO50" }] }));
    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ creator_id: null, rule: "no_creator", status: "active" });
    expect(body.ledger[0]).toMatchObject({ creator_id: null, amount_cents: 14_990 });
    const review = (await api.get("/review")).body;
    expect(review.map((item: { kind: string; details: { code: string } }) => [item.kind, item.details.code])).toEqual([
      ["unrecognized_code", "carla"],
      ["unrecognized_code", "PROMO50"],
    ]);
  });
});

describe("autenticidade e formato", () => {
  it("recusa assinatura inválida e não grava nada", async () => {
    const api = await setup();
    const res = await api.deliver("orders/paid", order(), { secret: "segredo-errado" });
    expect([res.status, res.body.error]).toEqual([401, "assinatura_invalida"]);
    expect((await api.order("5001")).status).toBe(404);
  });

  it("recusa corpo alterado depois de assinado", async () => {
    const api = await setup();
    const signed = JSON.stringify(order());
    const tampered = signed.replace("149.90", "1490.00");
    const res = await api.deliver("orders/paid", null, { rawBody: tampered, signedBody: signed });
    expect([res.status, res.body.error]).toEqual([401, "assinatura_invalida"]);
    expect((await api.order("5001")).status).toBe(404);
  });

  it("payload inválido com assinatura válida: 400 e a entrega não é marcada como processada", async () => {
    const api = await setup();
    const bad = await api.deliver("orders/paid", order({ total_price: "149.999" }), { webhookId: "wh_x" });
    expect([bad.status, bad.body.error]).toEqual([400, "payload_invalido"]);
    const retry = await api.deliver("orders/paid", order(), { webhookId: "wh_x" });
    expect(retry.body.outcome).toBe("order_created");
  });

  it("tópico que não interessa responde 200 e fica registrado", async () => {
    const api = await setup();
    const res = await api.deliver("products/update", { id: 1 });
    expect([res.status, res.body.outcome]).toEqual([200, "ignored_topic"]);
  });
});

describe("códigos de criador", () => {
  it("um código não aponta para dois criadores na mesma marca (sem diferenciar maiúsculas)", async () => {
    const api = await setup();
    const res = await api.addCode("coupon", " ana10 ", "crt_bruno");
    expect([res.status, res.body.error]).toEqual([409, "codigo_em_uso"]);
    expect((await api.addCode("coupon", "ANA10", "crt_bruno", "brd_outra")).status).toBe(201);
  });
});

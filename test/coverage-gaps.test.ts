import { describe, expect, it } from "vitest";
import { order, refund, setup } from "./helpers.ts";

describe("venda sem criador continua contando para a marca", () => {
  it("o total da marca separa vendas atribuídas e sem criador; o ranking do criador não recebe a venda sem criador", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order({ id: 1 }));
    await api.deliver("orders/paid", order({ id: 2, total_price: "50.00", landing_site: "/", discount_codes: [{ code: "PROMO50" }] }));
    await api.deliver("refunds/create", refund(901, "10.00", { order_id: 2 }));

    expect((await api.get("/brands/brd_verao/sales")).body.totals).toEqual([
      {
        currency: "BRL",
        gross_cents: 19_990,
        refunded_cents: 1_000,
        net_cents: 18_990,
        attributed_net_cents: 14_990,
        unattributed_net_cents: 4_000,
        orders: 2,
      },
    ]);
    expect((await api.sales("crt_ana")).body.totals[0].net_cents).toBe(14_990);
  });
});

describe("entregas simultâneas", () => {
  it("duas entregas diferentes do mesmo pedido ao mesmo tempo geram uma venda só", async () => {
    const api = await setup();
    const results = await Promise.all([
      api.deliver("orders/paid", order({ updated_at: "2026-06-01T12:05:00-03:00" })),
      api.deliver("orders/updated", order({ updated_at: "2026-06-01T12:05:00-03:00" })),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect((await api.order("5001")).body.ledger).toHaveLength(1);
  });

  it("a mesma entrega duas vezes ao mesmo tempo é processada uma vez", async () => {
    const api = await setup();
    const results = await Promise.all([
      api.deliver("orders/paid", order(), { webhookId: "wh_dup" }),
      api.deliver("orders/paid", order(), { webhookId: "wh_dup" }),
    ]);
    expect(results.map((res) => res.body.outcome).sort()).toEqual(["duplicate_delivery", "order_created"]);
    expect((await api.sales("crt_ana")).body.totals[0].net_cents).toBe(14_990);
  });
});

describe("status de estorno no pedido não mexe em dinheiro", () => {
  it("o pedido virar partially_refunded/refunded não desconta nada; só o webhook de estorno desconta", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("orders/updated", order({ financial_status: "refunded", updated_at: "2026-06-05T10:00:00-03:00" }));
    let view = (await api.order("5001")).body;
    expect(view.order.financial_status).toBe("refunded");
    expect(view.attribution).toMatchObject({ status: "active", net_cents: 14_990 });

    await api.deliver("refunds/create", refund(901, "149.90"));
    view = (await api.order("5001")).body;
    expect(view.attribution).toMatchObject({ status: "reversed", net_cents: 0 });
  });

  it("pedido que chega pela primeira vez já refunded conta como venda e recebe os estornos pendentes", async () => {
    const api = await setup();
    await api.deliver("refunds/create", refund(901, "149.90"));
    await api.deliver("orders/updated", order({ financial_status: "refunded" }));
    const { body } = await api.order("5001");
    expect(body.ledger.map((line: { kind: string; amount_cents: number }) => [line.kind, line.amount_cents])).toEqual([
      ["sale", 14_990],
      ["refund", -14_990],
    ]);
    expect(body.attribution.status).toBe("reversed");
  });
});

describe("rastreabilidade das linhas do livro", () => {
  it("cada linha guarda a data informada pela Shopify e a data em que recebemos", async () => {
    const api = await setup();
    api.setNow("2026-06-01T15:00:03.000Z");
    await api.deliver("orders/paid", order());
    api.setNow("2026-06-05T13:00:09.000Z");
    await api.deliver("refunds/create", refund(901, "49.90"));
    const { body } = await api.order("5001");
    expect(body.ledger).toEqual([
      expect.objectContaining({ kind: "sale", shopify_at: "2026-06-01T15:00:00.000Z", received_at: "2026-06-01T15:00:03.000Z" }),
      expect.objectContaining({ kind: "refund", shopify_refund_id: "901", shopify_at: "2026-06-05T13:00:00.000Z", received_at: "2026-06-05T13:00:09.000Z" }),
    ]);
  });
});

describe("cabeçalhos do webhook", () => {
  it("sem X-Shopify-Webhook-Id responde 400 e não grava", async () => {
    const api = await setup();
    const res = await api.deliver("orders/paid", order(), { webhookId: null });
    expect([res.status, res.body.error]).toEqual([400, "sem_webhook_id"]);
    expect((await api.order("5001")).status).toBe(404);
  });
});

describe("UTMs guardadas para investigação", () => {
  it("o pedido guarda todas as UTMs do link de entrada; só utm_content decide o criador", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order({ landing_site: "/p?utm_source=tiktok&utm_medium=influenciador&utm_campaign=verao&utm_content=bruno&utm_term=protetor&ref=x" }));
    const { body } = await api.order("5001");
    expect(body.order.utms).toEqual({
      utm_source: "tiktok",
      utm_medium: "influenciador",
      utm_campaign: "verao",
      utm_content: "bruno",
      utm_term: "protetor",
    });
    expect(body.attribution.creator_id).toBe("crt_bruno");
  });

  it("pedido sem UTM guarda objeto vazio", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order({ landing_site: null, discount_codes: [{ code: "ANA10" }] }));
    expect((await api.order("5001")).body.order.utms).toEqual({});
  });
});

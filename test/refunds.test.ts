import { describe, expect, it } from "vitest";
import { order, refund, setup } from "./helpers.ts";

describe("estorno parcial e total", () => {
  it("estorno parcial reduz o valor e deixa a atribuição parcialmente estornada", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    const res = await api.deliver("refunds/create", refund(901, "49.90"));
    expect(res.body.outcome).toBe("refund_applied");

    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ creator_id: "crt_ana", status: "partially_refunded", net_cents: 10_000 });
    expect(body.ledger.map((line: { kind: string; amount_cents: number }) => [line.kind, line.amount_cents])).toEqual([
      ["sale", 14_990],
      ["refund", -4_990],
    ]);
    expect((await api.sales("crt_ana")).body.totals[0]).toMatchObject({ gross_cents: 14_990, refunded_cents: 4_990, net_cents: 10_000 });
  });

  it("estornos que somam o total revertem a atribuição, e a venda original continua visível", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "100.00"));
    await api.deliver("refunds/create", refund(902, "49.90", { created_at: "2026-06-06T10:00:00-03:00" }));

    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ creator_id: "crt_ana", status: "reversed", net_cents: 0 });
    expect(body.ledger).toEqual([
      expect.objectContaining({ kind: "sale", amount_cents: 14_990, creator_id: "crt_ana" }),
      expect.objectContaining({ kind: "refund", amount_cents: -10_000, shopify_refund_id: "901" }),
      expect.objectContaining({ kind: "refund", amount_cents: -4_990, shopify_refund_id: "902" }),
    ]);
  });
});

describe("estorno repetido", () => {
  it("o mesmo estorno em duas entregas diferentes não desconta duas vezes", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "49.90"));
    const again = await api.deliver("refunds/create", refund(901, "49.90"));
    expect(again.body.outcome).toBe("refund_duplicate");
    expect((await api.order("5001")).body.attribution.net_cents).toBe(10_000);
  });

  it("mesmo id com outro valor: fica o primeiro e o conflito é registrado", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "49.90"));
    const conflict = await api.deliver("refunds/create", refund(901, "99.90"));
    expect(conflict.body.outcome).toBe("refund_conflict");
    expect((await api.order("5001")).body.attribution.net_cents).toBe(10_000);
    expect((await api.get("/review")).body).toEqual([
      expect.objectContaining({ kind: "refund_conflict", shopify_refund_id: "901", details: { kept: "4990 BRL", received: "9990 BRL" } }),
    ]);
  });
});

describe("a soma dos estornos nunca passa do valor da venda", () => {
  it("estorno acima do restante é aplicado até o limite, e o excesso fica registrado", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "100.00"));
    await api.deliver("refunds/create", refund(902, "80.00", { created_at: "2026-06-06T10:00:00-03:00" }));

    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ status: "reversed", net_cents: 0 });
    expect(body.refunds.find((item: { shopify_refund_id: string }) => item.shopify_refund_id === "902")).toMatchObject({
      amount_cents: 8_000,
      status: "partially_applied",
      applied_cents: 4_990,
      unapplied_cents: 3_010,
    });
    expect((await api.get("/review")).body).toEqual([
      expect.objectContaining({ kind: "refund_excess", details: { refund_cents: 8_000, applied_cents: 4_990, unapplied_cents: 3_010 } }),
    ]);
  });

  it("estorno numa venda já zerada não gera linha e fica como não aplicado", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "149.90"));
    await api.deliver("refunds/create", refund(902, "10.00"));
    const { body } = await api.order("5001");
    expect(body.ledger).toHaveLength(2);
    expect(body.refunds[1]).toMatchObject({ status: "not_applied", applied_cents: 0, unapplied_cents: 1_000 });
  });

  it("estorno em moeda diferente da venda não é aplicado e é sinalizado", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver("refunds/create", refund(901, "10.00", { transactions: [{ kind: "refund", status: "success", amount: "10.00", currency: "USD" }] }));
    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ status: "active", net_cents: 14_990 });
    expect(body.refunds[0]).toMatchObject({ status: "not_applied", currency: "USD" });
    expect((await api.get("/review")).body[0].kind).toBe("refund_currency_mismatch");
  });

  it("só conta transação de estorno bem-sucedida", async () => {
    const api = await setup();
    await api.deliver("orders/paid", order());
    await api.deliver(
      "refunds/create",
      refund(901, "0", {
        transactions: [
          { kind: "refund", status: "failure", amount: "100.00", currency: "BRL" },
          { kind: "refund", status: "success", amount: "20.00", currency: "BRL" },
        ],
      }),
    );
    expect((await api.order("5001")).body.attribution.net_cents).toBe(12_990);
  });
});

describe("estorno que chega antes do pedido", () => {
  it("fica pendente, visível na lista, e é aplicado quando o pedido chega pago", async () => {
    const api = await setup();
    const early = await api.deliver("refunds/create", refund(901, "49.90"));
    expect(early.body.outcome).toBe("refund_pending");
    expect((await api.get("/refunds/pending")).body).toEqual([
      expect.objectContaining({ shopify_refund_id: "901", amount_cents: 4_990, waiting_for: "pedido ainda não chegou" }),
    ]);

    await api.deliver("orders/create", order({ financial_status: "pending" }));
    expect((await api.get("/refunds/pending")).body[0].waiting_for).toBe("pedido ainda não conta como venda");

    await api.deliver("orders/paid", order({ updated_at: "2026-06-01T12:10:00-03:00" }));
    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ status: "partially_refunded", net_cents: 10_000 });
    expect(body.refunds[0]).toMatchObject({ status: "applied", applied_cents: 4_990 });
    expect((await api.get("/refunds/pending")).body).toEqual([]);
  });

  it("pendentes que somam mais que o total são aplicados na ordem da Shopify até o limite", async () => {
    const api = await setup();
    // Chegam fora de ordem: o 902 foi criado depois, mas chega primeiro.
    await api.deliver("refunds/create", refund(902, "100.00", { created_at: "2026-06-06T10:00:00-03:00" }));
    await api.deliver("refunds/create", refund(901, "100.00", { created_at: "2026-06-05T10:00:00-03:00" }));
    await api.deliver("orders/paid", order());

    const { body } = await api.order("5001");
    expect(body.attribution).toMatchObject({ status: "reversed", net_cents: 0 });
    expect(body.refunds.map((item: { shopify_refund_id: string; applied_cents: number; unapplied_cents: number }) => [item.shopify_refund_id, item.applied_cents, item.unapplied_cents])).toEqual([
      ["901", 10_000, 0],
      ["902", 4_990, 5_010],
    ]);
  });

  it("estorno de pedido que nunca chega continua pendente, sem se perder", async () => {
    const api = await setup();
    await api.deliver("refunds/create", refund(901, "10.00", { order_id: 7_777 }));
    await api.deliver("orders/paid", order());
    expect((await api.get("/refunds/pending")).body).toEqual([expect.objectContaining({ shopify_order_id: "7777" })]);
    expect((await api.get(`/orders/loja-verao.myshopify.com/7777`)).body).toMatchObject({ order: null, refunds: [expect.objectContaining({ status: "pending" })] });
  });
});

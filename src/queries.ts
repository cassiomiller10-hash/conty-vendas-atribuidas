import type { DatabaseSync } from "node:sqlite";

// Leituras. A situação da atribuição não é gravada: sai da soma das linhas do livro.

export type AttributionStatus = "not_counted" | "active" | "partially_refunded" | "reversed";

function attributionStatus(lines: Array<{ kind: string; amount_cents: number }>): { status: AttributionStatus; net_cents: number } {
  const sale = lines.find((line) => line.kind === "sale");
  if (!sale) return { status: "not_counted", net_cents: 0 };
  const net = lines.reduce((total, line) => total + line.amount_cents, 0);
  const refunded = lines.some((line) => line.kind === "refund");
  return { status: !refunded ? "active" : net === 0 ? "reversed" : "partially_refunded", net_cents: net };
}

export function getOrder(db: DatabaseSync, shopDomain: string, shopifyOrderId: string) {
  const order = db
    .prepare("SELECT * FROM orders WHERE shop_domain = ? AND shopify_order_id = ?")
    .get(shopDomain, shopifyOrderId) as
    | (Record<string, unknown> & { id: string; coupon_codes_json: string; utms_json: string })
    | undefined;
  const refunds = db
    .prepare(
      `SELECT shopify_refund_id, amount_cents, currency, status, applied_cents, unapplied_cents, shopify_created_at, received_at, applied_at
       FROM refunds WHERE shop_domain = ? AND shopify_order_id = ? ORDER BY shopify_created_at, rowid`,
    )
    .all(shopDomain, shopifyOrderId);
  if (!order) return refunds.length ? { order: null, refunds } : null;
  const ledger = db
    .prepare(
      `SELECT l.kind, l.creator_id, l.amount_cents, l.currency, r.shopify_refund_id, l.shopify_at, l.received_at
       FROM ledger l LEFT JOIN refunds r ON r.id = l.refund_id WHERE l.order_id = ? ORDER BY l.rowid`,
    )
    .all(order.id) as Array<{ kind: string; amount_cents: number }>;
  const { id: _id, coupon_codes_json, utms_json, ...rest } = order;
  return {
    order: { ...rest, coupon_codes: JSON.parse(coupon_codes_json) as string[], utms: JSON.parse(utms_json) as Record<string, string> },
    attribution: {
      creator_id: order.creator_id,
      rule: order.attribution_rule,
      reason: order.attribution_reason,
      frozen: order.counted_at !== null,
      ...attributionStatus(ledger),
    },
    ledger,
    refunds,
  };
}

/** Valor líquido atribuído ao criador = soma das linhas do livro dele, por moeda. */
export function creatorSales(db: DatabaseSync, creatorId: string) {
  const totals = db
    .prepare(
      `SELECT currency, SUM(CASE WHEN kind = 'sale' THEN amount_cents ELSE 0 END) AS gross_cents,
              -SUM(CASE WHEN kind = 'refund' THEN amount_cents ELSE 0 END) AS refunded_cents,
              SUM(amount_cents) AS net_cents, SUM(kind = 'sale') AS orders
       FROM ledger WHERE creator_id = ? GROUP BY currency ORDER BY currency`,
    )
    .all(creatorId);
  return { creator_id: creatorId, totals };
}

/** Total da marca, por moeda: inclui as vendas sem criador, que contam para a marca mas não para ranking. */
export function brandSales(db: DatabaseSync, brandId: string) {
  const totals = db
    .prepare(
      `SELECT l.currency,
              SUM(CASE WHEN l.kind = 'sale' THEN l.amount_cents ELSE 0 END) AS gross_cents,
              -SUM(CASE WHEN l.kind = 'refund' THEN l.amount_cents ELSE 0 END) AS refunded_cents,
              SUM(l.amount_cents) AS net_cents,
              SUM(CASE WHEN l.creator_id IS NOT NULL THEN l.amount_cents ELSE 0 END) AS attributed_net_cents,
              SUM(CASE WHEN l.creator_id IS NULL THEN l.amount_cents ELSE 0 END) AS unattributed_net_cents,
              SUM(l.kind = 'sale') AS orders
       FROM ledger l JOIN orders o ON o.id = l.order_id
       WHERE o.brand_id = ? GROUP BY l.currency ORDER BY l.currency`,
    )
    .all(brandId);
  return { brand_id: brandId, totals };
}

export function pendingRefunds(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT r.shop_domain, r.shopify_refund_id, r.shopify_order_id, r.amount_cents, r.currency, r.shopify_created_at, r.received_at,
              CASE WHEN o.id IS NULL THEN 'pedido ainda não chegou' ELSE 'pedido ainda não conta como venda' END AS waiting_for
       FROM refunds r LEFT JOIN orders o ON o.shop_domain = r.shop_domain AND o.shopify_order_id = r.shopify_order_id
       WHERE r.status = 'pending' ORDER BY r.received_at`,
    )
    .all();
}

export function reviewItems(db: DatabaseSync) {
  return db
    .prepare("SELECT kind, shop_domain, shopify_order_id, shopify_refund_id, details_json, created_at FROM review_items ORDER BY id")
    .all()
    .map(({ details_json, ...item }) => ({ ...item, details: JSON.parse(String(details_json)) as unknown }));
}

import type { DatabaseSync } from "node:sqlite";
import { type Attribution, attributeSale, type CreatorCode } from "./attribution.ts";
import { type OrderPayload, PAID_STATUSES, type RefundPayload } from "./shopify/payloads.ts";

// Regra de negócio das vendas. Estas funções rodam dentro da transação do webhook
// (ver app.ts): ou a entrega inteira grava, ou nada grava.

export type Shop = { domain: string; brandId: string };

type OrderRow = {
  id: string;
  shop_domain: string;
  shopify_order_id: string;
  brand_id: string;
  total_cents: number;
  currency: string;
  shopify_updated_at: string;
  creator_id: string | null;
  counted_at: string | null;
};

type RefundRow = {
  id: string;
  shopify_refund_id: string;
  amount_cents: number;
  currency: string;
  shopify_created_at: string;
};

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function flag(
  db: DatabaseSync,
  item: { kind: string; shop: string; orderId?: string; refundId?: string; dedupe: string; details: Record<string, unknown>; at: string },
): void {
  db.prepare(
    "INSERT OR IGNORE INTO review_items (kind, shop_domain, shopify_order_id, shopify_refund_id, dedupe_key, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(item.kind, item.shop, item.orderId ?? null, item.refundId ?? null, `${item.kind}:${item.shop}:${item.dedupe}`, JSON.stringify(item.details), item.at);
}

function brandCodes(db: DatabaseSync, brandId: string): CreatorCode[] {
  return (db.prepare("SELECT kind, code, creator_id FROM creator_codes WHERE brand_id = ?").all(brandId) as Array<{
    kind: "coupon" | "utm";
    code: string;
    creator_id: string;
  }>).map((row) => ({ kind: row.kind, code: row.code, creatorId: row.creator_id }));
}

export type OrderOutcome = "created" | "updated" | "stale_version" | "same_version";

export function ingestOrder(db: DatabaseSync, shop: Shop, order: OrderPayload, receivedAt: string): OrderOutcome {
  const existing = db
    .prepare("SELECT * FROM orders WHERE shop_domain = ? AND shopify_order_id = ?")
    .get(shop.domain, order.orderId) as OrderRow | undefined;

  // Entrega atrasada não desfaz versão mais nova. Mesma updated_at = mesma versão.
  if (existing && order.updatedAt < existing.shopify_updated_at) return "stale_version";
  if (existing && order.updatedAt === existing.shopify_updated_at) return "same_version";

  const attribution = attributeSale({ couponCodes: order.couponCodes, utmContent: order.utmContent }, brandCodes(db, shop.brandId));
  for (const code of attribution.unrecognized) {
    flag(db, {
      kind: "unrecognized_code",
      shop: shop.domain,
      orderId: order.orderId,
      dedupe: `${order.orderId}:${code.kind}:${code.code.toLowerCase()}`,
      details: code,
      at: receivedAt,
    });
  }

  const frozen = existing?.counted_at != null;
  const orderRowId = existing?.id ?? newId("ord");
  const common = [
    order.totalCents,
    order.currency,
    order.financialStatus,
    order.cancelledAt,
    JSON.stringify(order.couponCodes),
    order.utmContent,
    JSON.stringify(order.utms),
    order.updatedAt,
    receivedAt,
  ] as const;

  if (!existing) {
    db.prepare(
      `INSERT INTO orders (id, shop_domain, shopify_order_id, brand_id, total_cents, currency, financial_status, cancelled_at,
         coupon_codes_json, utm_content, utms_json, shopify_updated_at, last_received_at, shopify_created_at, first_received_at,
         creator_id, attribution_rule, attribution_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(orderRowId, shop.domain, order.orderId, shop.brandId, ...common, order.createdAt, receivedAt, attribution.creatorId, attribution.rule, attribution.reason);
  } else if (!frozen) {
    // Ainda não conta como venda: dados e atribuição acompanham a versão mais nova.
    db.prepare(
      `UPDATE orders SET total_cents = ?, currency = ?, financial_status = ?, cancelled_at = ?, coupon_codes_json = ?,
         utm_content = ?, utms_json = ?, shopify_updated_at = ?, last_received_at = ?, creator_id = ?, attribution_rule = ?,
         attribution_reason = ?
       WHERE id = ?`,
    ).run(...common, attribution.creatorId, attribution.rule, attribution.reason, orderRowId);
  } else {
    // Já conta como venda: valor e atribuição congelados. O resto (status, cancelamento) acompanha.
    db.prepare(
      `UPDATE orders SET financial_status = ?, cancelled_at = ?, coupon_codes_json = ?, utm_content = ?, utms_json = ?,
         shopify_updated_at = ?, last_received_at = ? WHERE id = ?`,
    ).run(
      order.financialStatus,
      order.cancelledAt,
      JSON.stringify(order.couponCodes),
      order.utmContent,
      JSON.stringify(order.utms),
      order.updatedAt,
      receivedAt,
      orderRowId,
    );
    flagDivergences(db, shop, existing, order, attribution, receivedAt);
  }

  if (!frozen && PAID_STATUSES.has(order.financialStatus)) {
    countSale(db, shop, orderRowId, order, attribution.creatorId, receivedAt);
  }
  return existing ? "updated" : "created";
}

function flagDivergences(
  db: DatabaseSync,
  shop: Shop,
  existing: OrderRow,
  order: OrderPayload,
  attribution: Attribution,
  at: string,
): void {
  if (attribution.creatorId !== existing.creator_id) {
    flag(db, {
      kind: "attribution_divergence",
      shop: shop.domain,
      orderId: order.orderId,
      dedupe: `${order.orderId}:${order.updatedAt}`,
      details: { kept_creator_id: existing.creator_id, would_be_creator_id: attribution.creatorId, would_be_reason: attribution.reason },
      at,
    });
  }
  if (order.totalCents !== existing.total_cents || order.currency !== existing.currency) {
    flag(db, {
      kind: "total_divergence",
      shop: shop.domain,
      orderId: order.orderId,
      dedupe: `${order.orderId}:${order.updatedAt}`,
      details: { kept: `${existing.total_cents} ${existing.currency}`, received: `${order.totalCents} ${order.currency}` },
      at,
    });
  }
}

/** O pedido passa a contar: linha de venda no livro e estornos pendentes aplicados em ordem. */
function countSale(db: DatabaseSync, shop: Shop, orderRowId: string, order: OrderPayload, creatorId: string | null, at: string): void {
  db.prepare(
    "INSERT INTO ledger (id, order_id, kind, creator_id, amount_cents, currency, shopify_at, received_at) VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)",
  ).run(newId("led"), orderRowId, creatorId, order.totalCents, order.currency, order.updatedAt, at);
  db.prepare("UPDATE orders SET counted_at = ? WHERE id = ?").run(at, orderRowId);

  const pending = db
    .prepare(
      "SELECT * FROM refunds WHERE shop_domain = ? AND shopify_order_id = ? AND status = 'pending' ORDER BY shopify_created_at, rowid",
    )
    .all(shop.domain, order.orderId) as RefundRow[];
  for (const refund of pending) applyRefund(db, shop, orderRowId, order.orderId, refund, at);
}

/** Aplica no máximo o que resta da venda; o excesso fica registrado como não aplicado. */
function applyRefund(db: DatabaseSync, shop: Shop, orderRowId: string, shopifyOrderId: string, refund: RefundRow, at: string): void {
  const sale = db.prepare("SELECT creator_id, currency FROM ledger WHERE order_id = ? AND kind = 'sale'").get(orderRowId) as {
    creator_id: string | null;
    currency: string;
  };
  if (refund.currency !== sale.currency) {
    db.prepare("UPDATE refunds SET status = 'not_applied', unapplied_cents = ?, applied_at = ? WHERE id = ?").run(refund.amount_cents, at, refund.id);
    flag(db, {
      kind: "refund_currency_mismatch",
      shop: shop.domain,
      orderId: shopifyOrderId,
      refundId: refund.shopify_refund_id,
      dedupe: refund.shopify_refund_id,
      details: { refund: `${refund.amount_cents} ${refund.currency}`, sale_currency: sale.currency },
      at,
    });
    return;
  }
  const { remaining } = db.prepare("SELECT SUM(amount_cents) AS remaining FROM ledger WHERE order_id = ?").get(orderRowId) as {
    remaining: number;
  };
  const applied = Math.min(refund.amount_cents, remaining);
  const unapplied = refund.amount_cents - applied;
  if (applied > 0) {
    db.prepare(
      "INSERT INTO ledger (id, order_id, kind, creator_id, amount_cents, currency, refund_id, shopify_at, received_at) VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)",
    ).run(newId("led"), orderRowId, sale.creator_id, -applied, refund.currency, refund.id, refund.shopify_created_at, at);
  }
  const status = unapplied === 0 ? "applied" : applied > 0 ? "partially_applied" : "not_applied";
  db.prepare("UPDATE refunds SET status = ?, applied_cents = ?, unapplied_cents = ?, applied_at = ? WHERE id = ?").run(
    status,
    applied,
    unapplied,
    at,
    refund.id,
  );
  if (unapplied > 0) {
    flag(db, {
      kind: "refund_excess",
      shop: shop.domain,
      orderId: shopifyOrderId,
      refundId: refund.shopify_refund_id,
      dedupe: refund.shopify_refund_id,
      details: { refund_cents: refund.amount_cents, applied_cents: applied, unapplied_cents: unapplied },
      at,
    });
  }
}

export type RefundOutcome = "applied" | "pending" | "duplicate" | "conflict";

export function ingestRefund(db: DatabaseSync, shop: Shop, refund: RefundPayload, receivedAt: string): RefundOutcome {
  const existing = db
    .prepare("SELECT * FROM refunds WHERE shop_domain = ? AND shopify_refund_id = ?")
    .get(shop.domain, refund.refundId) as RefundRow | undefined;
  if (existing) {
    if (existing.amount_cents === refund.amountCents && existing.currency === refund.currency) return "duplicate";
    flag(db, {
      kind: "refund_conflict",
      shop: shop.domain,
      orderId: refund.orderId,
      refundId: refund.refundId,
      dedupe: `${refund.refundId}:${refund.amountCents}:${refund.currency}`,
      details: { kept: `${existing.amount_cents} ${existing.currency}`, received: `${refund.amountCents} ${refund.currency}` },
      at: receivedAt,
    });
    return "conflict";
  }

  const row: RefundRow = {
    id: newId("ref"),
    shopify_refund_id: refund.refundId,
    amount_cents: refund.amountCents,
    currency: refund.currency,
    shopify_created_at: refund.createdAt,
  };
  db.prepare(
    "INSERT INTO refunds (id, shop_domain, shopify_refund_id, shopify_order_id, amount_cents, currency, shopify_created_at, received_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(row.id, shop.domain, refund.refundId, refund.orderId, refund.amountCents, refund.currency, refund.createdAt, receivedAt);

  const order = db
    .prepare("SELECT id, counted_at FROM orders WHERE shop_domain = ? AND shopify_order_id = ?")
    .get(shop.domain, refund.orderId) as { id: string; counted_at: string | null } | undefined;
  // Pedido ainda não chegou ou ainda não conta: o estorno espera.
  if (!order?.counted_at) return "pending";
  applyRefund(db, shop, order.id, refund.orderId, row, receivedAt);
  return "applied";
}

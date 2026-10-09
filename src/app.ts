import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { normalizeCode } from "./attribution.ts";
import { transaction } from "./db.ts";
import { brandSales, creatorSales, getOrder, pendingRefunds, reviewItems } from "./queries.ts";
import { ingestOrder, ingestRefund, type Shop } from "./sales.ts";
import { InvalidPayload, parseOrder, parseRefund } from "./shopify/payloads.ts";
import { isValidShopifySignature } from "./shopify/signature.ts";

export type ShopConfig = Shop & { webhookSecret: string };

type Options = { now?: () => Date };

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled"]);

export function createApp(db: DatabaseSync, shops: ShopConfig[], options: Options = {}) {
  const now = options.now ?? (() => new Date());
  const shopsByDomain = new Map(shops.map((shop) => [shop.domain, shop]));
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/webhooks/shopify", async (c) => {
    // A assinatura é sobre o corpo exatamente como chegou: lê como texto antes de interpretar.
    const rawBody = await c.req.text();
    const shop = shopsByDomain.get(c.req.header("x-shopify-shop-domain") ?? "");
    if (!shop || !isValidShopifySignature(rawBody, c.req.header("x-shopify-hmac-sha256"), shop.webhookSecret)) {
      return c.json({ error: "assinatura_invalida" }, 401);
    }
    const webhookId = c.req.header("x-shopify-webhook-id");
    const topic = c.req.header("x-shopify-topic") ?? "";
    if (!webhookId) return c.json({ error: "sem_webhook_id" }, 400);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "json_invalido" }, 400);
    }
    const receivedAt = now().toISOString();

    try {
      const outcome = transaction(db, () => {
        const seen = db.prepare("SELECT outcome FROM webhook_deliveries WHERE webhook_id = ?").get(webhookId);
        if (seen) return "duplicate_delivery";
        let result: string;
        if (ORDER_TOPICS.has(topic)) result = `order_${ingestOrder(db, shop, parseOrder(payload), receivedAt)}`;
        else if (topic === "refunds/create") result = `refund_${ingestRefund(db, shop, parseRefund(payload), receivedAt)}`;
        else result = "ignored_topic";
        // Gravado na mesma transação: se o processamento falhar, a reentrega é processada.
        db.prepare("INSERT INTO webhook_deliveries (webhook_id, shop_domain, topic, received_at, outcome) VALUES (?, ?, ?, ?, ?)").run(
          webhookId,
          shop.domain,
          topic,
          receivedAt,
          result,
        );
        return result;
      });
      // Sempre 200 para entrega válida, inclusive repetida: erro faria a Shopify reenviar.
      return c.json({ outcome });
    } catch (error) {
      if (error instanceof InvalidPayload) return c.json({ error: "payload_invalido", message: error.message }, 400);
      throw error;
    }
  });

  app.post("/brands/:brandId/codes", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const kind = body?.kind;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const creatorId = typeof body?.creator_id === "string" ? body.creator_id.trim() : "";
    if ((kind !== "coupon" && kind !== "utm") || !code || !creatorId) {
      return c.json({ error: "dados_invalidos", message: "Informe kind (coupon ou utm), code e creator_id." }, 400);
    }
    const brandId = c.req.param("brandId");
    const existing = db
      .prepare("SELECT creator_id FROM creator_codes WHERE brand_id = ? AND kind = ? AND code_normalized = ?")
      .get(brandId, kind, normalizeCode(code)) as { creator_id: string } | undefined;
    if (existing) {
      return c.json({ error: "codigo_em_uso", message: `Este código já aponta para ${existing.creator_id} nesta marca.` }, 409);
    }
    const id = `cod_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    db.prepare(
      "INSERT INTO creator_codes (id, brand_id, kind, code, code_normalized, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, brandId, kind, code, normalizeCode(code), creatorId, now().toISOString());
    return c.json({ id, brand_id: brandId, kind, code, creator_id: creatorId }, 201);
  });

  app.get("/orders/:shop/:orderId", (c) => {
    const result = getOrder(db, c.req.param("shop"), c.req.param("orderId"));
    return result ? c.json(result) : c.json({ error: "pedido_nao_encontrado" }, 404);
  });

  app.get("/creators/:id/sales", (c) => c.json(creatorSales(db, c.req.param("id"))));
  app.get("/brands/:brandId/sales", (c) => c.json(brandSales(db, c.req.param("brandId"))));
  app.get("/refunds/pending", (c) => c.json(pendingRefunds(db)));
  app.get("/review", (c) => c.json(reviewItems(db)));

  return app;
}

import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { signShopifyBody } from "../src/shopify/signature.ts";

export const SHOP = "loja-verao.myshopify.com";
export const SECRET = "segredo-de-teste";

/** App com banco em memória e relógio controlado. Os códigos da Marca Verão já cadastrados. */
export async function setup(options: { withCodes?: boolean } = {}) {
  let now = new Date("2026-06-01T15:00:00.000Z");
  const db = openDatabase(":memory:");
  const app = createApp(db, [{ domain: SHOP, brandId: "brd_verao", webhookSecret: SECRET }], { now: () => now });
  let deliveries = 0;

  async function request(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
    const res = await app.request(path, { method, headers: init.headers, body: init.body });
    // biome-ignore lint: corpo genérico nos testes
    return { status: res.status, body: (await res.json()) as any };
  }

  const api = {
    db,
    setNow(iso: string) {
      now = new Date(iso);
    },
    get: (path: string) => request("GET", path),
    addCode: (kind: "coupon" | "utm", code: string, creatorId: string, brandId = "brd_verao") =>
      request("POST", `/brands/${brandId}/codes`, {
        body: JSON.stringify({ kind, code, creator_id: creatorId }),
        headers: { "content-type": "application/json" },
      }),
    /** Entrega assinada como a Shopify faria. Cada chamada é uma entrega nova, salvo `webhookId`. */
    deliver(
      topic: string,
      payload: unknown,
      options: { webhookId?: string | null; secret?: string; rawBody?: string; signedBody?: string } = {},
    ) {
      deliveries += 1;
      const body = options.rawBody ?? JSON.stringify(payload);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": SHOP,
        "x-shopify-hmac-sha256": signShopifyBody(options.signedBody ?? body, options.secret ?? SECRET),
      };
      // null = entrega sem X-Shopify-Webhook-Id
      if (options.webhookId !== null) headers["x-shopify-webhook-id"] = options.webhookId ?? `wh_${deliveries}`;
      return request("POST", "/webhooks/shopify", { body, headers });
    },
    order: (id: string) => request("GET", `/orders/${SHOP}/${id}`),
    sales: (creatorId: string) => request("GET", `/creators/${creatorId}/sales`),
  };
  if (options.withCodes ?? true) {
    await api.addCode("coupon", "ANA10", "crt_ana");
    await api.addCode("utm", "ana", "crt_ana");
    await api.addCode("coupon", "BRUNO15", "crt_bruno");
    await api.addCode("utm", "bruno", "crt_bruno");
  }
  return api;
}

/** Pedido no formato essencial do webhook orders/* da Shopify. */
export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 5_001,
    total_price: "149.90",
    currency: "BRL",
    financial_status: "paid",
    cancelled_at: null,
    discount_codes: [] as Array<{ code: string }>,
    landing_site: "/products/protetor?utm_source=instagram&utm_medium=influenciador&utm_campaign=verao&utm_content=ana",
    created_at: "2026-06-01T12:00:00-03:00",
    updated_at: "2026-06-01T12:00:00-03:00",
    ...overrides,
  };
}

/** Estorno no formato essencial do webhook refunds/create da Shopify. */
export function refund(id: number, amount: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_id: 5_001,
    created_at: "2026-06-05T10:00:00-03:00",
    transactions: [{ kind: "refund", status: "success", amount, currency: "BRL" }],
    ...overrides,
  };
}

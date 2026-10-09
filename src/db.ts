import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creator_codes (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('coupon', 'utm')),
  code TEXT NOT NULL,
  code_normalized TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- um código não aponta para dois criadores na mesma marca
  UNIQUE (brand_id, kind, code_normalized)
);

-- Entregas já processadas (X-Shopify-Webhook-Id). Gravada na mesma transação do processamento.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  webhook_id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  topic TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);

-- Última versão conhecida de cada pedido (loja + id). A atribuição fica congelada quando a venda conta.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  financial_status TEXT NOT NULL,
  cancelled_at TEXT,
  coupon_codes_json TEXT NOT NULL,
  utm_content TEXT,
  utms_json TEXT NOT NULL DEFAULT '{}',
  shopify_created_at TEXT NOT NULL,
  shopify_updated_at TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  creator_id TEXT,
  attribution_rule TEXT NOT NULL,
  attribution_reason TEXT NOT NULL,
  counted_at TEXT,
  UNIQUE (shop_domain, shopify_order_id)
);

-- Livro de registros: só inserção. Venda positiva, estorno negativo.
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'refund')),
  creator_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  refund_id TEXT UNIQUE,
  shopify_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((kind = 'sale' AND amount_cents >= 0 AND refund_id IS NULL) OR (kind = 'refund' AND amount_cents < 0 AND refund_id IS NOT NULL))
);

-- Trava do banco: uma linha de venda por pedido, mesmo com duas entregas simultâneas.
CREATE UNIQUE INDEX IF NOT EXISTS one_sale_per_order ON ledger (order_id) WHERE kind = 'sale';

-- Todo estorno recebido, aplicado ou não. Pendente enquanto o pedido não chega ou não conta.
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  shopify_refund_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  shopify_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'partially_applied', 'not_applied')),
  applied_cents INTEGER NOT NULL DEFAULT 0,
  unapplied_cents INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT,
  UNIQUE (shop_domain, shopify_refund_id)
);

-- O que precisa de olho humano: código não reconhecido, conflito, excesso, divergência.
CREATE TABLE IF NOT EXISTS review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  shopify_order_id TEXT,
  shopify_refund_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

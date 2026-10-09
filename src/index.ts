import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

// Demonstração: uma loja configurada. Em produção, domínio, marca e segredo viriam do cadastro da
// loja e de variável de ambiente, nunca do código.
const shops = [
  {
    domain: process.env.SHOP_DOMAIN ?? "loja-verao.myshopify.com",
    brandId: process.env.SHOP_BRAND_ID ?? "brd_verao",
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET ?? "segredo-de-demonstracao",
  },
];

const db = openDatabase(process.env.DB_PATH ?? "data/vendas.sqlite");
const port = Number(process.env.PORT ?? 3005);

serve({ fetch: createApp(db, shops).fetch, port }, (info) => {
  console.log(`vendas em http://127.0.0.1:${info.port} (loja ${shops[0]?.domain})`);
});

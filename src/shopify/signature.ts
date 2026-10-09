import { createHmac, timingSafeEqual } from "node:crypto";

/** Assinatura que a Shopify manda em `X-Shopify-Hmac-Sha256`: HMAC-SHA256 do corpo cru, em base64. */
export function signShopifyBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

/**
 * Compara com o corpo exatamente como chegou (antes de interpretar o JSON) e em tempo
 * constante, para não vazar por quanto tempo a comparação demorou.
 */
export function isValidShopifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signShopifyBody(rawBody, secret), "base64");
  const received = Buffer.from(header, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

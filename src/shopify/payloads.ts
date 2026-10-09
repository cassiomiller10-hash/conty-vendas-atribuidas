import { centsFromText } from "../money.ts";

// Fronteira com a Shopify: o essencial de um pedido e de um estorno, convertido para tipos
// do domínio. Campos seguem os nomes da API de webhooks (orders/*, refunds/create).

export class InvalidPayload extends Error {}

export type OrderPayload = {
  orderId: string;
  totalCents: number;
  currency: string;
  financialStatus: string;
  cancelledAt: string | null;
  couponCodes: string[];
  /** Todas as UTMs do link de entrada, guardadas para investigação. */
  utms: Record<string, string>;
  /** `utm_content` identifica o criador. */
  utmContent: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RefundPayload = {
  refundId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  createdAt: string;
};

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidPayload(`${where}: objeto esperado`);
  return value as Json;
}

function id(value: unknown, where: string): string {
  if ((typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.trim())) return String(value);
  throw new InvalidPayload(`${where}: id esperado`);
}

function instant(value: unknown, where: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new InvalidPayload(`${where}: data esperada`);
  return new Date(value).toISOString();
}

function currency(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) throw new InvalidPayload(`${where}: moeda esperada`);
  return value.toUpperCase();
}

function cents(value: unknown, where: string): number {
  const parsed = centsFromText(value);
  if (parsed === null) throw new InvalidPayload(`${where}: valor em texto com até 2 casas esperado`);
  return parsed;
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/** UTMs do link de entrada (`landing_site` pode ser caminho ou URL completa). */
export function utmsFrom(landingSite: unknown): Record<string, string> {
  if (typeof landingSite !== "string" || !landingSite) return {};
  let params: URLSearchParams;
  try {
    params = new URL(landingSite, "https://loja.invalid").searchParams;
  } catch {
    return {};
  }
  const utms: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value !== null) utms[key] = value;
  }
  return utms;
}

export function parseOrder(body: unknown): OrderPayload {
  const order = object(body, "pedido");
  const utms = utmsFrom(order.landing_site);
  const discountCodes = Array.isArray(order.discount_codes) ? order.discount_codes : [];
  return {
    orderId: id(order.id, "id"),
    totalCents: cents(order.total_price, "total_price"),
    currency: currency(order.currency, "currency"),
    financialStatus: typeof order.financial_status === "string" ? order.financial_status : "pending",
    cancelledAt: order.cancelled_at ? instant(order.cancelled_at, "cancelled_at") : null,
    couponCodes: discountCodes.flatMap((entry) => {
      const code = object(entry, "discount_codes[]").code;
      return typeof code === "string" ? [code] : [];
    }),
    utms,
    utmContent: utms.utm_content ?? null,
    createdAt: instant(order.created_at, "created_at"),
    updatedAt: instant(order.updated_at, "updated_at"),
  };
}

/** Valor do estorno = soma das transações de estorno bem-sucedidas, todas na mesma moeda. */
export function parseRefund(body: unknown): RefundPayload {
  const refund = object(body, "estorno");
  const transactions = (Array.isArray(refund.transactions) ? refund.transactions : [])
    .map((raw) => object(raw, "transactions[]"))
    .filter((transaction) => transaction.kind === "refund" && transaction.status === "success");
  if (transactions.length === 0) throw new InvalidPayload("estorno sem transação de estorno bem-sucedida");
  const currencies = new Set(transactions.map((transaction) => currency(transaction.currency, "transactions[].currency")));
  if (currencies.size > 1) throw new InvalidPayload("transações do estorno em moedas diferentes");
  return {
    refundId: id(refund.id, "id"),
    orderId: id(refund.order_id, "order_id"),
    amountCents: transactions.reduce((total, transaction) => total + cents(transaction.amount, "transactions[].amount"), 0),
    currency: [...currencies][0] as string,
    createdAt: instant(refund.created_at, "created_at"),
  };
}

/** Status que significam que o pedido foi pago. `refunded` também: o dinheiro só sai pelo webhook de estorno. */
export const PAID_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

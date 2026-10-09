// A regra de atribuição inteira mora aqui. Função pura: recebe os sinais do pedido e os
// códigos da marca, devolve o criador (ou nenhum) e o motivo. Não grava nada.

export type CodeKind = "coupon" | "utm";

export type CreatorCode = { kind: CodeKind; code: string; creatorId: string };

export type AttributionSignals = {
  /** Cupons na ordem em que aparecem no pedido. */
  couponCodes: string[];
  /** Valor de `utm_content` do link de entrada na loja. */
  utmContent: string | null;
};

export type AttributionRule =
  | "utm_and_coupon_agree"
  | "utm_over_coupon"
  | "utm_only"
  | "coupon_only"
  | "no_creator";

export type Attribution = {
  creatorId: string | null;
  rule: AttributionRule;
  reason: string;
  /** Códigos que vieram no pedido mas não pertencem a nenhum criador da marca. */
  unrecognized: Array<{ kind: CodeKind; code: string }>;
};

/** "ANA10" e " ana10 " são o mesmo código para o comprador. */
export function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function attributeSale(signals: AttributionSignals, codes: CreatorCode[]): Attribution {
  const lookup = (kind: CodeKind, code: string) =>
    codes.find((entry) => entry.kind === kind && normalizeCode(entry.code) === normalizeCode(code))?.creatorId ?? null;

  const unrecognized: Attribution["unrecognized"] = [];
  const utm = signals.utmContent?.trim() ? signals.utmContent.trim() : null;
  const utmCreator = utm === null ? null : lookup("utm", utm);
  if (utm !== null && utmCreator === null) unrecognized.push({ kind: "utm", code: utm });

  const coupons: Array<{ code: string; creatorId: string }> = [];
  for (const raw of signals.couponCodes) {
    const code = raw.trim();
    if (!code) continue;
    const creatorId = lookup("coupon", code);
    if (creatorId === null) unrecognized.push({ kind: "coupon", code });
    else coupons.push({ code, creatorId });
  }
  const coupon = coupons[0] ?? null;
  const couponsDisagree = new Set(coupons.map((item) => item.creatorId)).size > 1;
  const ignoredNote = unrecognized.length
    ? ` Ignorado(s) por não pertencer a nenhum criador: ${unrecognized.map((item) => `${item.kind === "utm" ? "UTM" : "cupom"} ${item.code}`).join(", ")}.`
    : "";

  if (utmCreator !== null && coupon !== null) {
    const agree = coupons.every((item) => item.creatorId === utmCreator);
    if (agree) {
      return {
        creatorId: utmCreator,
        rule: "utm_and_coupon_agree",
        reason: `UTM ${utm} e cupom ${coupon.code} apontavam para ${utmCreator}.${ignoredNote}`,
        unrecognized,
      };
    }
    const others = coupons.filter((item) => item.creatorId !== utmCreator);
    return {
      creatorId: utmCreator,
      rule: "utm_over_coupon",
      reason: `UTM ${utm} apontava para ${utmCreator}, cupom ${others.map((item) => `${item.code} para ${item.creatorId}`).join(", ")}; UTM venceu.${ignoredNote}`,
      unrecognized,
    };
  }
  if (utmCreator !== null) {
    return { creatorId: utmCreator, rule: "utm_only", reason: `UTM ${utm} apontava para ${utmCreator}.${ignoredNote}`, unrecognized };
  }
  if (coupon !== null) {
    const ambiguity = couponsDisagree
      ? ` Cupons apontavam para criadores diferentes (${coupons.map((item) => `${item.code} para ${item.creatorId}`).join(", ")}); sem UTM, vale o primeiro do pedido.`
      : "";
    return {
      creatorId: coupon.creatorId,
      rule: "coupon_only",
      reason: `Cupom ${coupon.code} apontava para ${coupon.creatorId}.${ambiguity}${ignoredNote}`,
      unrecognized,
    };
  }
  return { creatorId: null, rule: "no_creator", reason: `Nenhum cupom ou UTM de criador.${ignoredNote}`, unrecognized };
}

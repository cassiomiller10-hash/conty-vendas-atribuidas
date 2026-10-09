import { describe, expect, it } from "vitest";
import { attributeSale, type CreatorCode } from "../src/attribution.ts";
import { centsFromText } from "../src/money.ts";

const CODES: CreatorCode[] = [
  { kind: "coupon", code: "ANA10", creatorId: "crt_ana" },
  { kind: "utm", code: "ana", creatorId: "crt_ana" },
  { kind: "coupon", code: "BRUNO15", creatorId: "crt_bruno" },
  { kind: "utm", code: "bruno", creatorId: "crt_bruno" },
];

describe("regra de atribuição (tabela de casos)", () => {
  it.each([
    // [caso, cupons, utm_content, criador esperado, regra esperada]
    ["só cupom", ["ANA10"], null, "crt_ana", "coupon_only"],
    ["só UTM", [], "bruno", "crt_bruno", "utm_only"],
    ["os dois concordam", ["ANA10"], "ana", "crt_ana", "utm_and_coupon_agree"],
    ["os dois discordam: UTM vence", ["BRUNO15"], "ana", "crt_ana", "utm_over_coupon"],
    ["discordam ao contrário: UTM vence", ["ANA10"], "bruno", "crt_bruno", "utm_over_coupon"],
    ["nenhum sinal", [], null, null, "no_creator"],
    ["cupom desconhecido é ignorado", ["PROMO50"], null, null, "no_creator"],
    ["UTM desconhecida não vence cupom conhecido", ["BRUNO15"], "carla", "crt_bruno", "coupon_only"],
    ["cupom desconhecido não atrapalha UTM", ["PROMO50"], "ana", "crt_ana", "utm_only"],
    ["maiúsculas e espaços não importam", [" ana10 "], " ANA ", "crt_ana", "utm_and_coupon_agree"],
    ["vários cupons sem UTM: vale o primeiro", ["BRUNO15", "ANA10"], null, "crt_bruno", "coupon_only"],
  ] as const)("%s", (_, coupons, utm, creatorId, rule) => {
    const result = attributeSale({ couponCodes: [...coupons], utmContent: utm }, CODES);
    expect([result.creatorId, result.rule]).toEqual([creatorId, rule]);
  });

  it("guarda o motivo e os códigos não reconhecidos", () => {
    const result = attributeSale({ couponCodes: ["BRUNO15", "PROMO50"], utmContent: "ana" }, CODES);
    expect(result.reason).toBe(
      "UTM ana apontava para crt_ana, cupom BRUNO15 para crt_bruno; UTM venceu. Ignorado(s) por não pertencer a nenhum criador: cupom PROMO50.",
    );
    expect(result.unrecognized).toEqual([{ kind: "coupon", code: "PROMO50" }]);
  });

  it("registra a ambiguidade de cupons de criadores diferentes no motivo", () => {
    const result = attributeSale({ couponCodes: ["BRUNO15", "ANA10"], utmContent: null }, CODES);
    expect(result.reason).toContain("Cupons apontavam para criadores diferentes");
  });
});

describe("dinheiro em centavos a partir do texto", () => {
  it.each([
    ["149.90", 14_990],
    ["149.9", 14_990],
    ["149", 14_900],
    ["0.01", 1],
    ["0.29", 29],
    ["1234567.89", 123_456_789],
  ])("%s → %i", (text, cents) => expect(centsFromText(text)).toBe(cents));

  it.each(["149.999", "-10.00", "1,50", "abc", "", "1e3"])("recusa %j", (text) => expect(centsFromText(text)).toBeNull());
});

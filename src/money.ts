/**
 * "149.90" → 14990, direto do texto, sem passar por número de ponto flutuante
 * (149.9 * 100 = 14990.000000000002). Aceita até 2 casas decimais.
 */
export function centsFromText(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const [, units = "0", fraction = ""] = match;
  const cents = Number(units) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

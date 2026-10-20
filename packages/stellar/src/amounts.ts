/** Converts between decimal strings and integer base units (stroops for XLM). */

export function toBaseUnits(amount: string, decimals = 7): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error(`invalid amount: ${amount}`);
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return (
    BigInt(whole as string) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")
  );
}

export function fromBaseUnits(units: bigint, decimals = 7): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * What's typed in a money box on Books → Snap a bill, in whole cents: "$1,284.33", "1284.3", ".50". A credit is
 * "-12.50" or "(12.50)", as bills print them. Null when it's empty or isn't an amount, which the page's checks say
 * as "Fill in each line's amount" rather than guessing. Pure.
 */
export function parseDollars(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  const negative = /^\(.*\)$/.test(t) || t.startsWith('-');
  const digits = t.replace(/^\((.*)\)$/, '$1').replace(/^-/, '');
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(digits)) return null;
  const cents = Math.round(Number(digits) * 100);
  return negative ? -cents : cents;
}

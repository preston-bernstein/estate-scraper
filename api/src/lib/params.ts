// A malformed id param (`Number("abc")` → NaN) previously degraded to a harmless
// 404 in some routes (a NaN-valued query just matches no row) but was inconsistent
// with routes that explicitly validated it — this makes every numeric route param
// fail the same documented way.
export function parsePositiveIntParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

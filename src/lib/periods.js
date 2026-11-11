// The window a limit is measured over, in UTC.

const DAY = 864e5;

function utcDate(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

/** Days in a month (m is 0-based), so a billing day of 31 works in February. */
function daysIn(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Start of the billing month containing `now`, for a billing day 1-31. */
function monthStart(now, billingDay) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = utcDate(y, m, Math.min(billingDay, daysIn(y, m)));
  if (now >= thisMonth) return thisMonth;
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 11 : m - 1;
  return utcDate(py, pm, Math.min(billingDay, daysIn(py, pm)));
}

function nextMonthStart(start, billingDay) {
  const y = start.getUTCMonth() === 11 ? start.getUTCFullYear() + 1 : start.getUTCFullYear();
  const m = (start.getUTCMonth() + 1) % 12;
  return utcDate(y, m, Math.min(billingDay, daysIn(y, m)));
}

/**
 * @param {"day"|"month"|"cap"} period
 * @returns {{ start: Date, end: Date | null, key: string }}
 *   key identifies the period (alerts are once per key); for caps it's "cap".
 */
export function periodFor(period, now, billingDay = 1) {
  if (period === "cap") return { start: now, end: null, key: "cap" };
  if (period === "day") {
    const start = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { start, end: new Date(start.getTime() + DAY), key: start.toISOString().slice(0, 10) };
  }
  const start = monthStart(now, billingDay);
  return { start, end: nextMonthStart(start, billingDay), key: start.toISOString().slice(0, 10) };
}

/** "YYYY-MM-DD" */
export const isoDate = (d) => d.toISOString().slice(0, 10);

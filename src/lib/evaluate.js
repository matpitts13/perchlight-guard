// Turns readings into alert candidates: thresholds crossed, and limits the
// current rate will pass before they reset. Sending (once per period) is
// alerts.js's job.

import { formatValue } from "./limits.js";
import { periodFor } from "./periods.js";

const HOUR = 36e5;

/** What going over means, per product and plan, for the alert text. */
export function overNote(product, plan) {
  if (product === "github") return "Over it, GitHub bills the extra, or blocks Actions if you've set a $0 budget.";
  if (plan === "paid") return "Over the included amount, Cloudflare bills the extra.";
  if (product === "workers") return "Over it, your Workers return error 1027 until 00:00 UTC.";
  if (product === "r2") return "Over it, Cloudflare bills the extra (R2 has no hard stop).";
  return "Over it, these operations fail with an error until the limit resets.";
}

function whenText(period) {
  if (period === "day") return "today";
  if (period === "month") return "this month";
  return "now";
}

/**
 * @param {Array} limits config.limits
 * @param {{ values: Record<string, number>, unreadable: Record<string, string> }} read
 */
export function buildReadings(config, limits, read, now) {
  return limits.map((l) => {
    const p = periodFor(l.period, now, l.product === "github" ? config.githubBillingDay : config.billingDay);
    const base = {
      id: l.id,
      product: l.product,
      label: l.label,
      unit: l.unit,
      limit: l.limit,
      period: l.period,
      periodKey: p.key,
      periodStart: p.start.toISOString(),
      resetsAt: p.end ? p.end.toISOString() : null,
      thresholds: l.thresholds,
    };
    if (read.unreadable[l.id] === undefined && read.values[l.id] === null && l.period === "cap") {
      return { ...base, status: "nodata", used: null, pct: null, error: "No data reported (nothing stored yet, or not reported yet)." };
    }
    if (read.unreadable[l.id] !== undefined || typeof read.values[l.id] !== "number" || !Number.isFinite(read.values[l.id])) {
      return { ...base, status: "unreadable", used: null, pct: null, error: read.unreadable[l.id] ?? "No value was returned." };
    }
    const used = read.values[l.id];
    return { ...base, status: "ok", used, pct: (used / l.limit) * 100, error: null };
  });
}

/** Has enough of the period passed to project from? */
function canProject(r, now) {
  const start = new Date(r.periodStart).getTime();
  const end = new Date(r.resetsAt).getTime();
  const elapsed = now.getTime() - start;
  const minElapsed = r.period === "day" ? 3 * HOUR : 48 * HOUR;
  return elapsed > 0 && end > now.getTime() && (elapsed >= minElapsed || r.pct >= 20);
}

/**
 * @returns {Array<{ limitId: string, periodKey: string, kind: string, line: string, severity: number }>}
 *   severity: 1 projected, 2 threshold below 100, 3 at or over 100
 */
export function candidates(config, readings, now) {
  const out = [];
  for (const r of readings) {
    if (r.status !== "ok") continue;
    const shown = `${formatValue(r.used, r.unit)} of ${formatValue(r.limit, r.unit)} (${Math.floor(r.pct)}%)`;
    const crossed = r.thresholds.filter((t) => r.pct >= t);
    for (const t of crossed) {
      out.push({
        limitId: r.id,
        periodKey: r.periodKey,
        kind: `threshold:${t}`,
        severity: t >= 100 ? 3 : 2,
        line: `${r.label}: ${shown} ${whenText(r.period)}.${r.resetsAt ? ` Resets ${new Date(r.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : ""} ${overNote(r.product, config.plan)}`,
        threshold: t,
      });
    }
    if (r.period !== "cap" && r.pct < 100 && canProject(r, now)) {
      const start = new Date(r.periodStart).getTime();
      const end = new Date(r.resetsAt).getTime();
      const rate = r.used / (now.getTime() - start);
      const projected = rate * (end - start);
      if (projected >= r.limit && rate > 0) {
        const hitAt = new Date(start + r.limit / rate);
        out.push({
          limitId: r.id,
          periodKey: r.periodKey,
          kind: "projected",
          severity: 1,
          line: `${r.label}: ${shown} so far ${whenText(r.period)}. At this rate it reaches the limit at about ${hitAt.toISOString().slice(0, 16).replace("T", " ")} UTC (on course for ${Math.round((projected / r.limit) * 100)}%). ${overNote(r.product, config.plan)}`,
        });
      }
    }
  }
  return out;
}

/** Storage caps re-arm once usage falls well below the lowest threshold (10
 *  points under it), so usage hovering around 80% doesn't re-alert. */
export const REARM_MARGIN = 10;
export function capsToRearm(readings) {
  return readings
    .filter((r) => r.status === "ok" && r.period === "cap" && r.pct < Math.min(...r.thresholds) - REARM_MARGIN)
    .map((r) => r.id);
}

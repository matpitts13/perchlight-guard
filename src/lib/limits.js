// Every limit the guard watches, with Cloudflare's and GitHub's documented
// values (read 2026-11-10). Each one can be changed or turned off with the
// LIMITS setting.
//
// period, per plan:
//   day   resets 00:00 UTC
//   month calendar month UTC, or from BILLING_DAY
//   cap   a ceiling on something stored: compared as it is now

const GB = 1024 ** 3;

/** @typedef {{ id: string, product: string, label: string, unit: string,
 *   free: { limit: number, period: "day"|"month"|"cap" },
 *   paid: { limit: number, period: "day"|"month"|"cap" } }} LimitDef */

/** @type {LimitDef[]} */
export const LIMITS = [
  { id: "workers.requests", product: "workers", label: "Workers requests", unit: "count", free: { limit: 100_000, period: "day" }, paid: { limit: 10_000_000, period: "month" } },

  { id: "kv.reads", product: "kv", label: "KV reads", unit: "count", free: { limit: 100_000, period: "day" }, paid: { limit: 10_000_000, period: "month" } },
  { id: "kv.writes", product: "kv", label: "KV writes", unit: "count", free: { limit: 1_000, period: "day" }, paid: { limit: 1_000_000, period: "month" } },
  { id: "kv.deletes", product: "kv", label: "KV deletes", unit: "count", free: { limit: 1_000, period: "day" }, paid: { limit: 1_000_000, period: "month" } },
  { id: "kv.lists", product: "kv", label: "KV lists", unit: "count", free: { limit: 1_000, period: "day" }, paid: { limit: 1_000_000, period: "month" } },
  { id: "kv.storage", product: "kv", label: "KV storage", unit: "bytes", free: { limit: 1 * GB, period: "cap" }, paid: { limit: 1 * GB, period: "cap" } },

  { id: "d1.rowsRead", product: "d1", label: "D1 rows read", unit: "count", free: { limit: 5_000_000, period: "day" }, paid: { limit: 25_000_000_000, period: "month" } },
  { id: "d1.rowsWritten", product: "d1", label: "D1 rows written", unit: "count", free: { limit: 100_000, period: "day" }, paid: { limit: 50_000_000, period: "month" } },
  { id: "d1.storage", product: "d1", label: "D1 storage", unit: "bytes", free: { limit: 5 * GB, period: "cap" }, paid: { limit: 5 * GB, period: "cap" } },

  { id: "do.requests", product: "do", label: "Durable Objects requests", unit: "count", free: { limit: 100_000, period: "day" }, paid: { limit: 1_000_000, period: "month" } },
  { id: "do.duration", product: "do", label: "Durable Objects duration", unit: "gbs", free: { limit: 13_000, period: "day" }, paid: { limit: 400_000, period: "month" } },
  { id: "do.storage", product: "do", label: "Durable Objects storage", unit: "bytes", free: { limit: 5 * GB, period: "cap" }, paid: { limit: 5 * GB, period: "cap" } },

  { id: "r2.storage", product: "r2", label: "R2 storage", unit: "bytes", free: { limit: 10 * GB, period: "cap" }, paid: { limit: 10 * GB, period: "cap" } },
  { id: "r2.classA", product: "r2", label: "R2 Class A operations", unit: "count", free: { limit: 1_000_000, period: "month" }, paid: { limit: 1_000_000, period: "month" } },
  { id: "r2.classB", product: "r2", label: "R2 Class B operations", unit: "count", free: { limit: 10_000_000, period: "month" }, paid: { limit: 10_000_000, period: "month" } },

  { id: "ai.neurons", product: "ai", label: "Workers AI neurons", unit: "count", free: { limit: 10_000, period: "day" }, paid: { limit: 10_000, period: "day" } },

  { id: "github.compute", product: "github", label: "GitHub Actions compute", unit: "usd", free: { limit: 12, period: "month" }, paid: { limit: 12, period: "month" } },
  { id: "github.storage", product: "github", label: "GitHub Actions storage", unit: "gbmonth", free: { limit: 0.5, period: "month" }, paid: { limit: 0.5, period: "month" } },
];

/** Shows a value in the limit's unit. */
export function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return "?";
  switch (unit) {
    case "bytes":
      return value >= GB ? `${(value / GB).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
    case "usd":
      return `$${value.toFixed(2)}`;
    case "gbs":
      return `${Math.round(value).toLocaleString("en-US")} GB-s`;
    case "gbmonth":
      return `${value.toFixed(3)} GB-month`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

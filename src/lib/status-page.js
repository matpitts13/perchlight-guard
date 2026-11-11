import { formatValue } from "./limits.js";

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function bar(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
  return `<div class="bar"><div class="${cls}" style="width:${p.toFixed(1)}%"></div></div>`;
}

/** The status page: every limit, its use, when it resets, and what couldn't be read. */
export function statusPage(check, recentAlerts) {
  const rows = check
    ? check.readings
        .map((r) => {
          const resets = r.resetsAt ? new Date(r.resetsAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "storage cap";
          if (r.status === "nodata") {
            return `<tr><td>${escapeHtml(r.label)}</td><td colspan="2">No data reported (nothing stored yet?)</td><td>${escapeHtml(resets)}</td></tr>`;
          }
          if (r.status !== "ok") {
            return `<tr class="bad"><td>${escapeHtml(r.label)}</td><td colspan="2">Can't read: ${escapeHtml(r.error ?? "")}</td><td>${escapeHtml(resets)}</td></tr>`;
          }
          return `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(formatValue(r.used, r.unit))} of ${escapeHtml(formatValue(r.limit, r.unit))}</td><td>${bar(r.pct)} ${Math.floor(r.pct)}%</td><td>${escapeHtml(resets)}</td></tr>`;
        })
        .join("")
    : "";
  const problems = check?.problems?.length || check?.fatal
    ? `<div class="note"><b>Needs attention</b><ul>${[check.fatal, ...check.problems].filter(Boolean).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`
    : "";
  const alerts = recentAlerts.length
    ? `<h2>Recent alerts</h2><ul>${recentAlerts.map((a) => `<li>${escapeHtml(a.sent_at)} UTC: ${escapeHtml(a.limit_id)} (${escapeHtml(a.kind)})${a.error ? `, not all channels worked: ${escapeHtml(a.error)}` : ""}</li>`).join("")}</ul>`
    : "";
  const body = check
    ? `<p>Plan: ${escapeHtml(check.plan)}. Last check: ${escapeHtml(check.checkedAt.slice(0, 16).replace("T", " "))} UTC.</p>${problems}
<table><thead><tr><th>Limit</th><th>Used</th><th></th><th>Resets</th></tr></thead><tbody>${rows}</tbody></table>${alerts}`
    : "<p>No check has run yet. It runs every hour, or POST /api/check to run one now.</p>";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage guard</title>
<style>
:root{color-scheme:light dark;--ok:#2f9e44;--warn:#e8a317;--over:#d6336c;--line:#8884}
body{font-family:system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:middle}
.bar{display:inline-block;width:8rem;height:.55rem;border-radius:1rem;background:var(--line);vertical-align:middle;overflow:hidden}
.bar div{height:100%}.ok{background:var(--ok)}.warn{background:var(--warn)}.over{background:var(--over)}
tr.bad td{color:var(--over)}.note{border:1px solid var(--warn);border-radius:.5rem;padding:.5rem 1rem;margin:1rem 0}
</style><h1>Usage guard</h1>${body}</html>`;
}

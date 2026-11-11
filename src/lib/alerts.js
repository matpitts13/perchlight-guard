// Once-per-period alerting. Each alert is first claimed with an INSERT that
// the UNIQUE (limit_id, period_start, kind) key lets only one check win, then
// sent. If every channel fails, the claims are released so the next check
// tries again.

import { deliver } from "./channels.js";

/**
 * @param {Array<{ limitId: string, periodKey: string, kind: string, line: string, severity: number }>} list
 * @returns {Promise<{ sent: Array, results: Array }>}
 */
export async function sendOnce(env, config, list, { subject, intro, fetchImpl = fetch } = {}) {
  const claimed = [];
  const release = async () => {
    for (const c of claimed) {
      await env.DB.prepare("DELETE FROM alerts WHERE limit_id = ?1 AND period_start = ?2 AND kind = ?3")
        .bind(c.limitId, c.periodKey, c.kind)
        .run()
        .catch(() => {}); // the next check's orphan clean-up gets any left over
    }
  };
  try {
    for (const c of list) {
      const res = await env.DB.prepare(
        "INSERT OR IGNORE INTO alerts (limit_id, period_start, kind, message) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(c.limitId, c.periodKey, c.kind, c.line)
        .run();
      if (res.meta.changes) claimed.push(c);
    }
  } catch (err) {
    await release();
    throw err;
  }
  if (!claimed.length) return { sent: [], results: [] };

  // One message, one line per limit: its most serious new alert only.
  const byLimit = new Map();
  for (const c of claimed) {
    const prev = byLimit.get(c.limitId);
    if (!prev || c.severity > prev.severity || (c.severity === prev.severity && (c.threshold ?? 0) > (prev.threshold ?? 0))) byLimit.set(c.limitId, c);
  }
  const lines = [...byLimit.values()].sort((a, b) => b.severity - a.severity);
  const urgent = lines.some((l) => l.severity >= 3);
  const title =
    subject ??
    (lines.length === 1
      ? lines[0].subject ?? `${lines[0].kind === "projected" ? "On course to hit a limit" : urgent ? "Limit reached" : "Usage warning"}: ${lines[0].line.split(":")[0]}`
      : `${lines.length} usage warnings${urgent ? " (a limit is reached)" : ""}`);
  const text = [
    intro ?? "perchlight-guard noticed this in your usage:",
    "",
    ...lines.map((l) => `- ${l.line}`),
    "",
    "Each warning is sent once per period. Open your guard's status page to see every limit.",
  ].join("\n");

  let results;
  try {
    results = await deliver(env, config, { subject: title, text, urgent }, fetchImpl);
  } catch (err) {
    await release();
    throw err;
  }
  const ok = results.some((r) => r.ok);
  const channels = results.filter((r) => r.ok).map((r) => r.channel).join(", ");
  const errors = results.filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error}`).join("; ") || null;
  if (ok) {
    for (const c of claimed) {
      await env.DB.prepare("UPDATE alerts SET channels = ?1, error = ?2 WHERE limit_id = ?3 AND period_start = ?4 AND kind = ?5")
        .bind(channels, errors, c.limitId, c.periodKey, c.kind)
        .run();
    }
  } else {
    await release();
  }
  if (!ok) console.error(`alert not delivered: ${errors ?? "no channel is set up"}`);
  return { sent: ok ? claimed : [], results };
}

export async function rearm(env, limitIds) {
  for (const id of limitIds) {
    await env.DB.prepare("DELETE FROM alerts WHERE limit_id = ?1 AND period_start = 'cap'").bind(id).run();
  }
}

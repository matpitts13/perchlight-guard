// One check: read every source, store the samples, send what's due.

import { readConfig } from "./config.js";
import { readCloudflare } from "./cloudflare.js";
import { readGithub } from "./github.js";
import { buildReadings, candidates, capsToRearm } from "./evaluate.js";
import { sendOnce, rearm } from "./alerts.js";
import { formatValue } from "./limits.js";
import { isoDate, periodFor } from "./periods.js";

const BLIND_AFTER = 3;

async function getState(env, key) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?1").bind(key).first();
  return row?.value ?? null;
}
async function setState(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)").bind(key, String(value)).run();
}

/** A table of every limit, for the daily summary and the status JSON. */
export function summaryLines(readings) {
  return readings.map((r) =>
    r.status === "ok"
      ? `${r.label}: ${formatValue(r.used, r.unit)} of ${formatValue(r.limit, r.unit)} (${Math.floor(r.pct)}%)`
      : r.status === "nodata"
        ? `${r.label}: no data reported`
        : `${r.label}: can't read (${r.error})`,
  );
}

/** Runs a reader; if it throws, every limit it covers is unreadable and the
 *  source counts as failed, so one source's bug can't stop the others. */
async function safely(limits, reader) {
  try {
    return await reader();
  } catch (err) {
    const why = `Reading failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(why);
    return { values: {}, unreadable: Object.fromEntries(limits.map((l) => [l.id, why])), datasets: {}, charged: 0, fatal: why };
  }
}

/**
 * A source failed this check if it couldn't be reached at all, or if it has
 * limits and none of them could be read (an expired token, a wrong account
 * id, every dataset refused): either way the guard is blind to it.
 */
function sourceFailed(src, limits, read) {
  if (src.fatal) return src.fatal;
  if (!limits.length) return null;
  if (limits.every((l) => read.unreadable[l.id] !== undefined)) {
    return `None of its limits could be read: ${read.unreadable[limits[0].id]}`;
  }
  return null;
}

/** Per-source failure streaks. Manual checks don't count as strikes. */
async function updateStreak(env, source, failure, takenAt) {
  const keyN = `failures:${source}`;
  const keyS = `failing_since:${source}`;
  if (!failure) {
    await env.DB.prepare("DELETE FROM state WHERE key IN (?1, ?2)").bind(keyN, keyS).run();
    return { failures: 0, since: null };
  }
  const failures = (Number(await getState(env, keyN)) || 0) + 1;
  const since = (await getState(env, keyS)) ?? takenAt;
  await setState(env, keyN, failures);
  await setState(env, keyS, since);
  return { failures, since };
}

const SOURCE_NAMES = { cloudflare: "Cloudflare", github: "GitHub" };

/**
 * @param {{ now?: Date, fetchImpl?: typeof fetch, send?: boolean, manual?: boolean }} opts
 *   manual: a check asked for through the API; it doesn't count toward the
 *   "can't read" streak, so a few test runs during an outage don't alert.
 */
export async function runCheck(env, { now = new Date(), fetchImpl = fetch, send = true, manual = false } = {}) {
  const config = readConfig(env);
  const cfLimits = config.limits.filter((l) => l.product !== "github");
  const ghLimits = config.limits.filter((l) => l.product === "github");
  const [cf, gh] = await Promise.all([
    safely(cfLimits, () => readCloudflare(config, cfLimits, now, fetchImpl)),
    safely(ghLimits, () => readGithub(env, config, config.limits, now, fetchImpl)),
  ]);
  const read = { values: { ...cf.values, ...gh.values }, unreadable: { ...cf.unreadable, ...gh.unreadable } };
  const readings = buildReadings(config, config.limits, read, now);

  // History.
  const takenAt = now.toISOString().replace("T", " ").slice(0, 19);
  await env.DB.batch([
    ...readings.map((r) =>
      env.DB.prepare(
        "INSERT INTO samples (taken_at, limit_id, period_start, used, limit_value, status, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(takenAt, r.id, r.periodKey, r.used, r.limit, r.status, r.error),
    ),
    ...Object.entries(cf.datasets).map(([name, available]) =>
      env.DB.prepare("INSERT OR REPLACE INTO datasets (name, available, checked_at, last_error) VALUES (?1, ?2, ?3, ?4)").bind(
        name,
        available ? 1 : 0,
        takenAt,
        available ? null : `Not offered by this account's analytics.`,
      ),
    ),
    env.DB.prepare("DELETE FROM samples WHERE taken_at < datetime(?1, '-35 days')").bind(takenAt),
    env.DB.prepare("DELETE FROM alerts WHERE sent_at < datetime(?1, '-400 days')").bind(takenAt),
    // A claim whose check died before sending (isolate killed, D1 hiccup):
    // release it so it's sent if still due.
    env.DB.prepare("DELETE FROM alerts WHERE channels = '' AND error IS NULL AND sent_at < datetime(?1, '-10 minutes')").bind(takenAt),
  ]);

  // A guard that silently can't see is worse than none: a streak per source.
  const failuresNow = {
    cloudflare: sourceFailed(cf, cfLimits, read),
    github: config.github ? sourceFailed(gh, ghLimits, read) : null,
  };
  const due = candidates(config, readings, now);
  const streaks = {};
  for (const [source, failure] of Object.entries(failuresNow)) {
    if (manual) continue;
    const s = await updateStreak(env, source, failure, takenAt);
    streaks[source] = s.failures;
    if (failure && s.failures >= BLIND_AFTER) {
      due.push({
        limitId: `guard.${source}`,
        periodKey: s.since,
        kind: "blind",
        severity: 3,
        subject: `perchlight-guard can't read your ${SOURCE_NAMES[source]} usage`,
        line: `The guard has failed to read your ${SOURCE_NAMES[source]} usage ${s.failures} checks in a row, so it can't warn you about it. ${failure}`,
      });
    }
  }
  const fatal = Object.entries(failuresNow).filter(([, f]) => f).map(([s, f]) => `${SOURCE_NAMES[s]}: ${f}`).join(" ") || null;

  if (gh.charged > 0) {
    due.push({
      limitId: "github.charges",
      periodKey: periodFor("month", now, config.githubBillingDay).key,
      kind: "charging",
      severity: 3,
      subject: "GitHub is charging you for Actions",
      line: `GitHub has started charging for Actions this billing month: $${gh.charged.toFixed(2)} so far. Set a $0 budget at github.com/settings/billing to stop it.`,
    });
  }

  let sent = [];
  let delivery = [];
  if (send) {
    await rearm(env, capsToRearm(readings));
    if (due.length) {
      const r = await sendOnce(env, config, due, { fetchImpl });
      sent = r.sent;
      delivery = r.results;
    }
    if (config.dailySummary && now.getUTCHours() === config.summaryHour) {
      const lines = summaryLines(readings);
      const r = await sendOnce(env, config, [{ limitId: "*", periodKey: isoDate(now), kind: "summary", severity: 0, line: lines.join("\n  ") }], {
        subject: `Daily usage summary, ${isoDate(now)}`,
        intro: "Your usage so far today (daily limits) and this month (monthly ones):",
        fetchImpl,
      });
      delivery = delivery.concat(r.results);
    }
  }

  const result = {
    checkedAt: now.toISOString(),
    plan: config.plan,
    readings,
    problems: config.problems,
    fatal,
    failures: streaks,
    datasets: cf.datasets,
    githubBreakdown: gh.breakdown ?? [],
    alertsSent: sent.map((s) => ({ limitId: s.limitId, kind: s.kind })),
    delivery,
  };
  await setState(env, "last_check", JSON.stringify(result));
  return result;
}

export async function lastCheck(env) {
  const raw = await getState(env, "last_check");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

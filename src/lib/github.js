// Reads GitHub Actions usage for a personal account from GitHub's billing
// usage API (GET /users/{user}/settings/billing/usage). It needs a classic
// personal access token with the "user" scope; GitHub says fine-grained
// tokens aren't supported for this endpoint.
//
// GitHub Free includes $12 of Actions compute a month (tracked in dollars,
// since runner types cost different amounts per minute) and 500 MB of
// artifact storage (accrued in GB-hours). Standard runners in public repos
// are free and don't use the allowance, so public repos' items are left out.
// A repo GitHub's API returns as public is public; anything else counts.

import { periodFor } from "./periods.js";

const API = "https://api.github.com";
const MAX_VISIBILITY_LOOKUPS = 30; // per check; results are kept for a day

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "perchlight-guard",
  };
}

class FatalError extends Error {}

async function getJson(url, token, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: headers(token) });
  } catch (err) {
    throw new FatalError(`Can't reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
  }
  return res;
}

/** The calendar months (year, month 1-12) a period touches. */
function monthsBetween(start, end) {
  const out = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d <= end) {
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

const fullName = (user, repo) => (repo.includes("/") ? repo : `${user}/${repo}`);

/** Public or not, from the cache or GitHub (at most MAX_VISIBILITY_LOOKUPS a check). */
async function visibility(env, user, token, repos, fetchImpl) {
  const result = new Map();
  if (!repos.length) return result;
  const { results } = await env.DB.prepare(
    "SELECT name, public FROM repo_visibility WHERE checked_at > datetime('now', '-1 day')",
  ).all();
  for (const r of results) result.set(r.name, r.public === 1);
  let lookups = 0;
  for (const repo of repos) {
    if (result.has(repo) || lookups >= MAX_VISIBILITY_LOOKUPS) continue;
    lookups++;
    const path = repo.split("/").map(encodeURIComponent).join("/");
    const res = await getJson(`${API}/repos/${path}`, token, fetchImpl);
    let isPublic = false;
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      isPublic = body.private === false;
    }
    result.set(repo, isPublic);
    await env.DB.prepare("INSERT OR REPLACE INTO repo_visibility (name, public, checked_at) VALUES (?1, ?2, datetime('now'))")
      .bind(repo, isPublic ? 1 : 0)
      .run();
  }
  return result;
}

const isActions = (item) => String(item.product ?? "").toLowerCase() === "actions";
const isMinutes = (item) => /minute/i.test(String(item.unitType ?? ""));
const isStorage = (item) => /gigabyte.?hour/i.test(String(item.unitType ?? "")) || /storage/i.test(String(item.sku ?? ""));

/**
 * @returns {Promise<{ values: Record<string, number>, unreadable: Record<string, string>,
 *   charged: number, fatal: string | null }>}
 */
export async function readGithub(env, config, limits, now, fetchImpl = fetch) {
  const out = { values: {}, unreadable: {}, charged: 0, fatal: null };
  const wanted = limits.filter((l) => l.product === "github");
  if (!wanted.length || !config.github) return out;
  const { user, token } = config.github;
  const period = periodFor("month", now, config.githubBillingDay);
  const fail = (why) => {
    for (const l of wanted) out.unreadable[l.id] = why;
  };

  try {
    const items = [];
    for (const { year, month } of monthsBetween(period.start, now)) {
      const res = await getJson(`${API}/users/${encodeURIComponent(user)}/settings/billing/usage?year=${year}&month=${month}`, token, fetchImpl);
      if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        fail(`GitHub's rate limit was reached (HTTP ${res.status}); it'll try again next check.`);
        return out;
      }
      if (res.status === 401 || res.status === 403) {
        fail(`GitHub refused the token (HTTP ${res.status}). Use a classic personal access token with the "user" scope, and check it hasn't expired.`);
        return out;
      }
      if (res.status === 404) {
        fail("GitHub's billing usage report isn't available for this account (HTTP 404). It needs the enhanced billing platform and the \"user\" scope.");
        return out;
      }
      if (!res.ok) {
        fail(`GitHub answered HTTP ${res.status}.`);
        return out;
      }
      const body = await res.json().catch(() => null);
      if (!body || !Array.isArray(body.usageItems)) {
        fail("GitHub's usage report wasn't in the expected format (no usageItems).");
        return out;
      }
      items.push(...body.usageItems);
    }

    const inPeriod = items.filter((i) => {
      if (!isActions(i)) return false;
      const d = new Date(i.date);
      return !Number.isNaN(d.getTime()) && d >= period.start && d <= now;
    });
    const repoOf = (i) => (typeof i.repositoryName === "string" && i.repositoryName ? fullName(user, i.repositoryName) : null);
    const repos = [...new Set(inPeriod.map(repoOf).filter(Boolean))];
    const vis = await visibility(env, user, token, repos, fetchImpl);
    const counts = (i) => !repoOf(i) || vis.get(repoOf(i)) !== true;

    let compute = 0;
    let gbHours = 0;
    // Where the numbers come from, per SKU, counted (private) or not (public):
    // shown in the check result so anyone can see what was included.
    const breakdown = new Map();
    for (const i of inPeriod) {
      out.charged += Number(i.netAmount) || 0;
      const counted = counts(i);
      const key = `${i.sku ?? "?"}|${i.unitType ?? "?"}|${counted ? "counted" : "public, free"}`;
      const b = breakdown.get(key) ?? { sku: i.sku ?? "?", unit: i.unitType ?? "?", repos: counted ? "private" : "public", quantity: 0, grossAmount: 0 };
      b.quantity += Number(i.quantity) || 0;
      b.grossAmount += Number(i.grossAmount) || 0;
      breakdown.set(key, b);
      if (!counted) continue;
      if (isMinutes(i)) compute += Number(i.grossAmount) || 0;
      else if (isStorage(i)) gbHours += Number(i.quantity) || 0;
    }
    out.breakdown = [...breakdown.values()].map((b) => ({ ...b, quantity: Math.round(b.quantity * 1000) / 1000, grossAmount: Math.round(b.grossAmount * 100) / 100 }));
    const hoursInPeriod = (period.end.getTime() - period.start.getTime()) / 36e5;
    out.values["github.compute"] = compute;
    out.values["github.storage"] = gbHours / hoursInPeriod;
    for (const id of Object.keys(out.values)) if (!wanted.some((l) => l.id === id)) delete out.values[id];
    return out;
  } catch (err) {
    if (err instanceof FatalError) {
      out.fatal = err.message;
      fail(err.message);
      return out;
    }
    throw err;
  }
}

// Reads the settings from the environment, once per check. A bad setting is
// reported (on the status page and in the check result), never fatal: the
// guard falls back to the default for that one setting.

import { LIMITS } from "./limits.js";

const truthy = (v) => String(v ?? "").toLowerCase() === "true";

function parseThresholds(raw, problems) {
  if (raw === undefined || raw === "") return [80, 100];
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!list.length || list.some((n) => !Number.isFinite(n) || n <= 0 || n > 1000)) {
    problems.push(`THRESHOLDS "${raw}" isn't a list of percentages like "80,100"; using 80,100.`);
    return [80, 100];
  }
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * @returns {{
 *   plan: "free"|"paid", billingDay: number, githubBillingDay: number,
 *   thresholds: number[], limits: Array<import("./limits.js").LimitDef & { limit: number, period: string, thresholds: number[] }>,
 *   email: { to: string, from: string } | null, webhook: { url: string, format: string } | null,
 *   dailySummary: boolean, summaryHour: number, github: { user: string, token: string } | null,
 *   accountId: string, apiToken: string, problems: string[] }}
 */
export function readConfig(env) {
  const problems = [];
  let plan = String(env.PLAN ?? "free").toLowerCase();
  if (plan !== "free" && plan !== "paid") {
    problems.push(`PLAN "${env.PLAN}" should be "free" or "paid"; using free.`);
    plan = "free";
  }
  const day = (raw, name) => {
    if (raw === undefined || raw === "") return 1;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
    problems.push(`${name} "${raw}" should be a day of the month, 1-31; using 1.`);
    return 1;
  };
  const thresholds = parseThresholds(env.THRESHOLDS, problems);

  let overrides = {};
  if (env.LIMITS) {
    try {
      const parsed = typeof env.LIMITS === "string" ? JSON.parse(env.LIMITS) : env.LIMITS;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed;
      else problems.push("LIMITS should be a JSON object; ignoring it.");
    } catch {
      problems.push("LIMITS isn't valid JSON; ignoring it.");
    }
  }
  const known = new Set(LIMITS.map((l) => l.id));
  for (const id of Object.keys(overrides)) {
    if (!known.has(id)) problems.push(`LIMITS: "${id}" isn't a limit this guard knows; ignoring it.`);
  }

  const limits = [];
  for (const def of LIMITS) {
    const o = overrides[def.id];
    if (o === false) continue;
    const base = def[plan];
    let limit = base.limit;
    let own = thresholds;
    if (o && typeof o === "object") {
      if (o.limit !== undefined) {
        if (typeof o.limit === "number" && o.limit > 0) limit = o.limit;
        else problems.push(`LIMITS: ${def.id}.limit should be a positive number; using ${base.limit}.`);
      }
      if (o.thresholds !== undefined) own = parseThresholds(Array.isArray(o.thresholds) ? o.thresholds.join(",") : o.thresholds, problems);
    } else if (o !== undefined && o !== true) {
      problems.push(`LIMITS: ${def.id} should be false or an object like {"limit": 50000}; ignoring it.`);
    }
    limits.push({ ...def, limit, period: base.period, thresholds: own });
  }

  const githubOn = Boolean(env.GITHUB_TOKEN && env.GITHUB_USER);
  if (Boolean(env.GITHUB_TOKEN) !== Boolean(env.GITHUB_USER)) {
    problems.push("GitHub needs both GITHUB_USER (a var) and GITHUB_TOKEN (a secret); GitHub isn't being watched.");
  }
  const activeLimits = githubOn ? limits : limits.filter((l) => l.product !== "github");

  const email = env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM ? { to: env.ALERT_EMAIL_TO, from: env.ALERT_EMAIL_FROM } : null;
  const format = String(env.WEBHOOK_FORMAT ?? "json").toLowerCase();
  const webhook = env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, format: ["discord", "slack", "ntfy", "json"].includes(format) ? format : "json" } : null;
  if (!email && !webhook) problems.push("No alert channel is set up: set ALERT_EMAIL_TO and ALERT_EMAIL_FROM, or WEBHOOK_URL.");
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) problems.push("CF_ACCOUNT_ID (a var) and CF_API_TOKEN (a secret) are needed to read Cloudflare usage.");

  const hour = Number(env.SUMMARY_HOUR ?? 8);
  return {
    plan,
    billingDay: day(env.BILLING_DAY, "BILLING_DAY"),
    githubBillingDay: day(env.GITHUB_BILLING_DAY, "GITHUB_BILLING_DAY"),
    thresholds,
    limits: activeLimits,
    email,
    webhook,
    dailySummary: truthy(env.DAILY_SUMMARY),
    summaryHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    github: githubOn ? { user: env.GITHUB_USER, token: env.GITHUB_TOKEN } : null,
    accountId: env.CF_ACCOUNT_ID ?? "",
    apiToken: env.CF_API_TOKEN ?? "",
    problems,
  };
}

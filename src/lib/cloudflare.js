// Reads usage from Cloudflare's GraphQL Analytics API.
//
// Each product is its own block (a GraphQL alias). All blocks go in one
// request; if Cloudflare rejects the whole query (a field it doesn't know
// makes the entire document invalid), each block is asked for on its own,
// so one wrong name can only blind its own product. A block that fails is
// reported as "can't read", never as zero.
//
// Cloudflare: these analytics "should not be used as a measure for usage
// that Cloudflare uses for billing purposes". They can count a little more
// than billing does (e.g. DDoS traffic), so warnings err early.

import { periodFor, isoDate } from "./periods.js";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

// R2 operation classes, from R2's pricing page. Anything not listed is
// counted as Class A, the scarcer one, so a new operation can't hide usage.
const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const R2_FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

/** Latest value per entity, summed: today's size of every database, bucket...
 *  null when there are no rows at all (nothing stored, or not reported yet):
 *  shown as "no data", never treated as an all-clear. */
function latestPerEntity(rows, entityKey, read) {
  if (!rows.length) return null;
  const latest = new Map();
  for (const r of rows) {
    const id = r.dimensions?.[entityKey] ?? "_";
    const date = r.dimensions?.date ?? r.dimensions?.datetime ?? "";
    const prev = latest.get(id);
    if (!prev || date > prev.date) latest.set(id, { date, value: read(r) });
  }
  let total = 0;
  for (const { value } of latest.values()) total += value;
  return total;
}

const sum = (rows, read) => rows.reduce((n, r) => n + (Number(read(r)) || 0), 0);

/**
 * The blocks. `limits` are the limit ids a block answers; `filter` is
 * "date" (YYYY-MM-DD) or "datetime" (ISO). Field names marked "unverified"
 * weren't in Cloudflare's docs; the live check confirms them.
 */
export const BLOCKS = [
  {
    alias: "workers",
    dataset: "workersInvocationsAdaptive",
    limits: ["workers.requests"],
    filter: "datetime",
    fields: "sum { requests }",
    parse: (rows) => ({ "workers.requests": sum(rows, (r) => r.sum?.requests) }),
  },
  {
    alias: "kvOps",
    dataset: "kvOperationsAdaptiveGroups",
    limits: ["kv.reads", "kv.writes", "kv.deletes", "kv.lists"],
    filter: "date",
    fields: "sum { requests } dimensions { actionType }",
    parse: (rows) => {
      const by = (t) => sum(rows.filter((r) => String(r.dimensions?.actionType).toLowerCase() === t), (r) => r.sum?.requests);
      return { "kv.reads": by("read"), "kv.writes": by("write"), "kv.deletes": by("delete"), "kv.lists": by("list") };
    },
  },
  {
    alias: "kvStorage",
    dataset: "kvStorageAdaptiveGroups",
    limits: ["kv.storage"],
    filter: "date",
    fields: "max { byteCount } dimensions { namespaceId date }",
    parse: (rows) => ({ "kv.storage": latestPerEntity(rows, "namespaceId", (r) => Number(r.max?.byteCount) || 0) }),
  },
  {
    alias: "d1Ops",
    dataset: "d1AnalyticsAdaptiveGroups",
    limits: ["d1.rowsRead", "d1.rowsWritten"],
    filter: "date",
    fields: "sum { rowsRead rowsWritten }",
    parse: (rows) => ({ "d1.rowsRead": sum(rows, (r) => r.sum?.rowsRead), "d1.rowsWritten": sum(rows, (r) => r.sum?.rowsWritten) }),
  },
  {
    alias: "d1Storage",
    dataset: "d1StorageAdaptiveGroups",
    limits: ["d1.storage"],
    filter: "date",
    fields: "max { databaseSizeBytes } dimensions { databaseId date }",
    parse: (rows) => ({ "d1.storage": latestPerEntity(rows, "databaseId", (r) => Number(r.max?.databaseSizeBytes) || 0) }),
  },
  {
    alias: "doRequests",
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    limits: ["do.requests"],
    filter: "date",
    fields: "sum { requests }",
    parse: (rows) => ({ "do.requests": sum(rows, (r) => r.sum?.requests) }),
  },
  {
    // unverified: activeTime (microseconds); billed duration is active
    // wall-clock time at 128 MB, so GB-s = seconds x 0.125.
    alias: "doDuration",
    dataset: "durableObjectsPeriodicGroups",
    limits: ["do.duration"],
    filter: "date",
    fields: "sum { activeTime }",
    parse: (rows) => ({ "do.duration": (sum(rows, (r) => r.sum?.activeTime) / 1e6) * 0.125 }),
  },
  {
    alias: "doStorage",
    dataset: "durableObjectsStorageGroups",
    limits: ["do.storage"],
    filter: "date",
    fields: "max { storedBytes } dimensions { date }",
    parse: (rows) => ({ "do.storage": latestPerEntity(rows, "_none", (r) => Number(r.max?.storedBytes) || 0) }),
  },
  {
    // unverified
    alias: "r2Ops",
    dataset: "r2OperationsAdaptiveGroups",
    limits: ["r2.classA", "r2.classB"],
    filter: "date",
    fields: "sum { requests } dimensions { actionType }",
    parse: (rows) => {
      let a = 0;
      let b = 0;
      for (const r of rows) {
        const action = String(r.dimensions?.actionType ?? "");
        const n = Number(r.sum?.requests) || 0;
        if (R2_FREE.has(action)) continue;
        if (R2_CLASS_B.has(action)) b += n;
        else a += n;
      }
      return { "r2.classA": a, "r2.classB": b };
    },
  },
  {
    // unverified
    alias: "r2Storage",
    dataset: "r2StorageAdaptiveGroups",
    limits: ["r2.storage"],
    filter: "date",
    fields: "max { payloadSize metadataSize } dimensions { bucketName date }",
    parse: (rows) => ({
      "r2.storage": latestPerEntity(rows, "bucketName", (r) => (Number(r.max?.payloadSize) || 0) + (Number(r.max?.metadataSize) || 0)),
    }),
  },
  {
    // unverified
    alias: "ai",
    dataset: "aiInferenceAdaptiveGroups",
    limits: ["ai.neurons"],
    filter: "date",
    fields: "sum { totalNeurons }",
    parse: (rows) => ({ "ai.neurons": sum(rows, (r) => r.sum?.totalNeurons) }),
  },
];

/** The window a block is queried over, as GraphQL filter fields. */
function filterFor(block, period, now, billingDay) {
  // Storage caps: look at the last 3 days and take each entity's latest value.
  const start = period === "cap" ? new Date(now.getTime() - 3 * 864e5) : periodFor(period, now, billingDay).start;
  return block.filter === "datetime"
    ? `datetime_geq: "${start.toISOString()}", datetime_leq: "${now.toISOString()}"`
    : `date_geq: "${isoDate(start)}", date_leq: "${isoDate(now)}"`;
}

function blockQuery(block, period, now, billingDay) {
  return `${block.alias}: ${block.dataset}(limit: 10000, filter: { ${filterFor(block, period, now, billingDay)} }) { ${block.fields} }`;
}

function document(parts) {
  return `query ($account: String!) { viewer { accounts(filter: { accountTag: $account }) { ${parts.join("\n")} } } }`;
}

class FatalError extends Error {}

async function post(config, query, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { account: config.accountId } }),
    });
  } catch (err) {
    throw new FatalError(`Can't reach Cloudflare's analytics API: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new FatalError(`Cloudflare refused the API token (HTTP ${res.status}). It needs Account > Account Analytics > Read.`);
  }
  if (res.status === 400 || res.status === 422) {
    // A GraphQL error sent with a 4xx: treat it like any GraphQL error, so
    // one bad block falls back to per-block queries instead of blinding all.
    const body = await res.json().catch(() => null);
    if (body && Array.isArray(body.errors)) return { data: body.data ?? null, errors: body.errors };
  }
  if (!res.ok) throw new FatalError(`Cloudflare's analytics API answered HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new FatalError("Cloudflare's analytics API sent something that isn't JSON.");
  }
}

const errorText = (errors) => (errors ?? []).map((e) => e.message).filter(Boolean).join("; ").slice(0, 300) || "unknown error";

/** Which datasets the account's analytics offer, or null if it can't tell. */
async function availableDatasets(config, fetchImpl) {
  try {
    const body = await post(config, `{ __type(name: "account") { fields { name } } }`, fetchImpl);
    const names = body?.data?.__type?.fields?.map((f) => f.name);
    return Array.isArray(names) && names.length ? new Set(names) : null;
  } catch (err) {
    if (err instanceof FatalError) throw err;
    return null;
  }
}

/**
 * Reads every Cloudflare limit in `limits` (config.limits entries).
 * @returns {Promise<{ values: Record<string, number>, unreadable: Record<string, string>,
 *   datasets: Record<string, boolean>, fatal: string | null }>}
 */
export async function readCloudflare(config, limits, now, fetchImpl = fetch) {
  const out = { values: {}, unreadable: {}, datasets: {}, fatal: null };
  const wanted = new Map(limits.map((l) => [l.id, l]));
  const blocks = BLOCKS.filter((b) => b.limits.some((id) => wanted.has(id)));
  if (!blocks.length) return out;
  if (!config.accountId || !config.apiToken) {
    out.fatal = "CF_ACCOUNT_ID and CF_API_TOKEN aren't set.";
    return out;
  }
  const markUnreadable = (block, why) => {
    for (const id of block.limits) if (wanted.has(id)) out.unreadable[id] = why;
  };

  try {
    const offered = await availableDatasets(config, fetchImpl);
    const runnable = [];
    for (const b of blocks) {
      const ok = offered ? offered.has(b.dataset) : true;
      // Recorded only when the schema actually said; unknown isn't "offered".
      if (offered) out.datasets[b.dataset] = ok;
      if (ok) runnable.push(b);
      else markUnreadable(b, `This account's analytics don't offer ${b.dataset}.`);
    }
    if (!runnable.length) return out;

    const periodOf = (b) => wanted.get(b.limits.find((id) => wanted.has(id))).period;
    const parts = (list) => list.map((b) => blockQuery(b, periodOf(b), now, config.billingDay));
    const apply = (b, account, errors) => {
      const rows = account?.[b.alias];
      const own = (errors ?? []).filter((e) => Array.isArray(e.path) && e.path.includes(b.alias));
      if (own.length || !Array.isArray(rows)) {
        markUnreadable(b, `Cloudflare: ${errorText(own.length ? own : errors)}`);
        return;
      }
      const parsed = b.parse(rows);
      for (const id of b.limits) if (wanted.has(id)) out.values[id] = parsed[id];
    };

    const all = await post(config, document(parts(runnable)), fetchImpl);
    const account = all?.data?.viewer?.accounts?.[0];
    if (account) {
      for (const b of runnable) apply(b, account, all.errors);
      return out;
    }
    // The whole query was refused: ask for each block on its own.
    for (const b of runnable) {
      const one = await post(config, document(parts([b])), fetchImpl);
      apply(b, one?.data?.viewer?.accounts?.[0], one?.errors ?? [{ message: "no data" }]);
    }
    return out;
  } catch (err) {
    if (err instanceof FatalError) {
      out.fatal = err.message;
      for (const b of blocks) markUnreadable(b, err.message);
      return out;
    }
    throw err;
  }
}

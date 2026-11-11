import { env } from "cloudflare:test";
import { runCheck } from "../src/lib/check.js";
import { BLOCKS } from "../src/lib/cloudflare.js";

export const ALL_DATASETS = BLOCKS.map((b) => b.dataset);

/**
 * A fake Cloudflare GraphQL API, GitHub API and webhook.
 * opts.rows: { alias: rows[] }; opts.datasets: names offered (default all);
 * opts.badAlias: an alias whose presence makes the whole query invalid;
 * opts.cfStatus: HTTP status for every GraphQL call; opts.github: { status, items, publicRepos };
 * opts.webhookStatus.
 */
export function fakeFetch(opts = {}) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      if (opts.cfStatus) return new Response("nope", { status: opts.cfStatus });
      const { query } = JSON.parse(init.body);
      if (query.includes("__type")) {
        if (opts.noIntrospection) return Response.json({ errors: [{ message: "introspection disabled" }] });
        return Response.json({ data: { __type: { fields: (opts.datasets ?? ALL_DATASETS).map((name) => ({ name })) } } });
      }
      if (opts.badAlias && query.includes(`${opts.badAlias}:`)) {
        return Response.json({ data: null, errors: [{ message: `unknown field in ${opts.badAlias}` }] }, { status: opts.status400 ? 400 : 200 });
      }
      const account = {};
      for (const b of BLOCKS) if (query.includes(`${b.alias}:`)) account[b.alias] = opts.rows?.[b.alias] ?? [];
      return Response.json({ data: { viewer: { accounts: [account] } } });
    }
    if (url.startsWith("https://api.github.com/users/")) {
      const g = opts.github ?? {};
      if (g.status && g.status !== 200) return new Response("{}", { status: g.status });
      return Response.json({ usageItems: g.items ?? [] });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      const repo = url.slice("https://api.github.com/repos/".length);
      const isPublic = (opts.github?.publicRepos ?? []).includes(repo);
      return isPublic ? Response.json({ private: false }) : new Response("{}", { status: 404 });
    }
    if (url.startsWith("https://hooks.test/")) return new Response("ok", { status: opts.webhookStatus ?? 200 });
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  return { impl, calls };
}

/** A fake send_email binding that records messages (or fails). */
export function fakeEmail({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    binding: {
      async send(message) {
        if (fail) throw new Error("E_RECIPIENT_NOT_ALLOWED");
        sent.push(message);
      },
    },
  };
}

/** Workers requests used, as GraphQL rows. */
export const workers = (n) => ({ workers: [{ sum: { requests: n } }] });

export async function check({ at, rows = {}, envOverrides = {}, ...fetchOpts } = {}) {
  const email = envOverrides.__email ?? fakeEmail();
  const { __email, ...overrides } = envOverrides;
  const f = fakeFetch({ rows, ...fetchOpts });
  const result = await runCheck({ ...env, EMAIL: email.binding, ...overrides }, { now: new Date(at), fetchImpl: f.impl });
  return { result, email, calls: f.calls };
}

export async function resetAll() {
  await env.DB.batch(["samples", "alerts", "datasets", "state", "repo_visibility"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export const reading = (result, id) => result.readings.find((r) => r.id === id);

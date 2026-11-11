import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { check, fakeEmail, reading, resetAll, workers, ALL_DATASETS } from "./helpers.js";

beforeEach(resetAll);

const subjects = (email) => email.sent.length;

describe("thresholds, once per period", () => {
  it("79% nothing; 80% one alert; 85% nothing new; 100% one more; the next day re-arms", async () => {
    const day = "2026-11-10";
    expect((await check({ at: `${day}T20:00:00Z`, rows: workers(79_000) })).result.alertsSent).toEqual([]);
    const at80 = await check({ at: `${day}T20:30:00Z`, rows: workers(80_000) });
    expect(at80.result.alertsSent).toEqual([{ limitId: "workers.requests", kind: "threshold:80" }]);
    expect(subjects(at80.email)).toBe(1);
    expect((await check({ at: `${day}T21:00:00Z`, rows: workers(85_000) })).result.alertsSent).toEqual([]);
    const at100 = await check({ at: `${day}T22:00:00Z`, rows: workers(100_000) });
    expect(at100.result.alertsSent).toEqual([{ limitId: "workers.requests", kind: "threshold:100" }]);
    const nextDay = await check({ at: "2026-11-11T22:00:00Z", rows: workers(81_000) });
    expect(nextDay.result.alertsSent).toEqual([{ limitId: "workers.requests", kind: "threshold:80" }]);
  });

  it("sends one message when several limits cross at once, with each limit once", async () => {
    const { email, result } = await check({
      at: "2026-11-10T20:00:00Z",
      rows: { ...workers(100_000), kvOps: [{ sum: { requests: 900 }, dimensions: { actionType: "write" } }] },
    });
    // KV writes at 90% by 20:00 is also on course to pass 100% before midnight.
    expect(result.alertsSent.map((a) => `${a.limitId}:${a.kind}`).sort()).toEqual([
      "kv.writes:projected",
      "kv.writes:threshold:80",
      "workers.requests:threshold:100",
      "workers.requests:threshold:80",
    ]);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe("me@example.com");
  });

  it("two checks at once send each alert only once", async () => {
    const [a, b] = await Promise.all([
      check({ at: "2026-11-10T20:00:00Z", rows: workers(90_000) }),
      check({ at: "2026-11-10T20:00:00Z", rows: workers(90_000) }),
    ]);
    // 90% at 20:00: the 80% warning and the "on course" one, each exactly once across both checks.
    const all = [...a.result.alertsSent, ...b.result.alertsSent].map((x) => x.kind).sort();
    expect(all).toEqual(["projected", "threshold:80"]);
    expect(a.email.sent.length + b.email.sent.length).toBeLessThanOrEqual(2);
  });

  it("warns early when the current rate reaches the limit before the reset", async () => {
    const { result } = await check({ at: "2026-11-10T04:00:00Z", rows: workers(25_000) });
    expect(result.alertsSent).toEqual([{ limitId: "workers.requests", kind: "projected" }]);
    expect((await check({ at: "2026-11-10T05:00:00Z", rows: workers(31_000) })).result.alertsSent).toEqual([]);
  });

  it("re-arms a storage cap only after usage falls well below 80%, then warns again", async () => {
    const d1 = (bytes) => ({ d1Storage: [{ max: { databaseSizeBytes: bytes }, dimensions: { databaseId: "db1", date: "2026-11-10" } }] });
    const GB = 1024 ** 3;
    expect((await check({ at: "2026-11-10T10:00:00Z", rows: d1(4.3 * GB) })).result.alertsSent).toHaveLength(1);
    expect((await check({ at: "2026-11-10T11:00:00Z", rows: d1(4.4 * GB) })).result.alertsSent).toHaveLength(0);
    // Hovering just under 80% (78%) doesn't re-arm...
    await check({ at: "2026-11-10T12:00:00Z", rows: d1(3.9 * GB) });
    expect((await check({ at: "2026-11-10T13:00:00Z", rows: d1(4.1 * GB) })).result.alertsSent).toHaveLength(0);
    // ...but dropping under 70% does.
    await check({ at: "2026-11-10T14:00:00Z", rows: d1(1 * GB) });
    expect((await check({ at: "2026-11-10T15:00:00Z", rows: d1(4.3 * GB) })).result.alertsSent).toHaveLength(1);
  });

  it("shows a cap with no data as 'no data', and doesn't re-arm on it", async () => {
    const d1 = (bytes) => ({ d1Storage: [{ max: { databaseSizeBytes: bytes }, dimensions: { databaseId: "db1", date: "2026-11-10" } }] });
    await check({ at: "2026-11-10T10:00:00Z", rows: d1(4.3 * 1024 ** 3) });
    const empty = await check({ at: "2026-11-10T11:00:00Z" });
    expect(reading(empty.result, "d1.storage")).toMatchObject({ status: "nodata", used: null });
    expect((await check({ at: "2026-11-10T12:00:00Z", rows: d1(4.3 * 1024 ** 3) })).result.alertsSent).toHaveLength(0);
  });

  it("releases a claim left behind by a check that died before sending", async () => {
    await env.DB.prepare("INSERT INTO alerts (limit_id, period_start, kind, sent_at) VALUES ('workers.requests', '2026-11-10', 'threshold:80', '2026-11-10 19:00:00')").run();
    const { result } = await check({ at: "2026-11-10T20:00:00Z", rows: workers(85_000) });
    expect(result.alertsSent.map((a) => a.kind)).toContain("threshold:80");
  });
});

describe("reading Cloudflare", () => {
  it("sums latest storage per database, and splits KV operations by type", async () => {
    const { result } = await check({
      at: "2026-11-10T12:00:00Z",
      rows: {
        d1Storage: [
          { max: { databaseSizeBytes: 100 }, dimensions: { databaseId: "a", date: "2026-11-09" } },
          { max: { databaseSizeBytes: 150 }, dimensions: { databaseId: "a", date: "2026-11-10" } },
          { max: { databaseSizeBytes: 50 }, dimensions: { databaseId: "b", date: "2026-11-10" } },
        ],
        kvOps: [
          { sum: { requests: 10 }, dimensions: { actionType: "read" } },
          { sum: { requests: 3 }, dimensions: { actionType: "list" } },
        ],
        r2Ops: [
          { sum: { requests: 7 }, dimensions: { actionType: "PutObject" } },
          { sum: { requests: 9 }, dimensions: { actionType: "GetObject" } },
          { sum: { requests: 99 }, dimensions: { actionType: "DeleteObject" } },
          { sum: { requests: 2 }, dimensions: { actionType: "SomethingNew" } },
        ],
      },
    });
    expect(reading(result, "d1.storage").used).toBe(200);
    expect(reading(result, "kv.reads").used).toBe(10);
    expect(reading(result, "kv.lists").used).toBe(3);
    expect(reading(result, "r2.classA").used).toBe(9);
    expect(reading(result, "r2.classB").used).toBe(9);
  });

  it("reports a dataset the account doesn't offer as unreadable, not 0%", async () => {
    const { result } = await check({ at: "2026-11-10T12:00:00Z", datasets: ALL_DATASETS.filter((d) => d !== "aiInferenceAdaptiveGroups") });
    expect(reading(result, "ai.neurons")).toMatchObject({ status: "unreadable", used: null });
    expect(reading(result, "ai.neurons").error).toMatch(/don't offer aiInferenceAdaptiveGroups/);
    expect(reading(result, "workers.requests").status).toBe("ok");
    expect(result.datasets.aiInferenceAdaptiveGroups).toBe(false);
  });

  it("when one block makes the whole query invalid, asks for each block alone", async () => {
    const { result, calls } = await check({ at: "2026-11-10T12:00:00Z", badAlias: "doDuration", rows: workers(5) });
    expect(reading(result, "do.duration").status).toBe("unreadable");
    expect(reading(result, "workers.requests")).toMatchObject({ status: "ok", used: 5 });
    expect(calls.filter((c) => c.url.includes("graphql")).length).toBeGreaterThan(3);
  });

  it("still works when introspection isn't available", async () => {
    const { result } = await check({ at: "2026-11-10T12:00:00Z", noIntrospection: true, rows: workers(1) });
    expect(reading(result, "workers.requests").used).toBe(1);
  });

  it("after 3 failed checks in a row, sends one 'can't read' alert; recovery resets it", async () => {
    for (let h = 10; h < 12; h++) expect((await check({ at: `2026-11-10T${h}:00:00Z`, cfStatus: 403 })).result.alertsSent).toEqual([]);
    const third = await check({ at: "2026-11-10T12:00:00Z", cfStatus: 403 });
    expect(third.result.alertsSent).toEqual([{ limitId: "guard.cloudflare", kind: "blind" }]);
    expect(third.result.fatal).toMatch(/Account Analytics > Read/);
    expect(third.email.sent).toHaveLength(1);
    expect((await check({ at: "2026-11-10T13:00:00Z", cfStatus: 403 })).result.alertsSent).toEqual([]);
    expect((await check({ at: "2026-11-10T14:00:00Z" })).result.failures.cloudflare).toBe(0);
  });

  it("counts a source as failed when none of its limits can be read, even with HTTP 200", async () => {
    // e.g. a wrong account id: Cloudflare answers 200 with errors and no data.
    for (let h = 10; h < 13; h++) await check({ at: `2026-11-10T${h}:00:00Z`, badAlias: "workers", datasets: ["workersInvocationsAdaptive"] });
    const { result } = await check({ at: "2026-11-10T13:00:00Z", badAlias: "workers", datasets: ["workersInvocationsAdaptive"] });
    const sent = await env.DB.prepare("SELECT limit_id FROM alerts WHERE kind = 'blind'").all();
    expect(sent.results).toEqual([{ limit_id: "guard.cloudflare" }]);
    expect(result.fatal).toMatch(/None of its limits could be read/);
  });

  it("manual checks don't count toward the streak", async () => {
    const { runCheck } = await import("../src/lib/check.js");
    const { fakeFetch } = await import("./helpers.js");
    const f = fakeFetch({ cfStatus: 403 });
    for (let i = 0; i < 4; i++) await runCheck({ ...env, EMAIL: fakeEmail().binding }, { now: new Date("2026-11-10T10:00:00Z"), fetchImpl: f.impl, manual: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first()).n).toBe(0);
  });

  it("treats Cloudflare's GraphQL errors sent with HTTP 400 like any other, falling back per block", async () => {
    const { result } = await check({ at: "2026-11-10T12:00:00Z", badAlias: "ai", status400: true, rows: workers(7) });
    expect(reading(result, "workers.requests").used).toBe(7);
    expect(reading(result, "ai.neurons").status).toBe("unreadable");
  });
});

describe("delivery", () => {
  it("if every channel fails, the alert is released and sent on a later check", async () => {
    const broken = fakeEmail({ fail: true });
    const first = await check({ at: "2026-11-10T20:00:00Z", rows: workers(90_000), envOverrides: { __email: broken } });
    expect(first.result.alertsSent).toEqual([]);
    expect(first.result.delivery[0]).toMatchObject({ channel: "email", ok: false, error: "E_RECIPIENT_NOT_ALLOWED" });
    const second = await check({ at: "2026-11-10T21:00:00Z", rows: workers(90_000) });
    expect(second.result.alertsSent.map((a) => a.kind)).toContain("threshold:80");
    expect(second.email.sent).toHaveLength(1);
  });

  it("posts Discord-shaped JSON to a webhook", async () => {
    const { calls } = await check({
      at: "2026-11-10T20:00:00Z",
      rows: workers(90_000),
      envOverrides: { WEBHOOK_URL: "https://hooks.test/abc", WEBHOOK_FORMAT: "discord" },
    });
    const hook = calls.find((c) => c.url === "https://hooks.test/abc");
    expect(JSON.parse(hook.init.body).content).toMatch(/^\*\*Usage warning: Workers requests\*\*/);
  });

  it("sends the daily summary once, at the summary hour", async () => {
    const env2 = { DAILY_SUMMARY: "true", SUMMARY_HOUR: "8" };
    const a = await check({ at: "2026-11-10T08:07:00Z", rows: workers(10), envOverrides: env2 });
    expect(a.email.sent).toHaveLength(1);
    const b = await check({ at: "2026-11-10T08:30:00Z", rows: workers(10), envOverrides: env2 });
    expect(b.email.sent).toHaveLength(0);
  });
});

describe("GitHub Actions", () => {
  const gh = { GITHUB_USER: "me", GITHUB_TOKEN: "ghp_test" };
  const items = [
    { date: "2026-11-03T00:00:00Z", product: "actions", sku: "actions_linux", unitType: "Minutes", quantity: 1000, grossAmount: 6, discountAmount: 6, netAmount: 0, repositoryName: "private-app" },
    { date: "2026-11-04T00:00:00Z", product: "actions", sku: "actions_macos", unitType: "Minutes", quantity: 100, grossAmount: 6.2, discountAmount: 0, netAmount: 0.2, repositoryName: "me/private-app" },
    { date: "2026-11-05T00:00:00Z", product: "actions", sku: "actions_linux", unitType: "Minutes", quantity: 5000, grossAmount: 30, discountAmount: 30, netAmount: 0, repositoryName: "open-source" },
    { date: "2026-11-05T00:00:00Z", product: "actions", sku: "actions_storage", unitType: "GigabyteHours", quantity: 180, grossAmount: 0.1, discountAmount: 0.1, netAmount: 0, repositoryName: "private-app" },
    { date: "2026-11-05T00:00:00Z", product: "packages", sku: "packages_storage", unitType: "GigabyteHours", quantity: 9999, grossAmount: 9, discountAmount: 9, netAmount: 0 },
    { date: "2026-10-31T00:00:00Z", product: "actions", sku: "actions_linux", unitType: "Minutes", quantity: 9999, grossAmount: 99, discountAmount: 99, netAmount: 0, repositoryName: "private-app" },
  ];

  it("counts private repos' compute and storage, leaves public repos out, and alerts when GitHub starts charging", async () => {
    const { result } = await check({
      at: "2026-11-10T12:00:00Z",
      envOverrides: gh,
      github: { items, publicRepos: ["me/open-source"] },
    });
    expect(reading(result, "github.compute").used).toBeCloseTo(12.2);
    expect(reading(result, "github.storage").used).toBeCloseTo(180 / 720);
    expect(result.alertsSent.map((a) => `${a.limitId}:${a.kind}`).sort()).toEqual([
      "github.charges:charging",
      "github.compute:threshold:100",
      "github.compute:threshold:80",
      // 0.25 GB-month accrued by the 10th: on course for about 0.8 by the month's end.
      "github.storage:projected",
    ]);
    expect(result.githubBreakdown).toContainEqual({ sku: "actions_linux", unit: "Minutes", repos: "public", quantity: 5000, grossAmount: 30 });
    const cached = await env.DB.prepare("SELECT name, public FROM repo_visibility ORDER BY name").all();
    expect(cached.results).toEqual([{ name: "me/open-source", public: 1 }, { name: "me/private-app", public: 0 }]);
  });

  it("an expired GitHub token alerts after 3 checks, separately from Cloudflare", async () => {
    for (let h = 10; h < 13; h++) await check({ at: `2026-11-10T${h}:00:00Z`, envOverrides: gh, github: { status: 401 }, rows: workers(5) });
    const sent = await env.DB.prepare("SELECT limit_id FROM alerts WHERE kind = 'blind'").all();
    expect(sent.results).toEqual([{ limit_id: "guard.github" }]);
  });

  it("keys the charging alert by month even when the compute limit is turned off", async () => {
    const off = { ...gh, LIMITS: JSON.stringify({ "github.compute": false }) };
    const charged = { items: [{ date: "2026-11-04T00:00:00Z", product: "actions", unitType: "Minutes", grossAmount: 1, netAmount: 1, repositoryName: "x" }] };
    expect((await check({ at: "2026-11-10T12:00:00Z", envOverrides: off, github: charged })).result.alertsSent.map((a) => a.kind)).toContain("charging");
    expect((await check({ at: "2026-11-11T12:00:00Z", envOverrides: off, github: charged })).result.alertsSent.map((a) => a.kind)).not.toContain("charging");
  });

  it("a reader that throws blinds only its own source", async () => {
    // A non-string repositoryName used to throw; now it's simply counted.
    const weird = { items: [{ date: "2026-11-04T00:00:00Z", product: "actions", unitType: "Minutes", grossAmount: 11, netAmount: 0, repositoryName: 42 }] };
    const { result } = await check({ at: "2026-11-10T20:00:00Z", envOverrides: gh, github: weird, rows: workers(90_000) });
    expect(reading(result, "github.compute").used).toBe(11);
    expect(result.alertsSent.map((a) => a.limitId)).toContain("workers.requests");
  });

  it("says plainly when the token is wrong or the report isn't available", async () => {
    const bad = await check({ at: "2026-11-10T12:00:00Z", envOverrides: gh, github: { status: 403 } });
    expect(reading(bad.result, "github.compute").error).toMatch(/classic personal access token with the "user" scope/);
    const missing = await check({ at: "2026-11-10T12:00:00Z", envOverrides: gh, github: { status: 404 } });
    expect(reading(missing.result, "github.storage").status).toBe("unreadable");
  });
});

describe("routes", () => {
  async function call(path, init = {}, overrides = {}) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://guard.test${path}`, init), { ...env, EMAIL: fakeEmail().binding, ...overrides }, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const basic = (pw) => ({ Authorization: `Basic ${btoa(`any:${pw}`)}` });

  it("asks for the password, and refuses a short one", async () => {
    expect((await call("/health")).status).toBe(200);
    const res = await call("/");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/Basic/);
    expect((await call("/", { headers: basic("wrong-password") })).status).toBe(401);
    expect((await call("/", {}, { STATUS_PASSWORD: "short" })).status).toBe(503);
  });

  it("shows the last check, including what couldn't be read, escaped", async () => {
    await check({ at: "2026-11-10T12:00:00Z", rows: workers(85_000), datasets: ALL_DATASETS.filter((d) => d !== "r2StorageAdaptiveGroups") });
    const html = await (await call("/", { headers: basic("test-status-password") })).text();
    expect(html).toContain("Workers requests");
    expect(html).toContain("85,000 of 100,000");
    expect(html).toMatch(/R2 storage<\/td><td colspan="2">Can't read: This account&#39;s analytics don&#39;t offer r2StorageAdaptiveGroups/);
    expect(html).toContain("Recent alerts");
  });

  it("sends a test alert through every channel and reports each", async () => {
    const res = await call("/api/test-alert", { method: "POST", headers: { Authorization: "Bearer test-status-password" } });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ channel: "email", ok: true }]);
    const broken = await call("/api/test-alert", { method: "POST", headers: basic("test-status-password") }, { EMAIL: fakeEmail({ fail: true }).binding });
    expect(broken.status).toBe(502);
    for (const site of ["cross-site", "same-site"]) {
      const res2 = await call("/api/test-alert", { method: "POST", headers: { ...basic("test-status-password"), "Sec-Fetch-Site": site } });
      expect(res2.status, site).toBe(403);
    }
    const sameOrigin = await call("/api/test-alert", { method: "POST", headers: { ...basic("test-status-password"), "Sec-Fetch-Site": "same-origin" } });
    expect(sameOrigin.status).toBe(200);
  });

  it("accepts UTF-8 passwords and either case of the auth scheme", async () => {
    const pw = "pässwörd-🦜-long";
    const utf8 = btoa(String.fromCharCode(...new TextEncoder().encode(`me:${pw}`)));
    expect((await call("/", { headers: { Authorization: `Basic ${utf8}` } }, { STATUS_PASSWORD: pw })).status).toBe(200);
    expect((await call("/api/status", { headers: { Authorization: "bearer test-status-password" } })).status).toBe(200);
  });
});

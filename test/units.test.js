import { describe, it, expect } from "vitest";
import { readConfig } from "../src/lib/config.js";
import { periodFor } from "../src/lib/periods.js";
import { buildReadings, candidates, capsToRearm } from "../src/lib/evaluate.js";
import { formatValue } from "../src/lib/limits.js";
import { mime, webhookRequest, cutBytes } from "../src/lib/channels.js";

const base = { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", ALERT_EMAIL_TO: "me@x.test", ALERT_EMAIL_FROM: "g@x.test" };

describe("settings", () => {
  it("uses the free plan's limits by default, with 80/100 thresholds", () => {
    const c = readConfig(base);
    expect(c.plan).toBe("free");
    expect(c.thresholds).toEqual([80, 100]);
    const w = c.limits.find((l) => l.id === "workers.requests");
    expect(w).toMatchObject({ limit: 100_000, period: "day" });
    expect(c.limits.some((l) => l.product === "github")).toBe(false);
    expect(c.problems).toEqual([]);
  });

  it("uses monthly included amounts on the paid plan", () => {
    const c = readConfig({ ...base, PLAN: "paid", BILLING_DAY: "15" });
    expect(c.limits.find((l) => l.id === "workers.requests")).toMatchObject({ limit: 10_000_000, period: "month" });
    expect(c.billingDay).toBe(15);
  });

  it("applies overrides, turns limits off, and reports bad settings without failing", () => {
    const c = readConfig({
      ...base,
      THRESHOLDS: "90, 50, 90",
      LIMITS: JSON.stringify({ "d1.rowsWritten": { limit: 50000, thresholds: [70] }, "kv.lists": false, "nope.x": false, "kv.reads": { limit: -1 } }),
    });
    expect(c.thresholds).toEqual([50, 90]);
    expect(c.limits.find((l) => l.id === "d1.rowsWritten")).toMatchObject({ limit: 50000, thresholds: [70] });
    expect(c.limits.find((l) => l.id === "kv.lists")).toBeUndefined();
    expect(c.limits.find((l) => l.id === "kv.reads").limit).toBe(100_000);
    expect(c.problems.join("\n")).toMatch(/nope\.x/);
    expect(c.problems.join("\n")).toMatch(/kv\.reads\.limit/);

    const bad = readConfig({ ...base, PLAN: "gold", THRESHOLDS: "lots", LIMITS: "{oops", BILLING_DAY: "40" });
    expect(bad.plan).toBe("free");
    expect(bad.thresholds).toEqual([80, 100]);
    expect(bad.billingDay).toBe(1);
    expect(bad.problems).toHaveLength(4);
  });

  it("watches GitHub only with both a user and a token, and says when one is missing", () => {
    expect(readConfig({ ...base, GITHUB_USER: "me", GITHUB_TOKEN: "ghp_x" }).limits.some((l) => l.product === "github")).toBe(true);
    const half = readConfig({ ...base, GITHUB_USER: "me" });
    expect(half.github).toBeNull();
    expect(half.problems.join()).toMatch(/GITHUB_TOKEN/);
  });

  it("says when there's no alert channel or no Cloudflare token", () => {
    expect(readConfig({}).problems.join("\n")).toMatch(/No alert channel[\s\S]*CF_ACCOUNT_ID/);
  });
});

describe("periods", () => {
  it("days run 00:00 to 00:00 UTC", () => {
    const p = periodFor("day", new Date("2026-11-10T23:59:59Z"));
    expect(p.key).toBe("2026-11-10");
    expect(p.end.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("months start on the billing day, which shrinks to fit short months", () => {
    expect(periodFor("month", new Date("2026-11-10T00:00:00Z")).key).toBe("2026-11-01");
    expect(periodFor("month", new Date("2026-11-10T00:00:00Z"), 15).key).toBe("2026-10-15");
    expect(periodFor("month", new Date("2026-11-20T00:00:00Z"), 15).end.toISOString()).toBe("2026-12-15T00:00:00.000Z");
    expect(periodFor("month", new Date("2027-02-28T12:00:00Z"), 31).key).toBe("2027-02-28");
    expect(periodFor("month", new Date("2027-02-27T12:00:00Z"), 31).key).toBe("2027-01-31");
    expect(periodFor("month", new Date("2027-01-05T00:00:00Z"), 10).key).toBe("2026-12-10");
  });

  it("caps have no reset", () => {
    expect(periodFor("cap", new Date())).toMatchObject({ key: "cap", end: null });
  });
});

describe("evaluating", () => {
  const config = readConfig(base);
  const only = (id) => config.limits.filter((l) => l.id === id);

  it("treats a missing value as unreadable, never as 0%", () => {
    const [r] = buildReadings(config, only("kv.reads"), { values: {}, unreadable: {} }, new Date());
    expect(r).toMatchObject({ status: "unreadable", used: null, pct: null });
    expect(candidates(config, [r], new Date())).toEqual([]);
  });

  it("flags every threshold crossed", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const [r] = buildReadings(config, only("kv.writes"), { values: { "kv.writes": 1000 }, unreadable: {} }, now);
    expect(candidates(config, [r], now).map((c) => c.kind)).toEqual(["threshold:80", "threshold:100"]);
  });

  it("projects from the current rate once enough of the period has passed", () => {
    const at = (iso, used) => {
      const now = new Date(iso);
      const [r] = buildReadings(config, only("workers.requests"), { values: { "workers.requests": used }, unreadable: {} }, now);
      return candidates(config, [r], now);
    };
    // 2 hours in, 10%: too early to project (under 3 hours and under 20%).
    expect(at("2026-11-10T02:00:00Z", 10_000)).toEqual([]);
    // 4 hours in, 20%: on course for 120%; reaches 100% at 20:00.
    const [p] = at("2026-11-10T04:00:00Z", 20_000);
    expect(p.kind).toBe("projected");
    expect(p.line).toMatch(/about 2026-11-10 20:00 UTC \(on course for 120%\)/);
    // On course for less than 100%: nothing.
    expect(at("2026-11-10T12:00:00Z", 40_000)).toEqual([]);
  });

  it("re-arms storage caps below the lowest threshold", () => {
    const now = new Date();
    const r = buildReadings(config, only("d1.storage"), { values: { "d1.storage": 1 }, unreadable: {} }, now);
    expect(capsToRearm(r)).toEqual(["d1.storage"]);
  });

  it("formats each unit", () => {
    expect(formatValue(1234567, "count")).toBe("1,234,567");
    expect(formatValue(5 * 1024 ** 3, "bytes")).toBe("5.00 GB");
    expect(formatValue(12, "usd")).toBe("$12.00");
    expect(formatValue(0.4567, "gbmonth")).toBe("0.457 GB-month");
    expect(formatValue(null, "count")).toBe("?");
  });
});

describe("email", () => {
  it("builds a valid plain-text MIME message, encoding a non-ASCII subject", () => {
    const raw = mime({ from: "Guard <g@x.test>", to: "me@x.test", subject: "Usage â€” warning\r\nBcc: evil@x.test", text: "Hello\nThere" });
    expect(raw).toMatch(/^From: Guard <g@x\.test>\r\nTo: me@x\.test\r\nSubject: =\?UTF-8\?B\?/);
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@x\.test>/);
    const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe("Hello\r\nThere");
  });
});

describe("webhooks", () => {
  it("never lets alert text ping a Discord or Slack channel", () => {
    const d = JSON.parse(webhookRequest({ format: "discord" }, "s", "@everyone", false).body);
    expect(d.allowed_mentions).toEqual({ parse: [] });
    const s = JSON.parse(webhookRequest({ format: "slack" }, "s", "<!channel> a & b", false).body);
    expect(s.text).toContain("&lt;!channel&gt; a &amp; b");
  });
  it("cuts ntfy bodies by bytes without splitting a character", () => {
    const body = webhookRequest({ format: "ntfy" }, "s", "é".repeat(3000), false).body;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(4000);
    expect(body).not.toContain("�");
    expect(cutBytes("aé", 2)).toBe("a");
  });
});
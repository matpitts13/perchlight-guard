# SDD: perchlight-guard

**Version:** 1.0
**Date:** 2026-11-10
**Status:** Draft

## Summary

A free, self-hosted Worker that watches your Cloudflare usage and emails you before you hit a free-plan limit (or, on Workers Paid, before you start paying overage). Every hour it asks Cloudflare's GraphQL Analytics API how much of each limit you've used today (daily limits) or this month (monthly ones), warns at 80% and again at 100%, and warns early when the current rate will reach the limit before it resets. It runs on your own account, needs one read-only API token, and sends email for free to your own verified address. Part of the Perchlight family.

## Why

On the free plan, going over a limit means errors (Workers return error 1027; KV, D1, Durable Objects and Workers AI calls fail) until 00:00 UTC. On Workers Paid it means a bill. Cloudflare's dashboard shows usage, but nothing tells you ahead of time, per limit, across every product.

## Requirements

### Must have

- **Limits watched** (free-plan values, from Cloudflare's docs on 2026-11-10; all editable):

  | Product | Limit | Period |
  |---|---|---|
  | Workers | 100,000 requests | day (00:00 UTC) |
  | KV | 100,000 reads; 1,000 writes; 1,000 deletes; 1,000 lists; 1 GB stored | day; storage is a cap |
  | D1 | 5,000,000 rows read; 100,000 rows written; 5 GB stored | day; storage is a cap |
  | Durable Objects | 100,000 requests; 13,000 GB-s duration; 5 GB stored | day; storage is a cap |
  | R2 | 10 GB-month stored; 1,000,000 Class A; 10,000,000 Class B | month |
  | Workers AI | 10,000 neurons | day |

  A **plan preset** (`free` or `paid`) picks the defaults; Paid uses its monthly included amounts and resets on a chosen billing day. Any limit can be overridden, turned off, or given its own thresholds.
- **Thresholds:** warn at 80% and at 100% (configurable list). Each threshold alerts **once per period** per limit, so you get two emails at most, not one an hour.
- **Early warning:** after a few hours of data in the period, project the usage at the reset time from the current rate. If it will pass 100%, send one "on course to hit X at about HH:MM UTC" alert per period.
- **Alert channels:**
  - **Email** through the Workers `send_email` binding to your verified destination address (Email Routing). Cloudflare says these sends are always free.
  - **Webhook** (optional): a JSON POST, with ready-made formats for Discord, Slack and ntfy.
- **Daily summary** (optional, off by default): one email a day with every limit's usage.
- **A test command:** `POST /api/test-alert` sends a sample alert through every channel, so you know alerts arrive before you need one.
- **History** in D1: usage per limit per hour, and every alert sent. The Perchlight desktop app gets screens for both.
- **Shows what it can't see:** at startup it checks which GraphQL datasets your account offers (a schema query). A product whose dataset is missing or whose query fails is reported in the status and the daily summary, never silently treated as "0% used."
- **Status page** at `/` behind a password (HTTP Basic auth, `STATUS_PASSWORD`): every limit, % used, when it resets, and which ones couldn't be read.
- **Its own footprint is tiny and stated:** one Worker request an hour (24 a day), one GraphQL call per check, and a few D1 rows written per check.
- **Deploy to Cloudflare button**, tests, README, v0.1.0 release, graphify on creation.

- **GitHub Actions** (optional; on when `GITHUB_TOKEN` and `GITHUB_USER` are set). This is the limit that caught us out in November 2026.
  - **Compute:** GitHub Free includes **$12 of compute a month**. GitHub tracks it in dollars, not minutes, because runner types cost different amounts per minute (Linux $0.006, Windows $0.010, macOS $0.062). Used = the gross amount of runner usage in **private** repos this month. Standard runners in public repos are free and don't use the allowance, so items for public repos are left out. The guard checks each repo's visibility once a day: a repo that GitHub's API returns as public is public, and anything else is treated as private, which counts it to be safe. When GitHub starts charging (`netAmount` > 0 on a compute item), that's its own alert.
  - **Artifact storage:** 500 MB on Free, accrued in GB-hours. Used = GB-hours this month ÷ hours in the month, compared with 0.5 GB-month. That's how GitHub's own "you've used 90% of 0.5 GB" email is worked out.
  - **Source:** `GET /users/{user}/settings/billing/usage?year&month` (items with `date`, `product`, `sku`, `quantity`, `unitType`, `grossAmount`, `discountAmount`, `netAmount`, `repositoryName`). Needs a **classic** personal access token with the `user` scope; fine-grained tokens aren't supported by this endpoint. Rate limit 5,000 requests an hour: the guard makes 1 an hour, plus visibility checks once a day.
  - **Period:** calendar month UTC (the reset GitHub's email showed: "December 01"), or `GITHUB_BILLING_DAY`.
  - GitHub's own budget emails come at 90% and 100% only and are "not consistently available" for personal accounts, by its own docs; this adds 80%, the early warning and webhooks, in one place.

### Should have

- Nothing beyond the must-haves for v0.1.

### Out of scope (v0.1)

- Stopping or throttling anything automatically. It alerts; you decide. (Possible later: optionally switch a route off.)
- Products not listed above (Queues, Pages builds, Images, Stream, Vectorize, Hyperdrive). Easy to add as limits later.
- Several Cloudflare accounts from one deployment.

## Technical design

### Pieces

```
Cron (hourly) ──▶ Worker ──GraphQL (Account Analytics: Read token)──▶ api.cloudflare.com
                    │
                    ├──▶ D1: usage samples, alert log, dataset status
                    ├──▶ send_email binding ──▶ your verified address
                    └──▶ webhook (Discord / Slack / ntfy / plain JSON)
```

### Reading usage

One GraphQL query per check, covering every product, for the current period:

- Workers: `workersInvocationsAdaptive` → `sum.requests`, from 00:00 UTC (filter `datetime_geq`).
- KV: `kvOperationsAdaptiveGroups` → `sum.requests` by `actionType`; `kvStorageAdaptiveGroups` → `max.byteCount`.
- D1: `d1AnalyticsAdaptiveGroups` → `sum.rowsRead`, `sum.rowsWritten`; `d1StorageAdaptiveGroups` → `databaseSizeBytes`.
- Durable Objects: `durableObjectsInvocationsAdaptiveGroups` → `sum.requests`; `durableObjectsPeriodicGroups` → duration; `durableObjectsStorageGroups` → `max.storedBytes`.
- R2 and Workers AI: dataset names to be confirmed against the live schema during the build. The documentation pages for them weren't found. Each is an optional block, so a wrong guess shows up as "can't read" rather than breaking the others.

Each product's block is queried separately in the same request with GraphQL aliases. A failing block (`errors[].path`) marks that product unreadable for this check; the rest still count.

**Accuracy:** Cloudflare says these analytics "should not be used as a measure for usage that Cloudflare uses for billing purposes" (billing leaves out some traffic, such as DDoS). So the guard can overcount slightly, which errs on the safe side for warnings. The README says so.

### Periods

- Daily limits: 00:00–24:00 UTC.
- Monthly (R2 on any plan; everything on Paid): calendar month, or from `BILLING_DAY` on Paid.
- Storage caps aren't periods: the latest value is compared with the cap, and an alert re-arms only after usage drops below the lower threshold again.

### Data model (D1)

- `samples`: `taken_at`, `limit_id`, `period_start`, `used`, `limit_value`. Kept for 35 days.
- `alerts`: `limit_id`, `period_start`, `kind` (`threshold:80`, `threshold:100`, `projected`), `sent_at`, `channels`, `error`. Unique on (`limit_id`, `period_start`, `kind`). That uniqueness is what makes "once per period" hold even if two checks overlap.
- `datasets`: `name`, `available`, `checked_at`, `last_error`.

### Config

`wrangler.jsonc` `vars`: `PLAN` (`free`|`paid`), `THRESHOLDS` (`"80,100"`), `BILLING_DAY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `WEBHOOK_FORMAT`, `DAILY_SUMMARY`, `LIMITS` (JSON overrides, e.g. `{"d1.rowsWritten": {"limit": 50000}, "kv.lists": false}`). Secrets: `CF_API_TOKEN`, `CF_ACCOUNT_ID` (a var), `STATUS_PASSWORD`, `WEBHOOK_URL`, optional `GITHUB_TOKEN`.

### Edge cases

- **The first hour of a day:** too little data to project from; projections start after 3 hours, or after 20% of the limit is used, whichever comes first.
- **GraphQL down or the token revoked:** after 3 failed checks in a row, one "the guard can't read your usage" alert. A guard that silently stops working is worse than none.
- **The guard's own usage:** about 24 requests and about 1,500 D1 rows written a day (index writes included), under 2% of any limit.
- **Two checks at once** (a manual run during the cron): the `alerts` uniqueness stops double emails.
- **Email not set up:** the test command and the status page say exactly what's missing (no verified address, `send_email` binding missing, sender not on a routing domain).

## Testing

- Unit tests: period maths (UTC days, billing-day months), threshold and once-per-period logic, projection, the overrides parser, and the GraphQL response parsing against recorded sample responses (missing blocks, errors, empty data).
- Integration tests with `@cloudflare/vitest-plugin`: a full check with a fake GraphQL endpoint and a fake `send_email`, the alert log, re-arming, the status page auth, and the test-alert route.
- **With your real account (free):** create an `Account Analytics: Read` token, run `wrangler dev`, and hit the check route. That confirms the real dataset and field names (including R2 and Workers AI) before release. It needs the token from you.
- **Not tested:** Workers Paid billing-day behaviour against a real Paid account (it costs $5 a month), and GitHub billing for organisations.

## Open questions (resolved 2026-11-10 by the live check)

- All datasets and fields, including R2's (`r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`), Workers AI's (`aiInferenceAdaptiveGroups.totalNeurons`) and Durable Objects duration (`durableObjectsPeriodicGroups.activeTime`), exist in the live schema.
- GitHub's usage report does list public-repo runner usage (with gross amounts); the guard leaves it out. SKUs are display names ("Actions Linux", "Actions storage"), not the docs' `actions_linux`; nothing depended on them.

## Open questions (original)

- The R2 and Workers AI dataset names. Resolved during the build by checking the live schema with your token.
- Whether GitHub's usage report lists public-repo runner usage at all (its docs don't say). It doesn't matter for correctness, since public items are filtered out either way, but it's worth seeing in your real data during the build.

## Acceptance criteria

- With fake usage at 79%, no alert; at 80%, one email; at 85%, nothing new; at 100%, one more; the next UTC day, it re-arms.
- At 10% used after 2 hours, on course for 120% by midnight, one projected-limit alert.
- A dataset that errors shows as "can't read" on the status page and in the summary, and never as 0%.
- `POST /api/test-alert` delivers through every configured channel or reports exactly why not.
- Three failed checks in a row send one "can't read your usage" alert.
- Runs on the Workers Free plan using under 2% of any limit (about 24 requests and about 1,500 D1 rows written a day; measured during the build, the 0.1% first estimated was too low).

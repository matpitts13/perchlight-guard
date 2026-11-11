# perchlight-guard

[![CI](https://github.com/matpitts13/perchlight-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/matpitts13/perchlight-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matpitts13/perchlight-guard)

**Know before you hit a limit.** A free, self-hosted Cloudflare Worker that checks your usage every hour and emails you at 80% and 100% of each Cloudflare free-plan limit, or of Workers Paid's included amounts, before overage starts. It also warns early when the current rate will reach a limit before it resets. Optionally it watches GitHub Actions' free allowance too.

On the free plan, going over a limit means errors until midnight UTC (Workers answer with error 1027; KV, D1, Durable Objects and Workers AI calls fail). On Paid it means a bill. Cloudflare's dashboard shows usage, but nothing warns you ahead of time.

Part of [Perchlight](https://github.com/matpitts13/perchlight), a free toolkit for running a product on Cloudflare.

## What it watches

| Product | Free plan limit | Resets |
|---|---|---|
| Workers | 100,000 requests | daily, 00:00 UTC |
| KV | 100,000 reads; 1,000 writes; 1,000 deletes; 1,000 lists; 1 GB stored | daily (storage: a cap) |
| D1 | 5 million rows read; 100,000 rows written; 5 GB stored | daily (storage: a cap) |
| Durable Objects | 100,000 requests; 13,000 GB-s; 5 GB stored | daily (storage: a cap) |
| R2 | 10 GB stored; 1 million Class A; 10 million Class B | monthly |
| Workers AI | 10,000 neurons | daily |
| GitHub Actions (optional) | $12 of compute; 500 MB of artifact storage | monthly |

Values are from Cloudflare's and GitHub's documentation on 2026-11-10. With `PLAN` set to `paid`, Workers Paid's monthly included amounts are used instead, from your `BILLING_DAY`. Every limit can be changed or turned off (see [Settings](#settings)).

**Accuracy:** Cloudflare says its analytics "should not be used as a measure for usage that Cloudflare uses for billing purposes". They can count slightly more than billing does (billing leaves out things like DDoS traffic), which makes warnings come slightly early. The guard checks hourly, though, so a limit that goes from under 80% to over 100% within one hour (a burst of KV writes, say) is only caught at 100%. Lower the thresholds for small limits you're close to.

## How it warns

- **Thresholds:** at 80% and at 100% by default. Each one is sent **once per period** per limit: for a daily limit, at most an early warning, the 80% one and the 100% one each day, never one an hour.
- **Early warning:** "At this rate it reaches the limit at about 18:40 UTC". Sent once per period, after 3 hours of a day (2 days of a month), or sooner once 20% is used.
- **Storage caps** warn when crossed, and warn again only after usage has dropped well below the threshold (under 70% for an 80% threshold) and risen again. A cap with nothing reported shows as "no data".
- **GitHub charges:** an alert as soon as GitHub starts billing you for Actions this month.
- **If it can't see:** a product it can't read shows as "can't read" with the reason, never as 0%. If Cloudflare or GitHub can't be read for 3 hourly checks in a row (a revoked or expired token, a wrong account id, an outage), you get a "can't read your usage" alert for that source. Checks you run by hand don't count toward this.
- **Channels:**
  - **email** to your own verified address (free through Email Routing)
  - **a webhook** for Discord, Slack, ntfy or plain JSON
- **Optionally a daily summary** of every limit.
- **A status page** at `/` behind a password.

Several limits crossing at once arrive as one message.

## What it costs

Nothing, on the free plan. It uses about 24 Worker requests a day (0.02% of the limit) and about 1,500 D1 rows written a day, counting index writes (about 1.5% of D1's free writes), one cron trigger (the free plan allows 5 per account), and two GraphQL calls an hour (a schema check and the usage query; about a dozen when something's wrong and it asks for each product separately). Email to your own verified address is free.

## Set up

### 1. Make a read-only API token

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → **Custom token**:
- Permissions: **Account** → **Account Analytics** → **Read**. Nothing else.
- Account resources: your account.

It can read usage numbers and nothing else; it can't change anything.

### 2. Email (recommended)

You need Email Routing on one of your domains (Cloudflare dashboard → your domain → **Email** → **Email Routing**), and your own address added under **Destination addresses** and verified. Alerts are sent from an address on that domain to that verified address.

### 3. Deploy

**One click:** click **Deploy to Cloudflare** above. Fill in `CF_API_TOKEN` and `STATUS_PASSWORD` when asked (leave `WEBHOOK_URL` and `GITHUB_TOKEN` empty unless you want them). Then, in your copy's `wrangler.jsonc`, set `CF_ACCOUNT_ID`, `ALERT_EMAIL_TO` and `ALERT_EMAIL_FROM`.

**By hand:**

```sh
git clone https://github.com/matpitts13/perchlight-guard
cd perchlight-guard
npm install
npx wrangler login
# edit wrangler.jsonc: CF_ACCOUNT_ID, ALERT_EMAIL_TO, ALERT_EMAIL_FROM
npm run deploy
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put STATUS_PASSWORD
```

### 4. Check it works

```sh
curl -X POST -u any:YOUR_STATUS_PASSWORD https://perchlight-guard.<you>.workers.dev/api/test-alert
curl -X POST -u any:YOUR_STATUS_PASSWORD https://perchlight-guard.<you>.workers.dev/api/check
```

The first sends a sample alert through every channel and says which worked. The second runs a check now and shows every limit. Then open the status page in a browser (any user name, your `STATUS_PASSWORD`).

## GitHub Actions (optional)

1. Create a **classic** personal access token (github.com/settings/tokens → **Generate new token (classic)**) with only the **`user`** scope. GitHub's billing usage API doesn't accept fine-grained tokens.
2. Set `GITHUB_USER` in `wrangler.jsonc`, and `npx wrangler secret put GITHUB_TOKEN`.

Only private repos count: standard GitHub-hosted runners are free in public repos, and don't use your allowance. The guard checks each repo's visibility once a day; anything it can't confirm is public counts, to be safe. GitHub's own emails come at 90% and 100% and, by GitHub's docs, aren't always available for personal accounts; this adds 80%, the early warning and webhooks. A **$0 Actions budget** (github.com/settings/billing) is still the real stop: this only warns.

## Settings

`vars` in `wrangler.jsonc`:

| Setting | Default | |
|---|---|---|
| `CF_ACCOUNT_ID` | | your account id (`npx wrangler whoami`) |
| `PLAN` | `free` | `free`, or `paid` for Workers Paid |
| `BILLING_DAY` | `1` | Paid: the day your billing renews |
| `THRESHOLDS` | `80,100` | percentages that send a warning |
| `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` | | your verified address; an address on your Email Routing domain |
| `WEBHOOK_FORMAT` | `json` | `discord`, `slack`, `ntfy` or `json` (with the `WEBHOOK_URL` secret) |
| `DAILY_SUMMARY`, `SUMMARY_HOUR` | `false`, `8` | one email a day with every limit, at this hour UTC |
| `GITHUB_USER`, `GITHUB_BILLING_DAY` | | GitHub Actions (with the `GITHUB_TOKEN` secret) |
| `LIMITS` | | JSON to change or turn off limits |

`LIMITS` example:

```json
{ "d1.rowsWritten": { "limit": 50000 }, "kv.lists": false, "workers.requests": { "thresholds": [50, 90] } }
```

Limit ids: `workers.requests`, `kv.reads`, `kv.writes`, `kv.deletes`, `kv.lists`, `kv.storage`, `d1.rowsRead`, `d1.rowsWritten`, `d1.storage`, `do.requests`, `do.duration`, `do.storage`, `r2.storage`, `r2.classA`, `r2.classB`, `ai.neurons`, `github.compute`, `github.storage`.

A bad setting never stops the guard: it uses the default for that one and lists the problem on the status page.

## Perchlight desktop app

[`perchlight/perchlight.json`](perchlight/perchlight.json) adds screens for usage history, alerts sent (with **Allow again**, to let an alert be sent again this period) and what the guard can read. Replace `YOUR-D1-DATABASE-ID` and import it.

## Tested, and not tested

- `npm test`: 41 tests, against a fake Cloudflare analytics API, a fake GitHub and a fake mail sender. They cover:
  - thresholds and once-per-period, including two checks at once
  - early warnings, storage caps re-arming (with hysteresis), "no data"
  - the 3-strikes "can't read" alert per source, including an expired GitHub token and HTTP 200 with errors
  - one product (or one source) failing without blinding the others
  - email that fails, then sends on a later check, and claims left by a check that died
  - webhooks, the daily summary, and GitHub's public and private repos and charges
  - the status page and its password
- **Before each release, against a real account (free):** the dataset and field names are checked against Cloudflare's live schema with a real token. Names Cloudflare doesn't document (R2, Workers AI, Durable Objects duration) are marked in [`src/lib/cloudflare.js`](src/lib/cloudflare.js).
- **Not tested, because it costs money:** the Workers Paid plan's billing-day behavior against a real Paid account ($5 a month), and GitHub organization billing.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare or GitHub.

# ADR 0001: What the guard can't read is "can't read", never zero

**Date:** 2026-11-10
**Status:** Accepted

## Context

The guard reads usage from Cloudflare's GraphQL Analytics API, whose dataset and field names aren't all documented (R2's and Workers AI's weren't found in the docs), and from GitHub's billing usage API. Any of these can fail: a renamed field, a token without the right permission, an outage. In GraphQL, one unknown field makes the whole query invalid. A usage alarm that quietly reads 0% when it can't see is worse than having none, because it tells you you're safe.

## Options considered

1. **One combined query; on any error, skip the check.** Pros: simplest. Cons: one bad field blinds every product, and a skipped check looks like a quiet one.
2. **One request per product, always.** Pros: perfect isolation. Cons: about 11 requests an hour instead of 1.
3. **One combined query, with a schema check first and per-product retries when the whole query is refused; every unread limit marked "unreadable" with the reason; 3 failed checks in a row send an alert.** Pros: one request in the normal case; isolation when something's wrong; the status page and summary always show what isn't being watched. Cons: more code paths to test.

## Decision

Option 3: it keeps the normal cost to one request and makes every failure visible.

## Consequences

- Positive: a missing or renamed dataset blinds only its own product, and says so.
- Positive: losing access entirely (revoked token, outage) is itself an alert, after 3 hours.
- Negative: a field name that's wrong from the start shows as "can't read" until fixed; the live check before each release is what catches those.
- Follow-up: if Cloudflare documents R2 and Workers AI datasets, update the blocks marked "unverified" in `src/lib/cloudflare.js`.

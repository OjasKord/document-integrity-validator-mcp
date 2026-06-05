# Changelog

## [1.0.7] - 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## [1.0.6] - 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

## [1.0.5] - 2026-06-04

### Added
- `src/services/redis.ts` — Upstash Redis helpers (redisGet, redisSet, redisExpire, redisKeys, appendSessionLog) with prefix `docintegrity`
- Free tier Redis persistence: `loadFreeTierFromRedis` / `saveFreeTierToRedis` with Math.max merge
- API key Redis persistence: `saveKeyToRedis` / `loadApiKeysFromRedis` — first durable persistence for paid keys
- `appendSessionLog` with 24h TTL; `/session-log` endpoint (requires x-stats-key)
- `free_tier_breakdown` per-IP object on `/stats` response for current month
- `getEffectiveLimit` (from check.ts) now used in `_upgrade_notice` warning string

### Changed
- `check_document` and `check_document_package` descriptions rewritten for orchestral agent runtime selection
- `VERSION` bumped to `1.0.5`

## [1.0.4] - 2026-06-02

### Fixed
- fix: IP extraction fixed for Cloudflare proxy headers — free tier gate now enforces correctly

## [1.0.3] - 2026-05-06

### Improved

- Add real Stripe payment URLs for Pro and Enterprise tiers.

## [1.0.2] - 2026-05-06

### Improved

- Remove redundant UNKNOWN_DOCUMENT_TYPE sentence from check_document description.

## [1.0.1] - 2026-05-06

### Improved

- Improve tool descriptions: add exclusivity framing to both check_document and check_document_package.

## [1.0.0] - 2026-05-06

### Initial release

- `check_document` tool: assesses any document against its known international standard. Free tier: 10 calls/month per IP.
- `check_document_package` tool: assesses 2-20 related documents individually and cross-checks for numeric, party, reference, date, commodity, and port conflicts. Paid tier only.
- Vision support: accepts base64 image or extracted text or both.
- UNKNOWN_DOCUMENT_TYPE verdict for unrecognised documents -- refusal is correct behaviour.
- Structured verdict with agent_action, assessed_against, known_issuing_standard, and specific flags.
- Trial extension endpoint: 10 extra free calls per email address via POST /trial-extension.
- Stripe webhook for automated API key provisioning.
- getEffectiveLimit() helper for accurate quota display after trial extension.
- Free tier warning at 8 calls used (2 remaining).
- checkAccess() runs only inside tools/call branch -- never on tools/list or initialize.


# Changelog

## [1.0.18] - 2026-06-23
- fix: gate returns HTTP 402 (x402 standard for non-transient quota)

## [1.0.17] - 2026-06-20
- feat: email notification on free tier gate hit

## [1.0.16] - 2026-06-18
- feat: revoke API key on Stripe refund

## [1.0.15] - 2026-06-17
- feat: add required fields to all tool inputSchemas; add ToolRank CI gate

## [1.0.14] - 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server
- fix: webhook route registered before express.json() — raw body now reaches signature verifier correctly

## [1.0.13] - 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

## [1.0.12] - 2026-06-15
- feat: add hold_reason, retry_after, escalation_path to FLAG verdict responses in check_document

## [1.0.11] - 2026-06-15
- feat: reposition tool descriptions for agentic payment rail discovery -- payment/fund-release trigger vocabulary with named document standards (ICAO 9303, Hague-Visby 1968, ICC UCP 600, ISPM 12)

## [1.0.10] - 2026-06-11
- fix: bump version past existing npm publish (1.0.9 already on registry)

## [1.0.9] - 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## [1.0.8] - 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

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


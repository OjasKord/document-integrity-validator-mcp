import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import axios from 'axios';

import {
  VERSION,
  PERSIST_FILE,
  LEGAL_DISCLAIMER,
  PRO_UPGRADE_URL,
  TRIAL_EXTENSION_CALLS,
  STATS_KEY,
  FREE_TIER_REDIS_KEY,
  FREE_TIER_LIMIT,
  ALLOWED_PAYMENT_LINK_IDS,
  FIRST_DEPLOYED,
  LIFETIME_CALLS_REDIS_KEY,
  UPTIME_HEARTBEAT_KEY,
  UPTIME_MONITORING_START_KEY,
  UPTIME_HEARTBEAT_INTERVAL_MS,
  nowISO
} from './constants.js';
import type { Stats, DependencyStatus, ServerCard, PaidKeyInfo } from './types.js';
import { REDIS_PREFIX, redisGet, redisSet, redisKeys, redisDelete, appendSessionLog, redisIncr, initUptimeTracking } from './services/redis.js';
import { CheckDocumentInputSchema, CheckDocumentOutputSchema } from './schemas/check.js';
import { CheckDocumentPackageInputSchema, CheckDocumentPackageOutputSchema } from './schemas/package-check.js';
import {
  runCheckDocument,
  getEffectiveLimit,
  verdictToAgentAction,
  checkFreeTierGate
} from './tools/check.js';
import { runCheckDocumentPackage, buildPackagePaidOnlyError } from './tools/package-check.js';

// ---------------------------------------------------------------------------
// Request context -- set per HTTP request; stdio uses defaults
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';
let currentOwnerKey = '';

const OWNER_KEY = process.env.OWNER_KEY ?? '';
const isOwner = (): boolean => OWNER_KEY !== '' && currentOwnerKey === OWNER_KEY;

const perMinuteUsage = new Map<string, number>();

function checkPerMinuteLimit(ip: string, toolName: string, limit: number): boolean {
  const minuteKey = ip + ':' + toolName + ':' + new Date().toISOString().slice(0, 16);
  const count = perMinuteUsage.get(minuteKey) ?? 0;
  if (count >= limit) return false;
  perMinuteUsage.set(minuteKey, count + 1);
  if (perMinuteUsage.size > 10000) {
    const currentMinute = new Date().toISOString().slice(0, 16);
    for (const [key] of perMinuteUsage) {
      if (!key.includes(currentMinute)) perMinuteUsage.delete(key);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stats persistence
// ---------------------------------------------------------------------------
function loadStats(): Stats {
  try {
    const parsed = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')) as Stats;
    if (!parsed.trial_extensions) parsed.trial_extensions = {};
    if (!parsed.paid_api_keys) parsed.paid_api_keys = {};
    return parsed;
  } catch {
    return {
      free_tier_calls_by_ip: {},
      paid_calls: 0,
      total_calls: 0,
      check_calls: 0,
      package_calls: 0,
      paid_api_keys: {},
      trial_extensions: {}
    };
  }
}

function saveStats(s: Stats): void {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify(s)); } catch { /* /tmp reset is expected */ }
}

let stats = loadStats();

function incrementFreeTier(ip: string): void {
  const month = new Date().toISOString().slice(0, 7);
  if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
  stats.free_tier_calls_by_ip[ip][month] =
    (stats.free_tier_calls_by_ip[ip][month] ?? 0) + 1;
  saveStats(stats);
  saveFreeTierToRedis().catch(() => {});
}

async function saveKeyToRedis(apiKey: string, record: PaidKeyInfo): Promise<void> {
  await redisSet(`${REDIS_PREFIX}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis(): Promise<void> {
  const keys = await redisKeys(`${REDIS_PREFIX}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${REDIS_PREFIX}:key:`, '');
      stats.paid_api_keys[apiKey] = record as PaidKeyInfo;
    }
  }
  console.error(`[docintegrity] Loaded ${Object.keys(stats.paid_api_keys).length} API keys from Redis`);
}

async function loadFreeTierFromRedis(): Promise<void> {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && typeof data === 'object') {
      Object.assign(stats.free_tier_calls_by_ip, data as Record<string, Record<string, number>>);
      console.error('[FreeTier] Loaded ' + Object.keys(stats.free_tier_calls_by_ip).length + ' IPs from Redis');
    }
  } catch (e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis(): Promise<void> {
  try {
    const existing = (await redisGet(FREE_TIER_REDIS_KEY) as Record<string, Record<string, number>> | null) ?? {};
    for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
      if (!existing[ip]) existing[ip] = {};
      for (const [month, count] of Object.entries(months)) {
        existing[ip][month] = Math.max(existing[ip][month] ?? 0, count);
      }
    }
    await redisSet(FREE_TIER_REDIS_KEY, existing);
  } catch (e) { console.error('[FreeTier] save failed:', e); }
}

function isPaidKey(key: string): boolean {
  return key.length > 0 && Object.prototype.hasOwnProperty.call(stats.paid_api_keys, key);
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: 'Kord Agencies <ojas@kordagencies.com>', to: [to], subject, html },
      { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
    );
  } catch { /* email failure is non-fatal */ }
}

function getStatsPayload(): Record<string, unknown> {
  const month = new Date().toISOString().slice(0, 7);
  let freeTierUnique = 0;
  let freeTierTotal = 0;
  const breakdown: Record<string, number> = {};
  for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
      breakdown[ip.slice(0, 10) + '...'] = months[month];
    }
  }
  return {
    total_calls: stats.total_calls,
    paid_calls: stats.paid_calls,
    free_calls: stats.total_calls - stats.paid_calls,
    check_calls: stats.check_calls,
    package_calls: stats.package_calls,
    free_tier_unique_ips: freeTierUnique,
    free_tier_total_calls: freeTierTotal,
    free_tier_breakdown: breakdown,
    paid_api_keys_count: Object.keys(stats.paid_api_keys).length,
    trial_extensions_granted: Object.keys(stats.trial_extensions).length,
    checked_at: nowISO()
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
function verifyStripeSignature(body: string, sig: string, secret: string): boolean {
  if (!secret || !sig) return false;
  try {
    const parts = sig.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=');
      if (k && v) acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const computed = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch { return false; }
}

function generateApiKey(): string {
  return `div_${crypto.randomBytes(24).toString('hex')}`;
}

async function findCheckoutSessionEmail(paymentIntentId: string): Promise<string | undefined> {
  const res = await axios.get('https://api.stripe.com/v1/checkout/sessions', {
    params: { payment_intent: paymentIntentId },
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const session = res.data?.data?.[0];
  return session?.customer_details?.email ?? session?.customer_email ?? undefined;
}

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] === 'charge.refunded') {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('[docintegrity] STRIPE_SECRET_KEY not set — cannot revoke key on refund');
      return;
    }
    const charge = (event['data'] as Record<string, unknown> | undefined)?.['object'] as Record<string, unknown> | undefined;
    const paymentIntentId = charge?.['payment_intent'] as string | undefined;
    if (!paymentIntentId) {
      console.error('[docintegrity] charge.refunded missing payment_intent — ignoring.');
      return;
    }
    try {
      const email = await findCheckoutSessionEmail(paymentIntentId);
      if (!email) {
        console.error('[docintegrity] No checkout session/email found for refunded payment_intent ' + paymentIntentId);
        return;
      }
      const revokedKey = Object.keys(stats.paid_api_keys).find(k => stats.paid_api_keys[k]?.email === email);
      if (!revokedKey) {
        console.error('[docintegrity] No API key found for ' + email + ' — refund received, nothing to revoke');
        return;
      }
      delete stats.paid_api_keys[revokedKey];
      await redisDelete(`${REDIS_PREFIX}:key:${revokedKey}`);
      saveStats(stats);
      console.error('[Webhook] API key revoked for ' + email + ' — refund received');
    } catch (err) {
      console.error('[docintegrity] charge.refunded handling error:', err);
    }
    return;
  }

  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
  const paymentLinkId = obj?.['payment_link'] as string | undefined;
  if (paymentLinkId && !ALLOWED_PAYMENT_LINK_IDS.includes(paymentLinkId)) {
    console.error('[stripe] Webhook received but payment link ' + paymentLinkId + ' not for this server — ignoring.');
    return;
  }
  const email = (obj?.['customer_email'] as string | undefined) ?? 'unknown';
  const plan = ((obj?.['metadata'] as Record<string, string> | undefined)?.['plan']) ?? 'pro';

  const apiKey = generateApiKey();
  const record: PaidKeyInfo = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
  stats.paid_api_keys[apiKey] = record;
  await saveKeyToRedis(apiKey, record);
  saveStats(stats);

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && email !== 'unknown') {
    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: 'Kord Agencies <ojas@kordagencies.com>',
          to: [email],
          subject: 'Your Document Integrity Validator API Key',
          text:
            `Thank you for upgrading to Document Integrity Validator ${plan === 'enterprise' ? 'Enterprise' : 'Pro'}.\n\n` +
            `Your API key: ${apiKey}\n\n` +
            `Add this as the x-api-key header in your MCP client configuration.\n\n` +
            `Access includes:\n` +
            `- Unlimited check_document calls\n` +
            `- Full check_document_package for cross-document consistency checking\n\n` +
            `Docs and integration guide: kordagencies.com\n\n` +
            `Kord Agencies Pte Ltd`
        },
        { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
      );
    } catch { /* email failure is non-fatal */ }
  }

  console.error(`[stripe] New ${plan} key provisioned for ${email}`);
}

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------
function validateEnv(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY');
  }
}

// ---------------------------------------------------------------------------
// Dependencies check
// ---------------------------------------------------------------------------
async function checkDependencies(): Promise<DependencyStatus[]> {
  const anthropicOk = Boolean(process.env.ANTHROPIC_API_KEY);
  return [
    {
      name: 'Anthropic API (claude-sonnet-4-6)',
      ok: anthropicOk,
      detail: anthropicOk ? undefined : 'ANTHROPIC_API_KEY not set'
    }
  ];
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------
const CHECK_DOCUMENT_DESCRIPTION =
  'Validates a document for internal consistency and completeness against the applicable international standard for its type. ' +
  'Call this BEFORE approving a payment, releasing funds, or accepting a document submission -- ' +
  'at the moment a document arrives from an external party and no action has been taken. ' +
  'Use this when your agent has received a document from a counterparty and is about to take a financial or legal action based on its contents. ' +
  'Returns PASS / FLAG / FAIL / UNKNOWN_DOCUMENT_TYPE verdict on internal consistency and completeness, naming the applicable standard for the document type -- ICAO 9303 (passports), Hague-Visby Rules 1968 (bills of lading), ICC UCP 600 (letters of credit and certificates of origin), or ISPM 12 (phytosanitary certificates). ' +
  'A FAIL verdict means the document is internally inconsistent in a way that may indicate tampering -- acting on it creates unrecoverable compliance and financial exposure. ' +
  'Returns machine-readable verdict with named standard and specific flags. ' +
  'When you have 2-20 related documents (e.g. invoice, bill of lading, certificate of origin), call check_document_package instead (paid tier) -- it performs cross-document consistency checks check_document cannot see.';

const CHECK_DOCUMENT_PACKAGE_DESCRIPTION =
  'Validates a package of 2-20 related trade finance documents for cross-document consistency. ' +
  'Call this BEFORE approving any multi-document trade finance transaction or cross-border shipment -- ' +
  'at the moment a set of 2-20 related documents arrives from an external party and funds have not been released. ' +
  'Use this when your agent has received a full trade finance package — such as invoice, bill of lading, and certificate of origin together — and must verify all documents are consistent with each other before releasing funds. ' +
  'Returns PASS/FLAG/FAIL verdict per document with mismatch details. ' +
  'Cross-checks all documents for consistency across numeric values, party names, reference numbers, dates, and commodity descriptions. ' +
  'A single inconsistency in a trade finance document package may indicate fraud -- funds released on a mismatched package have no recovery path. ' +
  'Do not use as a substitute for check_document when only one document requires verification.';

const INITIALIZE_DESCRIPTION =
  'Every trade finance and agentic procurement workflow has a moment where the agent must act on a received document before it can proceed. ' +
  'This server answers that question in one call -- returning a machine-readable PASS / FLAG / FAIL verdict against named international document standards. ' +
  'Used before any payment, fund release, or document submission.';

// ---------------------------------------------------------------------------
// Server card (Smithery required format)
// ---------------------------------------------------------------------------
function getServerCard(): ServerCard {
  return {
    serverInfo: { name: 'document-integrity-validator-mcp', version: VERSION },
    authentication: { required: false },
    tools: [
      {
        name: 'check_document',
        description: CHECK_DOCUMENT_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            document_text: {
              type: 'string',
              maxLength: 50000,
              description: 'Extracted text content from the document.'
            },
            document_image: {
              type: 'string',
              maxLength: 10000000,
              description: 'Base64 encoded document image. Accepts raw base64 or data URL.'
            },
            document_type_hint: {
              type: 'string',
              maxLength: 200,
              description: 'Agent belief about document type, e.g. "bill_of_lading".'
            },
            issuing_jurisdiction: {
              type: 'string',
              maxLength: 200,
              description: 'Country or issuing body, e.g. "Singapore".'
            }
          },
          required: [],
          additionalProperties: false
        }
      },
      {
        name: 'check_document_package',
        description: CHECK_DOCUMENT_PACKAGE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            documents: {
              type: 'array',
              minItems: 2,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  document_text: { type: 'string', maxLength: 50000 },
                  document_image: { type: 'string', maxLength: 10000000 },
                  document_type_hint: { type: 'string', maxLength: 200 },
                  issuing_jurisdiction: { type: 'string', maxLength: 200 },
                  label: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 100,
                    description: 'Agent-assigned label, e.g. "packing_list"'
                  }
                },
                required: ['label'],
                additionalProperties: false
              },
              description: 'Array of 2 to 20 related documents to assess and cross-check.'
            }
          },
          required: ['documents'],
          additionalProperties: false
        }
      }
    ],
    resources: [],
    prompts: []
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'document-integrity-validator-mcp',
  version: VERSION,
  description: INITIALIZE_DESCRIPTION
});

// Tool 1: check_document (free: 10/month per IP)
server.registerTool(
  'check_document',
  {
    title: 'Check Document Integrity',
    description: CHECK_DOCUMENT_DESCRIPTION,
    inputSchema: CheckDocumentInputSchema,
    outputSchema: CheckDocumentOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    // checkAccess() runs ONLY here -- inside the tools/call branch
    const ip = currentIP;
    if (process.env['TOOL_DISABLED_CHECK_DOCUMENT'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(ip, 'check_document', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    stats.total_calls++;
    stats.check_calls++;
    if (paid) {
      stats.paid_calls++;
      if (stats.paid_api_keys[currentApiKey]) {
        stats.paid_api_keys[currentApiKey].calls++;
        stats.paid_api_keys[currentApiKey].last_seen = nowISO();
      }
    }

    const result = await runCheckDocument(params, ip, paid, stats);

    if (result.error) {
      saveStats(stats);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    if (!paid) {
      incrementFreeTier(ip); // saves stats + Redis internally
    } else {
      saveStats(stats);
    }
    redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
    appendSessionLog(ip, 'check_document').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

    const output = result.output!;
    if (output._upgrade_notice && !paid) {
      const effectiveLimit = getEffectiveLimit(ip, stats);
      if (!output._upgrade_notice.includes('limit:')) {
        output._upgrade_notice = output._upgrade_notice.replace(
          'this month.',
          `this month (limit: ${effectiveLimit}).`
        );
      }
    }

    const text = JSON.stringify(output, null, 2);
    const finalText =
      text.length > 25000
        ? text.slice(0, 25000) + '\n\n[Response truncated.]'
        : text;

    return {
      content: [{ type: 'text' as const, text: finalText }],
      structuredContent: output as unknown as Record<string, unknown>
    };
  }
);

// Tool 2: check_document_package (paid only -- no free tier)
server.registerTool(
  'check_document_package',
  {
    title: 'Check Document Package Integrity',
    description: CHECK_DOCUMENT_PACKAGE_DESCRIPTION,
    inputSchema: CheckDocumentPackageInputSchema,
    outputSchema: CheckDocumentPackageOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    // checkAccess() runs ONLY here -- inside the tools/call branch
    if (process.env['TOOL_DISABLED_CHECK_DOCUMENT_PACKAGE'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(currentIP, 'check_document_package', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    if (!paid) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await buildPackagePaidOnlyError(currentIP))
          }
        ]
      };
    }

    stats.total_calls++;
    stats.package_calls++;
    stats.paid_calls++;
    if (stats.paid_api_keys[currentApiKey]) {
      stats.paid_api_keys[currentApiKey].calls++;
      stats.paid_api_keys[currentApiKey].last_seen = nowISO();
    }

    const result = await runCheckDocumentPackage(params);

    if (result.error) {
      saveStats(stats);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    saveStats(stats);
    redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
    appendSessionLog(currentIP, 'check_document_package').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

    const output = result.output!;
    const text = JSON.stringify(output, null, 2);
    const finalText =
      text.length > 25000
        ? text.slice(0, 25000) + '\n\n[Response truncated.]'
        : text;

    return {
      content: [{ type: 'text' as const, text: finalText }],
      structuredContent: output as unknown as Record<string, unknown>
    };
  }
);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
async function runHTTP(): Promise<void> {
  validateEnv();

  const app = express();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key, x-owner-key'
  };

  // Webhook must be registered before express.json() to receive raw body for signature verification
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const sig = req.headers['stripe-signature'] as string;
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
      if (!verifyStripeSignature(req.body.toString(), sig, secret)) {
        res.status(400).set(cors).json({ error: 'Invalid signature' });
        return;
      }
      handleStripeEvent(JSON.parse(req.body.toString()) as Record<string, unknown>).catch(err =>
        console.error('[stripe] handler error:', err)
      );
      res.set(cors).json({ received: true });
    }
  );

  app.use(express.json());

  app.options('*', (_req, res) => { res.status(200).set(cors).end(); });

  app.all('/health', (_req, res) => {
    res.set(cors).json({ status: 'ok', version: VERSION, service: 'document-integrity-validator-mcp' });
  });

  app.all('/ready', (_req, res) => {
    const ok = Boolean(process.env.ANTHROPIC_API_KEY);
    res.status(ok ? 200 : 503).set(cors).json({
      status: ok ? 'ready' : 'not_ready',
      version: VERSION,
      checks: { anthropic_api: ok }
    });
  });

  app.get('/deps', async (_req, res) => {
    const deps = await checkDependencies();
    res.set(cors).json({ checked_at: nowISO(), dependencies: deps });
  });

  app.get('/stats', (req, res) => {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    res.set(cors).json(getStatsPayload());
  });

  // Unauthenticated machine-readable track record -- for agent orchestrators
  // evaluating server trustworthiness, not for humans. No stats-key required.
  app.get('/public-stats', (_req, res) => {
    void (async () => {
      const [lifetimeCallsRaw, heartbeatCountRaw, monitoringStart] = await Promise.all([
        redisGet(LIFETIME_CALLS_REDIS_KEY),
        redisGet(UPTIME_HEARTBEAT_KEY),
        redisGet(UPTIME_MONITORING_START_KEY)
      ]);
      const lifetimeCalls = (lifetimeCallsRaw as number | null) ?? 0;
      const heartbeatCount = (heartbeatCountRaw as number | null) ?? 0;
      const monitoringStartTime = monitoringStart ? new Date(monitoringStart as string).getTime() : Date.now();
      const elapsedMs = Math.max(1, Date.now() - monitoringStartTime);
      const uptimePct = Math.min(100, Math.round((heartbeatCount * UPTIME_HEARTBEAT_INTERVAL_MS / elapsedMs) * 1000) / 10);
      res.set(cors).json({
        server: 'document-integrity-validator-mcp',
        version: VERSION,
        first_deployed: FIRST_DEPLOYED,
        total_lifetime_tool_calls: lifetimeCalls,
        uptime_percentage: uptimePct,
        uptime_monitoring_since: monitoringStart ?? nowISO()
      });
    })();
  });

  app.get('/session-log', (req, res) => {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions: Array<Record<string, unknown>> = [];
      for (const key of keys) {
        const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp ?? '', last_call: calls[calls.length - 1]?.timestamp ?? '' });
      }
      sessions.sort((a, b) => String(b.first_call).localeCompare(String(a.first_call)));
      res.set(cors).json(sessions);
    })();
  });

  app.get('/.well-known/mcp/server-card.json', (_req, res) => {
    res.set(cors).json(getServerCard());
  });

  app.get('/.well-known/glama.json', (_req, res) => {
    res.set(cors).json({ "$schema": "https://glama.ai/mcp/schemas/connector.json", "maintainers": [{ "email": "ojas@kordagencies.com" }] });
  });

  // Trial extension endpoint -- follows VAT Validator pattern exactly
  app.post('/trial-extension', async (req, res) => {
    const { name, email, use_case } = req.body as {
      name?: string;
      email?: string;
      use_case?: string;
    };

    if (!name || !email) {
      res.status(400).set(cors).json({
        error: 'name and email are required',
        agent_action: 'PROVIDE_REQUIRED_FIELDS'
      });
      return;
    }

    const emailKey = 'trial:' + email.toLowerCase().trim();
    if (stats.trial_extensions[emailKey]) {
      res.status(409).set(cors).json({
        error: 'Trial extension already granted for this email.',
        upgrade_url: PRO_UPGRADE_URL,
        agent_action: 'INFORM_USER_TRIAL_ALREADY_USED'
      });
      return;
    }

    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';

    const month = new Date().toISOString().slice(0, 7);
    if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
    const currentCalls = stats.free_tier_calls_by_ip[ip][month] ?? 0;
    stats.free_tier_calls_by_ip[ip][month] = Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS);
    stats.trial_extensions[emailKey] = {
      name,
      email,
      use_case: use_case ?? '',
      ip,
      granted_at: nowISO()
    };
    saveStats(stats);
    await redisSet(REDIS_PREFIX + ':trial:' + email.toLowerCase().trim(), { name, email, use_case: use_case ?? '', ip, timestamp: nowISO(), server: 'document-integrity-validator-mcp' });

    // 24h follow-up record -- processed by /process-trial-followups (fleet cron)
    await redisSet(REDIS_PREFIX + ':followup:' + email.toLowerCase().trim(), { email, name, server: 'document-integrity-validator-mcp', granted_at: nowISO(), sent: false });

    await sendEmail(
      'ojas@kordagencies.com',
      'Document Integrity Validator -- Trial Extension: ' + name,
      '<p><b>Name:</b> ' + name +
        '<br><b>Email:</b> ' + email +
        '<br><b>Use case:</b> ' + (use_case ?? 'Not provided') +
        '<br><b>IP:</b> ' + ip +
        '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>'
    );

    await sendEmail(
      email,
      TRIAL_EXTENSION_CALLS + ' extra free calls added -- Document Integrity Validator MCP',
      '<p>Hi ' + name + ',</p>' +
        '<p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. ' +
        'You can keep using Document Integrity Validator MCP right now -- no action needed.</p>' +
        '<p>When you need more, Pro is $29/month for 500 calls: ' + PRO_UPGRADE_URL + '</p>' +
        '<p>Ojas<br>kordagencies.com</p>'
    );

    res.set(cors).json({
      granted: true,
      additional_calls: TRIAL_EXTENSION_CALLS,
      message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.',
      upgrade_url: PRO_UPGRADE_URL
    });
  });

  // Fleet cron hits this hourly. Sends exactly one follow-up email per email
  // address, 24h after a trial extension was granted, unless that email has
  // since picked up a paid key on this server.
  app.post('/process-trial-followups', (req, res) => {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(REDIS_PREFIX + ':followup:*');
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      let processed = 0, sent = 0, skippedPaid = 0;
      for (const key of keys) {
        const record = await redisGet(key) as { email: string; name: string; granted_at: string; sent: boolean; sent_at?: string } | null;
        if (!record || record.sent) continue;
        if (Date.now() - new Date(record.granted_at).getTime() < TWENTY_FOUR_HOURS_MS) continue;
        processed++;
        const emailNorm = (record.email || '').toLowerCase().trim();
        const hasPaidKey = Object.values(stats.paid_api_keys).some(r => (r.email || '').toLowerCase().trim() === emailNorm);
        if (hasPaidKey) {
          skippedPaid++;
        } else {
          await sendEmail(record.email, 'Document Integrity Validator MCP -- document verification will block your workflow again without an upgrade',
            '<p>Hi ' + record.name + ',</p><p>Your trial extension on Document Integrity Validator MCP was granted 24 hours ago. Once those extra calls run out, document verification stops and any payment or fund-release workflow that depends on it pauses until you upgrade.</p><p>Upgrade now -- $29/month for 500 calls: ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>');
          sent++;
        }
        record.sent = true;
        record.sent_at = nowISO();
        await redisSet(key, record);
      }
      res.set(cors).json({ checked: keys.length, processed, emails_sent: sent, skipped_already_paid: skippedPaid });
    })();
  });

  // Daily report -- JSON only, for Bizfile aggregation
  app.post('/daily-report', async (req, res) => {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const cutoffMs = Date.now() - 86400000;
    const month = new Date().toISOString().slice(0, 7);

    let limitHits = 0;
    for (const months of Object.values(stats.free_tier_calls_by_ip)) {
      if ((months[month] ?? 0) >= FREE_TIER_LIMIT) limitHits++;
    }

    let trialCount = 0;
    for (const record of Object.values(stats.trial_extensions)) {
      if (record.granted_at && record.granted_at >= since24h) trialCount++;
    }

    let paidCount = 0;
    for (const record of Object.values(stats.paid_api_keys)) {
      const ts = record.created_at ? new Date(record.created_at).getTime() : 0;
      if (ts >= cutoffMs) paidCount++;
    }

    const sessionKeys = await redisKeys(`${REDIS_PREFIX}:session:*:${today}`);
    const toolBreakdown: Record<string, number> = {};
    let calls24h = 0;
    for (const key of sessionKeys) {
      const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
      calls.forEach(c => { if (c.tool) { toolBreakdown[c.tool] = (toolBreakdown[c.tool] ?? 0) + 1; calls24h++; } });
    }
    const unique24h = sessionKeys.length;

    res.set(cors).json({
      server: 'document-integrity-validator-mcp',
      date: today,
      calls_24h: calls24h,
      unique_ips_24h: unique24h,
      limit_hits: limitHits,
      trial_extensions: trialCount,
      paid_conversions: paidCount,
      tool_breakdown: toolBreakdown
    });
  });

  // MCP endpoint -- new transport per request (stateless, prevents request ID collisions)
  app.post('/mcp', async (req, res) => {
    currentIP =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      '127.0.0.1';
    currentApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
    currentOwnerKey = (req.headers['x-owner-key'] as string | undefined) ?? '';

    const isToolDisabled = process.env['TOOL_DISABLED_CHECK_DOCUMENT'] === 'true';
    if (!isToolDisabled && req.body?.method === 'tools/call' && req.body?.params?.name === 'check_document') {
      const gateError = await checkFreeTierGate(currentIP, isPaidKey(currentApiKey) || isOwner(), stats);
      if (gateError) {
        res.status(402).set(cors).json({
          jsonrpc: '2.0',
          id: req.body.id,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify(gateError) }] }
        });
        return;
      }
    }

    res.set(cors);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => { transport.close().catch(() => { /* ignore */ }); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () => {
    void (async () => {
      await loadApiKeysFromRedis();
      await loadFreeTierFromRedis();
      await initUptimeTracking(UPTIME_HEARTBEAT_KEY, UPTIME_MONITORING_START_KEY, UPTIME_HEARTBEAT_INTERVAL_MS);
      console.error(`document-integrity-validator-mcp running on http://localhost:${port}/mcp`);
    })();
  });
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  validateEnv();
  currentApiKey = process.env.API_KEY ?? '';
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('document-integrity-validator-mcp running via stdio');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const transportMode = process.env.TRANSPORT ?? 'http';
if (transportMode === 'stdio') {
  runStdio().catch(err => { console.error(err); process.exit(1); });
} else {
  runHTTP().catch(err => { console.error(err); process.exit(1); });
}

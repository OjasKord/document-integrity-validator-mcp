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
  nowISO
} from './constants.js';
import type { Stats, DependencyStatus, ServerCard } from './types.js';
import { CheckDocumentInputSchema } from './schemas/check.js';
import { CheckDocumentPackageInputSchema } from './schemas/package-check.js';
import {
  runCheckDocument,
  getEffectiveLimit,
  verdictToAgentAction
} from './tools/check.js';
import { runCheckDocumentPackage, buildPackagePaidOnlyError } from './tools/package-check.js';

// ---------------------------------------------------------------------------
// Request context -- set per HTTP request; stdio uses defaults
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';

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
  for (const months of Object.values(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
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

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
  const email = (obj?.['customer_email'] as string | undefined) ?? 'unknown';
  const plan = ((obj?.['metadata'] as Record<string, string> | undefined)?.['plan']) ?? 'pro';

  const apiKey = generateApiKey();
  stats.paid_api_keys[apiKey] = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
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
  'Call this tool BEFORE your agent accepts, processes, or acts on any document received from an external party -- ' +
  'before payment release, cargo acceptance, contract execution, or KYC sign-off. ' +
  'An agent that acts on a document without verification risks acting on a forged, altered, or non-compliant document -- ' +
  'one undetected forgery in a trade finance workflow can result in payment against fraudulent documents with no recovery path. ' +
  'Accepts any document type as base64 image or extracted text. ' +
  'Identifies the document type independently, then assesses it against the known international standard for that type -- ' +
  'ICAO 9303 for passports, Hague-Visby Rules for bills of lading, UCP 600 for trade documents, ISPM 12 for phytosanitary certificates, and more. ' +
  'Returns UNKNOWN_DOCUMENT_TYPE rather than guessing on unfamiliar documents -- refusal is correct behaviour, not a failure. ' +
  'Returns a machine-readable agent_action field (PROCEED / VERIFY_MANUALLY / HOLD / REFER_TO_HUMAN) -- no further analysis needed. ' +
  'AI-powered reasoning -- NOT a database lookup. We do not log or store your document content. ' +
  'One call replaces manual review for standard document types. ' +
  'Free tier: 10 calls/month per IP, no API key required. ' +
  'Pro: 500 calls/month at $29/month. Enterprise: 5,000 calls/month at $199/month. kordagencies.com';

const CHECK_DOCUMENT_PACKAGE_DESCRIPTION =
  'Call this tool when your agent has received a set of related documents that must be internally consistent before payment release, cargo acceptance, or contract execution. ' +
  'A single undetected inconsistency across a trade document package -- mismatched weights, different consignee names, conflicting reference numbers -- ' +
  'triggers a Letter of Credit discrepancy that blocks payment and may constitute documentary fraud. ' +
  'Submits 2 to 20 documents in one call. Returns individual verdicts per document plus cross-document conflict flags covering: ' +
  'numeric values (weights, quantities, amounts), party names (shipper, consignee, buyer, seller), reference numbers (LC number, booking ref), ' +
  'dates (shipment date, expiry, presentation period), commodity descriptions, and port references. ' +
  'One call replaces manual cross-checking across the full document package. ' +
  'AI-powered reasoning -- NOT a database lookup. We do not log or store your document content. ' +
  'Paid tier only -- no free access. Pro: 500 calls/month at $29/month. Enterprise: 5,000 calls/month at $199/month. kordagencies.com.';

const INITIALIZE_DESCRIPTION =
  'Before your agent accepts, processes, or acts on any document received from an external party -- ' +
  'verify it is internally consistent and matches the known standard for its type. ' +
  'One call. Any document. Machine-readable verdict.';

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
    const paid = isPaidKey(currentApiKey);

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

    if (!paid) incrementFreeTier(ip);
    saveStats(stats);

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

// Tool 2: check_document_package (paid only -- no free tier)
server.registerTool(
  'check_document_package',
  {
    title: 'Check Document Package Integrity',
    description: CHECK_DOCUMENT_PACKAGE_DESCRIPTION,
    inputSchema: CheckDocumentPackageInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    // checkAccess() runs ONLY here -- inside the tools/call branch
    const paid = isPaidKey(currentApiKey);

    if (!paid) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(buildPackagePaidOnlyError())
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
  app.use(express.json());

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key'
  };

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

  app.get('/.well-known/mcp/server-card.json', (_req, res) => {
    res.set(cors).json(getServerCard());
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

  // MCP endpoint -- new transport per request (stateless, prevents request ID collisions)
  app.post('/mcp', async (req, res) => {
    currentIP =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      '127.0.0.1';
    currentApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';

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
    console.error(`document-integrity-validator-mcp running on http://localhost:${port}/mcp`);
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

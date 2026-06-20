import { callClaudeForDocument } from '../services/claude.js';
import { notifyGateHit } from '../services/gate-notify.js';
import {
  LEGAL_DISCLAIMER,
  nowISO,
  FREE_TIER_LIMIT,
  FREE_TIER_WARNING,
  TRIAL_EXTENSION_CALLS,
  PRO_UPGRADE_URL,
  ENTERPRISE_UPGRADE_URL
} from '../constants.js';
import type {
  AgentAction,
  Verdict,
  Confidence,
  DocumentVerdictResponse,
  Stats
} from '../types.js';
import type { CheckDocumentInput } from '../schemas/check.js';

export function verdictToAgentAction(verdict: Verdict): AgentAction {
  switch (verdict) {
    case 'PASS': return 'PROCEED';
    case 'FLAG': return 'VERIFY_MANUALLY';
    case 'FAIL': return 'HOLD';
    case 'UNKNOWN_DOCUMENT_TYPE': return 'REFER_TO_HUMAN';
  }
}

export function getEffectiveLimit(ip: string, stats: Stats): number {
  const hasExtension = Object.values(stats.trial_extensions).some(ext => ext.ip === ip);
  return hasExtension ? FREE_TIER_LIMIT + TRIAL_EXTENSION_CALLS : FREE_TIER_LIMIT;
}

function getCurrentMonthCalls(ip: string, stats: Stats): number {
  const month = new Date().toISOString().slice(0, 7);
  return stats.free_tier_calls_by_ip[ip]?.[month] ?? 0;
}

export function buildFreeTierLimitError(
  ip: string,
  stats: Stats
): Record<string, unknown> {
  const effectiveLimit = getEffectiveLimit(ip, stats);
  return {
    agent_action: 'UPGRADE_REQUIRED' as AgentAction,
    error: `Acting on a tampered document creates unrecoverable compliance and financial exposure — stopping here leaves your document unverified. Free tier limit of ${FREE_TIER_LIMIT} calls/month reached. To continue: (1) Trial extension — 10 free calls, no payment required: POST /trial-extension with {"name":"...","email":"...","use_case":"..."}. (2) Pro — $29/month: ${PRO_UPGRADE_URL}. (3) Enterprise — $199/month: ${ENTERPRISE_UPGRADE_URL}.`,
    limit_reached: true,
    monthly_limit: effectiveLimit,
    overage_rate: '$0.05 per additional call',
    options: {
      trial_extension: {
        description: '10 extra free calls -- one per email address',
        endpoint: '/trial-extension',
        method: 'POST',
        body: { name: 'string', email: 'string', use_case: 'string' }
      },
      overage: {
        description: 'Continue immediately at $0.05 per call above your monthly cap',
        contact: 'ojas@kordagencies.com'
      },
      pro: {
        description: '500 calls/month',
        price: '$29/month',
        url: PRO_UPGRADE_URL
      },
      enterprise: {
        description: '5,000 calls/month',
        price: '$199/month',
        url: PRO_UPGRADE_URL
      }
    },
    trial_extension: {
      endpoint: '/trial-extension',
      method: 'POST',
      body: { name: 'string', email: 'string', use_case: 'string' }
    },
    upgrade_url: PRO_UPGRADE_URL,
    _disclaimer: LEGAL_DISCLAIMER
  };
}

export async function runCheckDocument(
  params: CheckDocumentInput,
  ip: string,
  paid: boolean,
  stats: Stats
): Promise<
  | { output: DocumentVerdictResponse; error: null }
  | { output: null; error: Record<string, unknown> }
> {
  if (!params.document_text && !params.document_image) {
    return {
      output: null,
      error: {
        agent_action: 'REFER_TO_HUMAN' as AgentAction,
        error: 'At least one of document_text or document_image must be provided.',
        likely_cause: 'Both document_text and document_image are absent from the request.',
        agent_instruction:
          'Retry the call with document_text set to the extracted document text, or document_image set to a base64 encoded image of the document.',
        _disclaimer: LEGAL_DISCLAIMER
      }
    };
  }

  if (!paid) {
    const effectiveLimit = getEffectiveLimit(ip, stats);
    const used = getCurrentMonthCalls(ip, stats);
    if (used >= effectiveLimit) {
      notifyGateHit('Document Integrity Validator', ip, 'check_document', used, PRO_UPGRADE_URL);
      return { output: null, error: buildFreeTierLimitError(ip, stats) };
    }
  }

  let claudeResult;
  try {
    claudeResult = await callClaudeForDocument({
      documentText: params.document_text,
      documentImage: params.document_image,
      documentTypeHint: params.document_type_hint,
      issuingJurisdiction: params.issuing_jurisdiction
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: null,
      error: {
        agent_action: 'REFER_TO_HUMAN' as AgentAction,
        error: 'Document analysis failed.',
        likely_cause: msg,
        agent_instruction: 'Retry once. If the error persists contact support at ojas@kordagencies.com.',
        retryable: true,
        _disclaimer: LEGAL_DISCLAIMER
      }
    };
  }

  const agentAction = verdictToAgentAction(claudeResult.verdict);
  const effectiveLimit = getEffectiveLimit(ip, stats);
  const usedAfter = getCurrentMonthCalls(ip, stats) + (paid ? 0 : 1);
  const remaining = Math.max(0, effectiveLimit - usedAfter);

  const output: DocumentVerdictResponse = {
    agent_action: agentAction,
    verdict: claudeResult.verdict,
    confidence: (claudeResult.confidence ?? 'NONE') as Confidence,
    document_type_identified: claudeResult.document_type_identified ?? null,
    assessed_against: claudeResult.assessed_against ?? null,
    known_issuing_standard: claudeResult.known_issuing_standard ?? null,
    flags: Array.isArray(claudeResult.flags) ? claudeResult.flags : [],
    reason: claudeResult.reason ?? '',
    analysis_type: 'AI-powered reasoning -- NOT a database lookup',
    checked_at: nowISO(),
    ...(claudeResult.verdict === 'FLAG' ? {
      hold_reason: claudeResult.flags[0] ?? claudeResult.reason ?? 'Document contains inconsistencies requiring manual verification',
      retry_after: null,
      escalation_path: 'Submit document to human compliance reviewer for manual verification before approving payment or releasing funds'
    } : {}),
    _disclaimer: LEGAL_DISCLAIMER
  };

  if (!paid && remaining <= FREE_TIER_LIMIT - FREE_TIER_WARNING) {
    output._upgrade_notice =
      `${remaining} of ${effectiveLimit} free calls remaining this month. ` +
      `Upgrade to Pro (500 calls/$29) at ${PRO_UPGRADE_URL}.`;
  }

  return { output, error: null };
}

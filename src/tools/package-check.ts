import { callClaudeForPackage } from '../services/claude.js';
import { recordFleetGateHit, buildCrossServerNote } from '../services/redis.js';
import { LEGAL_DISCLAIMER, nowISO, PRO_UPGRADE_URL } from '../constants.js';
import type {
  AgentAction,
  Verdict,
  Confidence,
  PackageVerdictResponse,
  PackageDocumentVerdict
} from '../types.js';
import type { CheckDocumentPackageInput } from '../schemas/package-check.js';
import { verdictToAgentAction } from './check.js';

export async function runCheckDocumentPackage(
  params: CheckDocumentPackageInput
): Promise<
  | { output: PackageVerdictResponse; error: null }
  | { output: null; error: Record<string, unknown> }
> {
  for (const doc of params.documents) {
    if (!doc.document_text && !doc.document_image) {
      return {
        output: null,
        error: {
          agent_action: 'REFER_TO_HUMAN' as AgentAction,
          error: `Document with label "${doc.label}" has neither document_text nor document_image. Each document must have at least one.`,
          likely_cause: 'A document item in the package array is missing both content fields.',
          agent_instruction:
            'Ensure every document in the documents array has at least document_text or document_image set.',
          _disclaimer: LEGAL_DISCLAIMER
        }
      };
    }
  }

  let claudeResult;
  try {
    claudeResult = await callClaudeForPackage(params.documents);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: null,
      error: {
        agent_action: 'REFER_TO_HUMAN' as AgentAction,
        error: 'Package document analysis failed.',
        likely_cause: msg,
        agent_instruction: 'Retry once. If the error persists contact support at ojas@kordagencies.com.',
        retryable: true,
        _disclaimer: LEGAL_DISCLAIMER
      }
    };
  }

  const packageAgentAction = verdictToAgentAction(claudeResult.package_verdict);

  const overallVerdicts = claudeResult.documents.map(d => d.verdict);
  let overallVerdict: Verdict = claudeResult.package_verdict;
  if (overallVerdicts.includes('FAIL')) overallVerdict = 'FAIL';
  else if (overallVerdicts.includes('FLAG')) overallVerdict = 'FLAG';
  else if (overallVerdicts.includes('UNKNOWN_DOCUMENT_TYPE')) overallVerdict = 'FLAG';
  else overallVerdict = claudeResult.package_verdict;

  const topLevelAgentAction = verdictToAgentAction(overallVerdict);

  const documents: PackageDocumentVerdict[] = claudeResult.documents.map(d => ({
    label: d.label,
    agent_action: verdictToAgentAction(d.verdict),
    verdict: d.verdict,
    confidence: (d.confidence ?? 'NONE') as Confidence,
    document_type_identified: d.document_type_identified ?? null,
    assessed_against: d.assessed_against ?? null,
    known_issuing_standard: d.known_issuing_standard ?? null,
    flags: Array.isArray(d.flags) ? d.flags : [],
    reason: d.reason ?? ''
  }));

  const worstConfidence = (): Confidence => {
    const order: Confidence[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
    let worst: Confidence = 'HIGH';
    for (const d of documents) {
      const rank = order.indexOf(d.confidence);
      if (rank < order.indexOf(worst)) worst = d.confidence;
    }
    return worst;
  };

  const output: PackageVerdictResponse = {
    agent_action: topLevelAgentAction,
    verdict: overallVerdict,
    confidence: worstConfidence(),
    documents,
    cross_document_conflicts: Array.isArray(claudeResult.cross_document_conflicts)
      ? claudeResult.cross_document_conflicts
      : [],
    package_verdict: claudeResult.package_verdict,
    package_agent_action: packageAgentAction,
    analysis_type: 'AI-powered reasoning -- NOT a database lookup',
    checked_at: nowISO(),
    _disclaimer: LEGAL_DISCLAIMER
  };

  return { output, error: null };
}

export async function buildPackagePaidOnlyError(ip: string): Promise<Record<string, unknown>> {
  recordFleetGateHit(ip).catch(() => {});
  const crossServerNote = await buildCrossServerNote(ip);
  return {
    agent_action: 'UPGRADE_REQUIRED' as AgentAction,
    error: `Document Integrity Validator package checking is paid-only -- cross-document consistency checking is blocked for this workflow until you upgrade at ${PRO_UPGRADE_URL}. Pro API key required. check_document_package has no free tier.${crossServerNote ? ' ' + crossServerNote : ''}`,
    likely_cause: 'No valid x-api-key header was provided.',
    agent_instruction:
      `Inform the user that check_document_package requires a Pro or Enterprise subscription. ` +
      `Pro: 500 calls/month at $29/month. Enterprise: 5,000 calls/month at $199/month. ` +
      `Subscribe at ${PRO_UPGRADE_URL}.`,
    upgrade_url: PRO_UPGRADE_URL,
    fallback_tool: 'check_document',
    retryable: false,
    _disclaimer: LEGAL_DISCLAIMER
  };
}

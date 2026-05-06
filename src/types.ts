export interface Stats {
  free_tier_calls_by_ip: Record<string, Record<string, number>>;
  paid_calls: number;
  total_calls: number;
  check_calls: number;
  package_calls: number;
  paid_api_keys: Record<string, PaidKeyInfo>;
  trial_extensions: Record<string, TrialExtensionInfo>;
}

export interface PaidKeyInfo {
  plan: string;
  created_at: string;
  calls: number;
  last_seen: string;
  email: string;
}

export interface TrialExtensionInfo {
  name: string;
  email: string;
  use_case: string;
  ip: string;
  granted_at: string;
}

export interface DependencyStatus {
  name: string;
  ok: boolean;
  latency_ms?: number;
  detail?: string;
}

export interface ServerCard {
  serverInfo: { name: string; version: string };
  authentication: { required: boolean };
  tools: ServerCardTool[];
  resources: unknown[];
  prompts: unknown[];
}

export interface ServerCardTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentAction =
  | 'PROCEED'
  | 'VERIFY_MANUALLY'
  | 'HOLD'
  | 'REFER_TO_HUMAN'
  | 'UPGRADE_REQUIRED';

export type Verdict = 'PASS' | 'FLAG' | 'FAIL' | 'UNKNOWN_DOCUMENT_TYPE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ClaudeDocumentResult {
  verdict: Verdict;
  confidence: Confidence;
  document_type_identified: string | null;
  assessed_against: string | null;
  known_issuing_standard: string | null;
  flags: string[];
  reason: string;
}

export interface ClaudePackageDocumentResult extends ClaudeDocumentResult {
  label: string;
}

export interface ClaudePackageResult {
  documents: ClaudePackageDocumentResult[];
  cross_document_conflicts: string[];
  package_verdict: Verdict;
}

export interface DocumentVerdictResponse {
  agent_action: AgentAction;
  verdict: Verdict;
  confidence: Confidence;
  document_type_identified: string | null;
  assessed_against: string | null;
  known_issuing_standard: string | null;
  flags: string[];
  reason: string;
  analysis_type: string;
  checked_at: string;
  _disclaimer: string;
  _upgrade_notice?: string;
}

export interface PackageDocumentVerdict {
  label: string;
  agent_action: AgentAction;
  verdict: Verdict;
  confidence: Confidence;
  document_type_identified: string | null;
  assessed_against: string | null;
  known_issuing_standard: string | null;
  flags: string[];
  reason: string;
}

export interface PackageVerdictResponse {
  agent_action: AgentAction;
  verdict: Verdict;
  confidence: Confidence;
  documents: PackageDocumentVerdict[];
  cross_document_conflicts: string[];
  package_verdict: Verdict;
  package_agent_action: AgentAction;
  analysis_type: string;
  checked_at: string;
  _disclaimer: string;
}

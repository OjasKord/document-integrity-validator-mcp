import { z } from 'zod';

export const DocumentItemSchema = z.object({
  document_text: z
    .string()
    .max(50000)
    .optional()
    .describe('Extracted text content from this document.'),
  document_image: z
    .string()
    .max(10000000)
    .optional()
    .describe('Base64 encoded image of this document.'),
  document_type_hint: z
    .string()
    .max(200)
    .optional()
    .describe('Agent-suggested document type, e.g. "commercial_invoice".'),
  issuing_jurisdiction: z
    .string()
    .max(200)
    .optional()
    .describe('Country or issuing body for this specific document.'),
  label: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'Agent-assigned identifier for this document in the package, e.g. "packing_list", "certificate_of_origin", "commercial_invoice". Used in cross-document conflict reporting.'
    )
}).strict();

export const CheckDocumentPackageInputSchema = z.object({
  documents: z
    .array(DocumentItemSchema)
    .min(2)
    .max(20)
    .describe(
      'Array of 2 to 20 related documents to assess individually and cross-check against each other. Each document must have a unique label.'
    )
}).strict();

export type DocumentItem = z.infer<typeof DocumentItemSchema>;
export type CheckDocumentPackageInput = z.infer<typeof CheckDocumentPackageInputSchema>;

const AgentActionEnum = z.enum(['PROCEED', 'VERIFY_MANUALLY', 'HOLD', 'REFER_TO_HUMAN', 'UPGRADE_REQUIRED']);
const VerdictEnum = z.enum(['PASS', 'FLAG', 'FAIL', 'UNKNOWN_DOCUMENT_TYPE']);
const ConfidenceEnum = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);

export const CheckDocumentPackageOutputSchema = z.object({
  agent_action: AgentActionEnum,
  verdict: VerdictEnum,
  confidence: ConfidenceEnum,
  documents: z.array(z.object({
    label: z.string(),
    agent_action: AgentActionEnum,
    verdict: VerdictEnum,
    confidence: ConfidenceEnum,
    document_type_identified: z.string().nullable(),
    assessed_against: z.string().nullable(),
    known_issuing_standard: z.string().nullable(),
    flags: z.array(z.string()),
    reason: z.string()
  })),
  cross_document_conflicts: z.array(z.string()),
  package_verdict: VerdictEnum,
  package_agent_action: AgentActionEnum,
  analysis_type: z.string(),
  checked_at: z.string(),
  _disclaimer: z.string(),
  calls_remaining: z.union([z.number(), z.literal('unlimited')]),
  verdict_ttl: z.number(),
  data_source_status: z.enum(['full', 'degraded', 'partial'])
});

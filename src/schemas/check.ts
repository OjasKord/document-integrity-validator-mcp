import { z } from 'zod';

export const CheckDocumentInputSchema = z.object({
  document_text: z
    .string()
    .max(50000)
    .optional()
    .describe('Extracted text content from the document. Provide this or document_image or both.'),
  document_image: z
    .string()
    .max(10000000)
    .optional()
    .describe(
      'Base64 encoded document image. Accepts raw base64 or a data URL (data:image/jpeg;base64,...). Supported types: JPEG, PNG, GIF, WEBP.'
    ),
  document_type_hint: z
    .string()
    .max(200)
    .optional()
    .describe(
      'What the calling agent believes the document type is, e.g. "bill_of_lading", "passport", "certificate_of_origin". Optional -- the validator identifies the type independently.'
    ),
  issuing_jurisdiction: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Country or issuing body, e.g. "Singapore", "ICAO", "United Kingdom". Narrows jurisdiction-specific standard selection.'
    )
}).strict();

export type CheckDocumentInput = z.infer<typeof CheckDocumentInputSchema>;

export const CheckDocumentOutputSchema = z.object({
  agent_action: z.enum(['PROCEED', 'VERIFY_MANUALLY', 'HOLD', 'REFER_TO_HUMAN', 'UPGRADE_REQUIRED']),
  verdict: z.enum(['PASS', 'FLAG', 'FAIL', 'UNKNOWN_DOCUMENT_TYPE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']),
  document_type_identified: z.string().nullable(),
  assessed_against: z.string().nullable().describe('Named standard, e.g. "ICAO Document 9303" -- null for UNKNOWN_DOCUMENT_TYPE'),
  known_issuing_standard: z.string().nullable(),
  flags: z.array(z.string()),
  reason: z.string(),
  analysis_type: z.string(),
  checked_at: z.string(),
  hold_reason: z.string().optional(),
  retry_after: z.number().nullable().optional(),
  escalation_path: z.string().nullable().optional(),
  _disclaimer: z.string(),
  _upgrade_notice: z.string().optional()
});

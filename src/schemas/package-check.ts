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

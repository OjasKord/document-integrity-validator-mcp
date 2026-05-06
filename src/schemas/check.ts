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

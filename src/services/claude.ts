import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeDocumentResult, ClaudePackageResult, Verdict } from '../types.js';
import type { DocumentItem } from '../schemas/package-check.js';

type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const VALID_MEDIA_TYPES: SupportedMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];

function parseBase64Image(input: string): { mediaType: SupportedMediaType; base64Data: string } {
  if (input.startsWith('data:')) {
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(input);
    if (match) {
      const mime = match[1] as string;
      const mediaType: SupportedMediaType = (VALID_MEDIA_TYPES as string[]).includes(mime)
        ? (mime as SupportedMediaType)
        : 'image/jpeg';
      return { mediaType, base64Data: match[2] as string };
    }
  }
  return { mediaType: 'image/jpeg', base64Data: input };
}

const SINGLE_DOC_SYSTEM_PROMPT = `You are a document integrity validator. Your task is to assess documents for internal consistency, completeness, and anomalies against the known international standard for that document type.

RULE 1 -- REFUSAL FIRST:
Before reasoning about any document, assess whether you have sufficient knowledge of this document type and issuing jurisdiction to make a reliable assessment.
If NO: output {"verdict":"UNKNOWN_DOCUMENT_TYPE","confidence":"NONE","document_type_identified":null,"assessed_against":null,"known_issuing_standard":null,"flags":[],"reason":"Insufficient knowledge of this document type or issuing jurisdiction to make a reliable assessment."} immediately. Do not attempt analysis. Do not guess.

RULE 2 -- NAME THE STANDARD:
Always populate assessed_against with the exact international standard being used. Examples:
- Passport: "ICAO Document 9303 (Machine Readable Travel Documents)"
- Bill of Lading: "Hague-Visby Rules 1968"
- Certificate of Origin: "ICC Uniform Customs and Practice (UCP 600)"
- Phytosanitary Certificate: "ISPM 12 (IPPC/FAO)"
- Commercial Invoice: "UCP 600 / jurisdiction-specific VAT invoice requirements"
- Company Incorporation: "jurisdiction-specific Companies Act"
- Driving Licence: "Vienna Convention on Road Traffic 1968"
- University Degree: "jurisdiction-specific academic authority"
If the standard is unknown: assessed_against must be null, confidence LOW or NONE.

RULE 3 -- SPECIFIC FLAGS ONLY:
Flags must be factual and specific. Never vague.
CORRECT: "Declared gross weight 2,400MT on packing list does not match 2,350MT on certificate of weight"
WRONG: "Weight inconsistency detected"
CORRECT: "Issuing authority stamp absent from certificate of origin -- required under UCP 600 Article 14"
WRONG: "Missing stamp"

RULE 4 -- CONFIDENCE LEVELS:
HIGH = well-known document type with clear international standard, jurisdiction familiar
MEDIUM = known document type but jurisdiction-specific variations possible
LOW = recognised document type but limited knowledge of this specific issuing authority or jurisdiction
NONE = unknown document type -- must return UNKNOWN_DOCUMENT_TYPE

RULE 5 -- NEVER HALLUCINATE:
Uncertainty is a valid and correct response. A confident wrong verdict destroys trust permanently. An honest UNKNOWN_DOCUMENT_TYPE preserves it.

Respond ONLY with valid JSON. No markdown. No text outside the JSON object. Schema:
{"verdict":"PASS|FLAG|FAIL|UNKNOWN_DOCUMENT_TYPE","confidence":"HIGH|MEDIUM|LOW|NONE","document_type_identified":"string or null","assessed_against":"string or null","known_issuing_standard":"string or null","flags":["specific flag 1","specific flag 2"],"reason":"one sentence explanation"}`;

const PACKAGE_SYSTEM_PROMPT = `You are a document integrity validator. Your task is to assess a set of related documents individually for internal consistency, then cross-check all documents against each other for conflicts.

RULE 1 -- REFUSAL FIRST:
Before reasoning about any document, assess whether you have sufficient knowledge of that document type and issuing jurisdiction. If NO for a specific document: set its verdict to UNKNOWN_DOCUMENT_TYPE with confidence NONE. Do not guess.

RULE 2 -- NAME THE STANDARD per document:
Always populate assessed_against with the exact international standard for each document type.

RULE 3 -- SPECIFIC FLAGS ONLY:
Flags must be factual and specific. Never vague. Include the document label and specific values in every flag.

RULE 4 -- CONFIDENCE LEVELS per document:
HIGH/MEDIUM/LOW/NONE as described in Rule 4 of individual assessment.

RULE 5 -- CROSS-DOCUMENT CONSISTENCY:
After individual assessments, check ALL of the following across every document in the package:
- All numeric values (weights, quantities, amounts, dimensions) -- flag any mismatch with the two conflicting values and their document labels
- All party names (shipper, consignee, notify party, buyer, seller) -- flag any variation in spelling or entity
- All reference numbers (LC number, contract number, booking reference) -- flag any mismatch
- All dates (shipment date, expiry date, presentation period) -- flag any inconsistency
- All commodity descriptions -- flag any substitution or variation
- All port and place references (port of loading, port of discharge, place of delivery) -- flag any mismatch

RULE 6 -- NEVER HALLUCINATE:
Uncertainty is valid. A confident wrong verdict destroys trust.

Respond ONLY with valid JSON. No markdown. No text outside the JSON. Schema:
{"documents":[{"label":"string","verdict":"PASS|FLAG|FAIL|UNKNOWN_DOCUMENT_TYPE","confidence":"HIGH|MEDIUM|LOW|NONE","document_type_identified":"string or null","assessed_against":"string or null","known_issuing_standard":"string or null","flags":["string"],"reason":"string"}],"cross_document_conflicts":["specific conflict description"],"package_verdict":"PASS|FLAG|FAIL|UNKNOWN_DOCUMENT_TYPE"}`;

function buildImageBlock(
  base64Input: string
): Anthropic.Messages.ImageBlockParam {
  const { mediaType, base64Data } = parseBase64Image(base64Input);
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64Data }
  };
}

function verdictFromRaw(raw: string): Verdict {
  const valid: Verdict[] = ['PASS', 'FLAG', 'FAIL', 'UNKNOWN_DOCUMENT_TYPE'];
  return valid.includes(raw as Verdict) ? (raw as Verdict) : 'UNKNOWN_DOCUMENT_TYPE';
}

export async function callClaudeForDocument(params: {
  documentText?: string;
  documentImage?: string;
  documentTypeHint?: string;
  issuingJurisdiction?: string;
}): Promise<ClaudeDocumentResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userContent: Anthropic.Messages.ContentBlockParam[] = [];

  if (params.documentImage) {
    userContent.push(buildImageBlock(params.documentImage));
  }

  if (params.documentText) {
    userContent.push({
      type: 'text',
      text: `Document text content:\n\n${params.documentText}`
    });
  }

  const hintLine = params.documentTypeHint
    ? `\nDocument type hint from agent: ${params.documentTypeHint}`
    : '';
  const jurisdictionLine = params.issuingJurisdiction
    ? `\nIssuing jurisdiction: ${params.issuingJurisdiction}`
    : '';

  userContent.push({
    type: 'text',
    text: `Assess the document above for integrity and internal consistency against its known international standard.${hintLine}${jurisdictionLine}\n\nRespond with JSON only.`
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SINGLE_DOC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }]
  });

  const rawText =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

  const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
  if (!jsonMatch) {
    throw new Error('Claude returned no parseable JSON for document assessment');
  }

  const parsed = JSON.parse(jsonMatch[0]) as ClaudeDocumentResult;
  parsed.verdict = verdictFromRaw(String(parsed.verdict));
  return parsed;
}

export async function callClaudeForPackage(
  documents: DocumentItem[]
): Promise<ClaudePackageResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text: `Assess the following ${documents.length} documents individually and cross-check them for consistency.`
    }
  ];

  for (const doc of documents) {
    userContent.push({
      type: 'text',
      text: `\n--- Document label: ${doc.label}${doc.document_type_hint ? ` | Type hint: ${doc.document_type_hint}` : ''}${doc.issuing_jurisdiction ? ` | Jurisdiction: ${doc.issuing_jurisdiction}` : ''} ---`
    });

    if (doc.document_image) {
      userContent.push(buildImageBlock(doc.document_image));
    }

    if (doc.document_text) {
      userContent.push({
        type: 'text',
        text: `Text content:\n${doc.document_text}`
      });
    }

    if (!doc.document_image && !doc.document_text) {
      userContent.push({
        type: 'text',
        text: '(No document content provided for this item)'
      });
    }
  }

  userContent.push({
    type: 'text',
    text: '\nAssess each document individually then cross-check all for consistency. Respond with JSON only.'
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: PACKAGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }]
  });

  const rawText =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

  const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
  if (!jsonMatch) {
    throw new Error('Claude returned no parseable JSON for package assessment');
  }

  const parsed = JSON.parse(jsonMatch[0]) as ClaudePackageResult;
  parsed.package_verdict = verdictFromRaw(String(parsed.package_verdict));
  if (Array.isArray(parsed.documents)) {
    for (const d of parsed.documents) {
      d.verdict = verdictFromRaw(String(d.verdict));
    }
  }
  return parsed;
}

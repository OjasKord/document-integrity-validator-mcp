[![smithery badge](https://smithery.ai/badge/OjasKord/document-integrity-validator-mcp)](https://smithery.ai/servers/OjasKord/document-integrity-validator-mcp)

# Document Integrity Validator MCP

[![ToolRank](https://toolrank.dev/badge/dominant.svg)](https://toolrank.dev/ranking)

Before your agent accepts, processes, or acts on any document received from an external party -- verify it is internally consistent and matches the known standard for its type. One call. Any document. Machine-readable verdict.

## What it does

Checks any document for internal consistency, completeness, and anomalies against the known international standard for that document type. Accepts base64 image or extracted text. Returns a structured verdict with a machine-readable `agent_action` field.

Supported standards include: ICAO Document 9303 (passports), Hague-Visby Rules 1968 (bills of lading), UCP 600 (trade finance documents), ISPM 12/IPPC/FAO (phytosanitary certificates), Vienna Convention on Road Traffic 1968 (driving licences), and more.

Returns `UNKNOWN_DOCUMENT_TYPE` rather than guessing on unfamiliar documents -- refusal is correct behaviour, not a failure.

AI-powered reasoning -- NOT a database lookup.

## Tools

### check_document (Free tier: 10 calls/month)

Checks a single document against its international standard.

**Input:**
- `document_text` (string, optional) -- extracted text from the document
- `document_image` (string, optional) -- base64 encoded image (raw base64 or data URL)
- `document_type_hint` (string, optional) -- agent belief about document type
- `issuing_jurisdiction` (string, optional) -- country or issuing body

At least one of `document_text` or `document_image` is required.

**Response:**
```json
{
  "agent_action": "PROCEED",
  "verdict": "PASS",
  "confidence": "HIGH",
  "document_type_identified": "Bill of Lading",
  "assessed_against": "Hague-Visby Rules 1968",
  "known_issuing_standard": "IMO",
  "flags": [],
  "reason": "Document is internally consistent and compliant with Hague-Visby Rules 1968.",
  "analysis_type": "AI-powered reasoning -- NOT a database lookup",
  "checked_at": "2026-05-06T10:00:00.000Z",
  "_disclaimer": "..."
}
```

**agent_action values:**
- `PROCEED` -- document passed
- `VERIFY_MANUALLY` -- flags found, agent should flag for human review
- `HOLD` -- document failed, do not proceed
- `REFER_TO_HUMAN` -- document type unknown, refer for manual assessment

### check_document_package (Paid tier only)

Checks 2-20 related documents individually then cross-checks all for consistency conflicts.

**Input:**
- `documents` (array, min 2, max 20) -- each item has: `label` (required), `document_text`, `document_image`, `document_type_hint`, `issuing_jurisdiction`

**Cross-checks performed:** weights/quantities/amounts, party names, reference numbers, dates, commodity descriptions, port references.

## Pricing

| Tier | Calls | Price |
|------|-------|-------|
| Free | 10/month per IP | No API key required |
| Trial extension | +10 one-time | POST /trial-extension |
| Pro | 500/month | $29/month |
| Enterprise | 5,000/month | $199/month |

Overage: $0.05 per call above monthly cap.

Subscribe at [kordagencies.com](https://kordagencies.com).

## Harness Integration

### Claude Code / Claude Desktop (.mcp.json)
```json
{
  "mcpServers": {
    "document-integrity-validator": {
      "type": "http",
      "url": "https://document-integrity-validator-mcp-production.up.railway.app/mcp"
    }
  }
}
```

### LangChain / LangGraph (Python)
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({
    "document-integrity-validator": {
        "url": "https://document-integrity-validator-mcp-production.up.railway.app/mcp",
        "transport": "http"
    }
})
tools = await client.get_tools()
```

### OpenAI Agents SDK (Python)
```python
from agents import Agent, HostedMCPTool
agent = Agent(
    name="Assistant",
    tools=[HostedMCPTool(tool_config={
        "type": "mcp",
        "server_label": "document-integrity-validator",
        "server_url": "https://document-integrity-validator-mcp-production.up.railway.app/mcp",
        "require_approval": "never"
    })]
)
```

## Self-hosted (stdio)

```bash
npm install -g document-integrity-validator-mcp
ANTHROPIC_API_KEY=sk-ant-... TRANSPORT=stdio document-integrity-validator-mcp
```

Add to Claude Desktop `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "document-integrity-validator": {
      "command": "document-integrity-validator-mcp",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

## Trial Extension

If you have reached the 10 call/month free limit, request 10 extra calls:

```bash
curl -X POST https://document-integrity-validator-mcp-production.up.railway.app/trial-extension \
  -H "Content-Type: application/json" \
  -d '{"name":"Your Name","email":"you@example.com","use_case":"Brief description"}'
```

One extension per email address.

## Legal

AI-powered document consistency assessment. Results are for informational purposes only and do not constitute legal, compliance, or authentication advice. We do not log or store your document content. Full terms: [kordagencies.com/terms.html](https://kordagencies.com/terms.html)

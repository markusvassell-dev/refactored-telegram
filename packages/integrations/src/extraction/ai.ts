import { z } from 'zod';
import { AppError, createLogger, type Logger } from '@element/shared';
import { pageOf } from './pdf-text.js';
import {
  truncateEvidence,
  type ExtractedValue,
  type ExtractionRequest,
  type ExtractionResult,
  type FieldExtractor,
} from './types.js';

/**
 * AI-assisted structured extraction.
 *
 * Boundaries, enforced here and not merely documented:
 *
 *  - Disabled unless an administrator has explicitly configured and enabled a
 *    provider. The constructor refuses to build otherwise.
 *  - Runs only after the deterministic extractors, and only for the tokens
 *    they could not find.
 *  - Output must satisfy a strict schema. Anything else is discarded.
 *  - A value with no supporting quotation from the document is discarded — the
 *    model may not invent a value.
 *  - Values below the configured confidence threshold are reported as missing
 *    so a human supplies them.
 *  - Only the minimum necessary text is sent, and the operation is auditable.
 *
 * The model never rewrites legal wording, approves anything, or resolves a
 * conflict; it only proposes structured field values for human confirmation.
 */

const aiValueSchema = z.object({
  token: z.string().min(1),
  value: z.string().nullable(),
  /** A verbatim quotation from the supplied text supporting the value. */
  evidence: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const aiResponseSchema = z.object({
  values: z.array(aiValueSchema).max(100),
});

export interface AiExtractorConfig {
  enabled: boolean;
  provider: 'none' | 'anthropic';
  apiKey?: string;
  model: string;
  minConfidence: number;
  /** Maximum characters of document text sent to the provider. */
  maxCharacters?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class AiExtractor implements FieldExtractor {
  readonly name = 'ai-assisted';
  readonly method = 'AI_ASSISTED' as const;
  readonly priority = 4;

  private readonly logger: Logger;
  private readonly maxCharacters: number;

  constructor(private readonly config: AiExtractorConfig) {
    if (!config.enabled) {
      throw new AppError('AI extraction is not enabled.', {
        category: 'PRECONDITION',
        userMessage: 'AI-assisted extraction is turned off. An administrator can enable it in Integrations.',
      });
    }
    if (config.provider === 'none' || !config.apiKey) {
      throw new AppError('AI extraction is enabled but no provider is configured.', { category: 'PRECONDITION' });
    }
    this.logger = config.logger ?? createLogger({ base: { integration: 'ai-extraction' } });
    this.maxCharacters = config.maxCharacters ?? 60_000;
  }

  /** The AI extractor is a fallback: it is offered every token it is asked for. */
  supports(): boolean {
    return true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    if (request.wantedTokens.length === 0) {
      return { values: [], missingTokens: [], blockers: [], warnings: [] };
    }

    // Send the minimum necessary information.
    const text = request.text.fullText.slice(0, this.maxCharacters);
    const truncated = request.text.fullText.length > this.maxCharacters;

    const warnings: string[] = [];
    if (truncated) {
      warnings.push('Only the first part of the document was sent for AI extraction.');
    }

    this.logger.info('Requesting AI-assisted extraction', {
      documentId: request.documentId,
      tokenCount: request.wantedTokens.length,
      characters: text.length,
      model: this.config.model,
    });

    const raw = await this.callProvider(text, request.wantedTokens);
    const parsed = aiResponseSchema.safeParse(raw);

    if (!parsed.success) {
      return {
        values: [],
        missingTokens: [...request.wantedTokens],
        blockers: [],
        warnings: [...warnings, 'The AI extraction response did not match the expected schema and was discarded.'],
      };
    }

    const values: ExtractedValue[] = [];

    for (const candidate of parsed.data.values) {
      if (!request.wantedTokens.includes(candidate.token)) continue;
      if (candidate.value === null || candidate.value.trim() === '') continue;

      // A value with no supporting quotation, or a quotation that is not
      // actually in the document, is treated as invented and discarded.
      if (!candidate.evidence || !isQuotedFromDocument(candidate.evidence, request.text.fullText)) {
        warnings.push(`An AI-proposed value for "${candidate.token}" had no verifiable evidence and was discarded.`);
        continue;
      }

      if (candidate.confidence < this.config.minConfidence) {
        warnings.push(
          `An AI-proposed value for "${candidate.token}" was below the confidence threshold and needs manual entry.`,
        );
        continue;
      }

      values.push({
        token: candidate.token,
        value: candidate.value.trim(),
        method: this.method,
        confidence: candidate.confidence,
        evidence: [
          {
            sourceDocumentId: request.documentId,
            sourceDocumentHash: request.documentHash,
            pageNumber: pageOf(request.text, candidate.evidence),
            supportingText: truncateEvidence(candidate.evidence),
          },
        ],
      });
    }

    const found = new Set(values.map((value) => value.token));
    return {
      values,
      missingTokens: request.wantedTokens.filter((token) => !found.has(token)),
      blockers: [],
      warnings,
    };
  }

  private async callProvider(text: string, tokens: readonly string[]): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? fetch;

    const instruction = [
      'Extract the requested fields from the document text below.',
      '',
      'Rules:',
      '- Return only values that appear in the text. Never infer, estimate, or invent a value.',
      '- For every value, quote the exact supporting text verbatim in "evidence".',
      '- If a field is not present, return it with "value": null.',
      '- Do not rewrite, summarise, or improve any wording.',
      '',
      `Fields to extract: ${tokens.join(', ')}`,
      '',
      'Respond with JSON only, matching:',
      '{"values":[{"token":string,"value":string|null,"evidence":string|null,"confidence":number}]}',
    ].join('\n');

    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        temperature: 0,
        system: 'You extract structured data from accounting documents. You never invent values.',
        messages: [{ role: 'user', content: `${instruction}\n\n<document>\n${text}\n</document>` }],
      }),
    });

    if (!response.ok) {
      throw new AppError(`AI extraction request failed with HTTP ${response.status}`, {
        category: 'INTEGRATION',
        retryable: response.status >= 500 || response.status === 429,
        userMessage: 'AI-assisted extraction is unavailable. The values can be entered manually.',
      });
    }

    const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
    const body = payload.content?.find((block) => block.type === 'text')?.text ?? '';
    const jsonStart = body.indexOf('{');
    const jsonEnd = body.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) return null;

    try {
      return JSON.parse(body.slice(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }
}

/** Confirms a quotation really appears in the document, ignoring whitespace. */
function isQuotedFromDocument(quotation: string, documentText: string): boolean {
  const needle = quotation.replace(/\s+/g, ' ').trim().toLowerCase();
  if (needle.length < 4) return false;
  return documentText.replace(/\s+/g, ' ').toLowerCase().includes(needle);
}

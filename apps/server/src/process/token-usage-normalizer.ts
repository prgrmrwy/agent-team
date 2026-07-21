import type { TokenUsageTotals } from '@agent-team/protocol'
import { withComputedTotal } from '../util/token-usage.js'

type UnknownRecord = Record<string, unknown>

export interface NormalizedUsage extends TokenUsageTotals {
  model?: string
  externalRequestId?: string
  rawUsage?: unknown
}

export function normalizeCodexUsage(raw: unknown): NormalizedUsage | null {
  const usage = pickUsageObject(raw, ['last_token_usage', 'usage'])
  if (!usage) return null
  return {
    ...withComputedTotal({
      inputTokens: numberOf(usage['input_tokens']),
      cacheReadTokens: numberOf(usage['cached_input_tokens']),
      outputTokens: numberOf(usage['output_tokens']),
      reasoningTokens: numberOf(usage['reasoning_output_tokens']),
      totalTokens: numberOf(usage['total_tokens']),
    }),
    rawUsage: raw,
  }
}

export function normalizeClaudeUsage(raw: unknown): NormalizedUsage | null {
  const root = asRecord(raw)
  if (!root) return null
  const message = asRecord(root['message'])
  const usage = asRecord(message?.['usage']) ?? pickUsageObject(root, ['usage'])
  if (!usage) return null
  return {
    ...withComputedTotal({
      inputTokens: numberOf(usage['input_tokens']),
      cacheCreationTokens: numberOf(usage['cache_creation_input_tokens'] ?? usage['cache_creation_tokens']),
      cacheReadTokens: numberOf(usage['cache_read_input_tokens'] ?? usage['cache_read_tokens']),
      outputTokens: numberOf(usage['output_tokens']),
    }),
    model: stringOf(message?.['model'] ?? root['model']),
    externalRequestId: stringOf(root['requestId'] ?? root['request_id']),
    rawUsage: usage,
  }
}

export function normalizeClaudeTelemetryPayload(raw: unknown): NormalizedUsage | null {
  const records = flattenRecords(raw)
  for (const record of records) {
    const usage = extractTelemetryUsage(record)
    if (!usage) continue
    return usage
  }
  return null
}

export function flattenRecords(raw: unknown): UnknownRecord[] {
  const out: UnknownRecord[] = []
  const visit = (value: unknown): void => {
    const record = asRecord(value)
    if (!record) return
    out.push(record)
    for (const v of Object.values(record)) {
      if (Array.isArray(v)) {
        for (const item of v) visit(item)
      } else if (v && typeof v === 'object') {
        visit(v)
      }
    }
  }
  visit(raw)
  return out
}

function extractTelemetryUsage(record: UnknownRecord): NormalizedUsage | null {
  const attrs = collectAttributes(record)
  const usage = {
    inputTokens: numberOf(
      attrs['input_tokens'] ?? attrs['claude_code.input_tokens'] ?? record['input_tokens'],
    ),
    cacheCreationTokens: numberOf(
      attrs['cache_creation_tokens'] ??
        attrs['cache_creation_input_tokens'] ??
        attrs['claude_code.cache_creation_tokens'] ??
        record['cache_creation_tokens'],
    ),
    cacheReadTokens: numberOf(
      attrs['cache_read_tokens'] ??
        attrs['cache_read_input_tokens'] ??
        attrs['claude_code.cache_read_tokens'] ??
        record['cache_read_tokens'],
    ),
    outputTokens: numberOf(
      attrs['output_tokens'] ?? attrs['claude_code.output_tokens'] ?? record['output_tokens'],
    ),
    reasoningTokens: numberOf(
      attrs['reasoning_tokens'] ?? attrs['claude_code.reasoning_tokens'] ?? record['reasoning_tokens'],
    ),
    totalTokens: numberOf(
      attrs['total_tokens'] ?? attrs['claude_code.total_tokens'] ?? record['total_tokens'],
    ),
  }
  const total = withComputedTotal(usage)
  if (total.totalTokens === 0) return null
  return {
    ...total,
    model: stringOf(attrs['model'] ?? attrs['claude_code.model'] ?? record['model']),
    externalRequestId: stringOf(
      attrs['request_id'] ?? attrs['requestId'] ?? attrs['claude_code.request_id'] ?? record['request_id'],
    ),
    rawUsage: record,
  }
}

export function collectAttributes(record: UnknownRecord): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  const merge = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const rec = asRecord(item)
        if (!rec) continue
        const key = stringOf(rec['key'])
        if (!key) continue
        attrs[key] = attributeValue(rec['value'])
      }
      return
    }
    const rec = asRecord(candidate)
    if (rec) Object.assign(attrs, rec)
  }
  merge(record['attributes'])
  merge(record['resourceAttributes'])
  merge(record['resource'])
  const resource = asRecord(record['resource'])
  if (resource) merge(resource['attributes'])
  return attrs
}

function pickUsageObject(raw: unknown, keys: string[]): UnknownRecord | null {
  const record = asRecord(raw)
  if (!record) return null
  for (const key of keys) {
    const value = asRecord(record[key])
    if (value) return value
  }
  return record
}

function attributeValue(raw: unknown): unknown {
  const record = asRecord(raw)
  if (!record) return raw
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (record[key] !== undefined) return record[key]
  }
  return raw
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function numberOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
  }
  return 0
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

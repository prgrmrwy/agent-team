import type { TokenUsageTotals } from '@agent-team/protocol'

export function emptyTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function sumTotals(...totals: TokenUsageTotals[]): TokenUsageTotals {
  const out = emptyTotals()
  for (const t of totals) {
    out.inputTokens += t.inputTokens
    out.cacheCreationTokens += t.cacheCreationTokens
    out.cacheReadTokens += t.cacheReadTokens
    out.outputTokens += t.outputTokens
    out.reasoningTokens += t.reasoningTokens
    out.totalTokens += t.totalTokens
  }
  return out
}

export function withComputedTotal(totals: Partial<TokenUsageTotals>): TokenUsageTotals {
  const normalized = {
    inputTokens: normalizeTokenPart(totals.inputTokens),
    cacheCreationTokens: normalizeTokenPart(totals.cacheCreationTokens),
    cacheReadTokens: normalizeTokenPart(totals.cacheReadTokens),
    outputTokens: normalizeTokenPart(totals.outputTokens),
    reasoningTokens: normalizeTokenPart(totals.reasoningTokens),
    totalTokens: normalizeTokenPart(totals.totalTokens),
  }
  normalized.totalTokens =
    normalized.totalTokens ||
    normalized.inputTokens +
      normalized.cacheCreationTokens +
      normalized.cacheReadTokens +
      normalized.outputTokens +
      normalized.reasoningTokens
  return normalized
}

function normalizeTokenPart(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const units = [
    { suffix: 'B', value: 1_000_000_000 },
    { suffix: 'M', value: 1_000_000 },
    { suffix: 'K', value: 1_000 },
  ]
  const unit = units.find((u) => tokens >= u.value)
  if (!unit) return String(tokens)
  const value = tokens / unit.value
  const formatted = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(1)
  return `${formatted.replace(/\.0$/, '')}${unit.suffix}`
}

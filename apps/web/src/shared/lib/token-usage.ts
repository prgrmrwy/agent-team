export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.trunc(tokens))
  if (value < 1_000) return value.toLocaleString('en-US')
  if (value < 1_000_000) return `${formatCompact(value / 1_000)}K`
  if (value < 1_000_000_000) return `${formatCompact(value / 1_000_000)}M`
  return `${formatCompact(value / 1_000_000_000)}B`
}

function formatCompact(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString('en-US')
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '')
  return value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}

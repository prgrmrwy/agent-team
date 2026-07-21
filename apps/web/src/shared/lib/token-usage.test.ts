import { describe, expect, it } from 'vitest'
import { formatTokenCount } from './token-usage.js'

describe('formatTokenCount', () => {
  it('uses thousand-based K/M/B units', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_200)).toBe('1.2K')
    expect(formatTokenCount(12_345)).toBe('12.3K')
    expect(formatTokenCount(1_234_567)).toBe('1.23M')
    expect(formatTokenCount(2_000_000_000)).toBe('2B')
  })
})

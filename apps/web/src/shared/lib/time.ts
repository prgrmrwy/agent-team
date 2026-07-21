/**
 * 时间格式化工具。尽量轻量，不引入 date-fns 等重库。
 */

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

const THRESHOLDS: Array<[number, Unit]> = [
  [60, 'second'],
  [3_600, 'minute'],
  [86_400, 'hour'],
  [604_800, 'day'],
  [2_592_000, 'week'],
  [31_536_000, 'month'],
  [Infinity, 'year'],
]

/** 返回相对时间字符串，如 "3 分钟前"。 */
export function fromNow(isoOrMs: string | number): string {
  const ts = typeof isoOrMs === 'string' ? new Date(isoOrMs).getTime() : isoOrMs
  const diff = (ts - Date.now()) / 1_000 // seconds, negative = past
  const abs = Math.abs(diff)

  let prev = 1
  for (const [threshold, unit] of THRESHOLDS) {
    if (abs < threshold) {
      return rtf.format(Math.round(diff / prev), unit)
    }
    prev = threshold
  }
  return rtf.format(Math.round(diff / 31_536_000), 'year')
}

/** 格式化为本地时间字符串，如 "2026-06-23 14:30"。 */
export function formatLocal(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'string' ? new Date(isoOrMs) : new Date(isoOrMs)
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 格式化为短时间 "HH:MM"。 */
export function formatTime(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'string' ? new Date(isoOrMs) : new Date(isoOrMs)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

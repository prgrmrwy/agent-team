import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { isInlineFilePath, isLocalFileHref, openFileViewer } from './file-viewer.js'

let isInlineFilePathFn: typeof isInlineFilePath
let isLocalFileHrefFn: typeof isLocalFileHref
let openFileViewerFn: typeof openFileViewer

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const mod = await import('./file-viewer.js')
  isInlineFilePathFn = mod.isInlineFilePath
  isLocalFileHrefFn = mod.isLocalFileHref
  openFileViewerFn = mod.openFileViewer
})

describe('file viewer path detection', () => {
  it('accepts local file hrefs and rejects external/special schemes', () => {
    expect(isLocalFileHrefFn('plan/task-plan.md')).toBe(true)
    expect(isLocalFileHrefFn('./screenshots/home.png')).toBe(true)
    expect(isLocalFileHrefFn('/absolute/local.md')).toBe(true)
    expect(isLocalFileHrefFn('https://example.com/plan.md')).toBe(false)
    expect(isLocalFileHrefFn('http://example.com/plan.md')).toBe(false)
    expect(isLocalFileHrefFn('//example.com/plan.md')).toBe(false)
    expect(isLocalFileHrefFn('mailto:a@example.com')).toBe(false)
    expect(isLocalFileHrefFn('tel:123')).toBe(false)
    expect(isLocalFileHrefFn('vscode://file/tmp/a.ts')).toBe(false)
    expect(isLocalFileHrefFn(undefined)).toBe(false)
  })

  it('recognizes inline local artifact paths with supported extensions', () => {
    expect(isInlineFilePathFn('plan/task-plan.md')).toBe(true)
    expect(isInlineFilePathFn('./apps/web/src/App.tsx')).toBe(true)
    expect(isInlineFilePathFn('screenshots/qa-home.png')).toBe(true)
    expect(isInlineFilePathFn('package.json')).toBe(true)
    expect(isInlineFilePathFn('no-extension')).toBe(false)
    expect(isInlineFilePathFn('https://example.com/app.tsx')).toBe(false)
    expect(isInlineFilePathFn('weird.bin')).toBe(false)
  })
})

describe('openFileViewer', () => {
  it('opens the right panel with a stable file key', () => {
    const openRightPanel = vi.fn()
    const closeRightPanel = vi.fn()

    openFileViewerFn({ openRightPanel, closeRightPanel }, 'task-1', 'plan/task-plan.md')

    expect(openRightPanel).toHaveBeenCalledTimes(1)
    expect(openRightPanel.mock.calls[0]?.[0]).toBe('file:task-1:plan/task-plan.md')
    expect(openRightPanel.mock.calls[0]?.[1]).toMatchObject({
      props: { taskId: 'task-1', path: 'plan/task-plan.md', onClose: closeRightPanel },
    })
    expect(openRightPanel.mock.calls[0]?.[2]).toEqual({ width: '800px' })
  })
})

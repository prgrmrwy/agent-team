import type { FC } from 'react'
import { useState } from 'react'
import { Dialog as BaseDialog } from '@base-ui-components/react/dialog'
import { UsageTab } from './usage-tab.js'

type BookmarkKey = 'usage'

const BOOKMARKS: Array<{ key: BookmarkKey; label: string }> = [{ key: 'usage', label: 'USAGE' }]

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Settings 弹窗:420×600,左 96 vertical bookmark + 右 content。
 * 一期 bookmark 只有 USAGE,布局支持未来加 RUNTIMES / MCPS / PROJECTS。
 */
export const SettingsDialog: FC<SettingsDialogProps> = ({ open, onClose }) => {
  const [active, setActive] = useState<BookmarkKey>('usage')

  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 100,
          }}
        />
        <BaseDialog.Popup
          style={{
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 800,
            height: 600,
            zIndex: 101,
            background: 'var(--slate-surface)',
            border: '1px solid var(--cyan-dim)',
            borderRadius: 2,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 16px var(--cyan-glow)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            fontFamily: 'var(--font-chrome)',
            color: 'var(--ink-soft)',
          }}
        >
          {/* header — title + close */}
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--slate-edge)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <BaseDialog.Title
              className="ab-hud"
              style={{
                color: 'var(--ink-white)',
                fontSize: 11,
                letterSpacing: '0.18em',
                flex: 1,
              }}
            >
              SETTINGS
            </BaseDialog.Title>
            <BaseDialog.Close
              aria-label="close"
              style={{
                width: 22,
                height: 22,
                background: 'transparent',
                border: '1px solid var(--slate-edge)',
                color: 'var(--ink-soft)',
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </BaseDialog.Close>
          </div>

          {/* body — left bookmark + right content */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* bookmark 96w,常驻不滚 */}
            <nav
              style={{
                width: 96,
                flexShrink: 0,
                borderRight: '1px solid var(--slate-edge)',
                background: 'var(--slate-bg)',
                padding: '10px 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {BOOKMARKS.map((b) => {
                const isActive = b.key === active
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setActive(b.key)}
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      padding: '8px 12px',
                      fontSize: 10,
                      letterSpacing: '0.18em',
                      color: isActive ? 'var(--ink-white)' : 'var(--ink-dim)',
                      borderLeft: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`,
                      background: isActive ? 'rgba(91,200,221,0.06)' : 'transparent',
                      fontFamily: 'var(--font-chrome)',
                      fontWeight: 600,
                      transition: 'color 120ms, background 120ms',
                    }}
                  >
                    {b.label}
                  </button>
                )
              })}
            </nav>

            {/* content,可滚 */}
            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 16px' }}>
              {active === 'usage' && <UsageTab />}
            </div>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

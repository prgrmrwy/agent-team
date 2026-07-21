import type { FC, ReactNode } from 'react'
import { Sidebar } from './sidebar.js'

interface AppShellProps {
  children: ReactNode
  rightPanel?: ReactNode
  rightPanelWidth?: string
}

/**
 * App shell — design-handoff §4.1(精简版,已移除 titlebar)
 *
 * ┌──────────┬───────────────────────────────────────┬────────────────────┐
 * │ sidebar  │  main (Outlet)                        │  right panel       │
 * │ 280px    │  flex 1                               │  320px (可关闭)    │
 * └──────────┴───────────────────────────────────────┴────────────────────┘
 *
 * brand + clock 现在挂在 sidebar 顶,settings 弹窗在 sidebar 底触发。
 */
export const AppShell: FC<AppShellProps> = ({ children, rightPanel, rightPanelWidth }) => {
  const showRight = Boolean(rightPanel)
  const cols = showRight
    ? `${'var(--sidebar-w-default)'} 1fr ${rightPanelWidth ?? 'var(--rightpanel-w-default)'}`
    : `${'var(--sidebar-w-default)'} 1fr`

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        height: '100vh',
        width: '100vw',
        background: 'var(--slate-bg)',
        color: 'var(--ink-white)',
        fontFamily: 'var(--font-chrome)',
        position: 'relative',
        zIndex: 1,
      }}
    >
      <Sidebar />
      <main
        style={{
          minHeight: 0,
          overflow: 'auto',
          background: 'var(--slate-bg)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {children}
      </main>
      {showRight && (
        <aside
          style={{
            minHeight: 0,
            overflow: 'auto',
            borderLeft: '1px solid var(--slate-edge)',
            boxShadow: 'inset 1px 0 0 var(--cyan-dim)',
            background: 'var(--slate-surface)',
          }}
        >
          {rightPanel}
        </aside>
      )}
    </div>
  )
}

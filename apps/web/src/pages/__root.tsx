import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { wsClient } from '../shared/api/index.js'
import { AppShell } from '../widgets/app-shell/index.js'
import type { ServerToClient } from '@agent-team/protocol'
import {
  RightPanelContext,
  type OpenRightPanelOptions,
  type RightPanelEntry,
} from '../shared/ui/right-panel.js'

export const rootRoute = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const [rightPanel, setRightPanel] = useState<RightPanelEntry | null>(null)
  const openRightPanel = useCallback((key: string, content: ReactNode, options?: OpenRightPanelOptions) => {
    setRightPanel({ key, content, width: options?.width })
  }, [])
  const resizeRightPanel = useCallback((width?: string) => {
    setRightPanel((prev) => (prev ? { ...prev, width } : prev))
  }, [])
  const closeRightPanel = useCallback(() => {
    setRightPanel(null)
  }, [])
  const rightPanelContext = useMemo(
    () => ({
      entry: rightPanel,
      openRightPanel,
      resizeRightPanel,
      closeRightPanel,
      isRightPanelOpen: (key: string) => rightPanel?.key === key,
    }),
    [closeRightPanel, openRightPanel, resizeRightPanel, rightPanel],
  )

  return (
    <RightPanelContext.Provider value={rightPanelContext}>
      <AppShell rightPanel={rightPanel?.content} rightPanelWidth={rightPanel?.width}>
        <Outlet />
      </AppShell>
      <WsStatusOverlay />
    </RightPanelContext.Provider>
  )
}

/** WS 连接状态 + 桌面通知权限申请。底部 toast,不占 chrome */
function WsStatusOverlay() {
  const [wsConnected, setWsConnected] = useState(() => wsClient.isConnected())
  const [notifDismissed, setNotifDismissed] = useState(() => {
    try {
      return window.localStorage.getItem('agent-team:notif-dismissed') === '1'
    } catch {
      return false
    }
  })
  const notifStatus = typeof Notification !== 'undefined' ? Notification.permission : 'denied'

  useEffect(() => {
    const interval = setInterval(() => {
      setWsConnected(wsClient.isConnected())
    }, 2_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'notification' && Notification.permission === 'granted') {
        new Notification('Agent Team', { body: msg.content })
      }
    })
    return remove
  }, [])

  function requestNotifPermission() {
    Notification.requestPermission().then(() => {
      dismissNotifPrompt()
    })
  }

  function dismissNotifPrompt() {
    setNotifDismissed(true)
    try {
      window.localStorage.setItem('agent-team:notif-dismissed', '1')
    } catch {
      // ignore storage failures
    }
  }

  const items: ReactElement[] = []
  if (!wsConnected) {
    items.push(
      <div
        key="ws"
        style={{
          background: 'rgba(184,58,90,0.18)',
          border: '1px solid var(--malice)',
          color: 'var(--malice)',
          padding: '8px 12px',
          fontSize: 11,
          letterSpacing: '0.1em',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--malice)',
            boxShadow: '0 0 6px var(--malice)',
          }}
        />
        WebSocket 未连接 — 消息实时推送不可用,正在重连…
      </div>,
    )
  }
  if (!notifDismissed && notifStatus === 'default') {
    items.push(
      <div
        key="notif"
        style={{
          background: 'rgba(91,200,221,0.1)',
          border: '1px solid var(--cyan-dim)',
          color: 'var(--ink-soft)',
          padding: '8px 12px',
          fontSize: 11,
          letterSpacing: '0.05em',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span>开启桌面通知,任务完成时立即提醒。</span>
        <button
          type="button"
          onClick={requestNotifPermission}
          style={{
            background: 'rgba(91,200,221,0.18)',
            border: '1px solid var(--cyan)',
            color: 'var(--cyan-bright)',
            padding: '3px 10px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            cursor: 'pointer',
            borderRadius: 2,
          }}
        >
          允许
        </button>
        <button
          type="button"
          onClick={dismissNotifPrompt}
          style={{
            background: 'transparent',
            border: '1px solid var(--slate-edge)',
            color: 'var(--ink-dim)',
            padding: '3px 10px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            cursor: 'pointer',
            borderRadius: 2,
          }}
        >
          暂不
        </button>
      </div>,
    )
  }

  if (items.length === 0) return null
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 72,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
      }}
    >
      {items}
    </div>
  )
}

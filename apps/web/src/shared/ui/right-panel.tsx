import { createContext, useContext, type ReactNode } from 'react'

export interface RightPanelEntry {
  key: string
  content: ReactNode
  width?: string
}

export interface OpenRightPanelOptions {
  width?: string
}

export interface RightPanelContextValue {
  entry: RightPanelEntry | null
  openRightPanel: (key: string, content: ReactNode, options?: OpenRightPanelOptions) => void
  resizeRightPanel: (width?: string) => void
  closeRightPanel: () => void
  isRightPanelOpen: (key: string) => boolean
}

export const RightPanelContext = createContext<RightPanelContextValue | null>(null)

export function useRightPanel(): RightPanelContextValue {
  const ctx = useContext(RightPanelContext)
  if (!ctx) {
    throw new Error('useRightPanel must be used within RightPanelContext.Provider')
  }
  return ctx
}

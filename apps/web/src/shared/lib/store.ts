import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Task } from '@agent-team/protocol'

// ---- Auth Slice ----
interface AuthSlice {
  token: string | null
  setToken: (token: string) => void
  clearToken: () => void
}

// ---- Current Task Slice ----
interface CurrentTaskSlice {
  currentTask: Task | null
  currentTaskId: string | null
  setCurrentTask: (task: Task) => void
  setCurrentTaskId: (id: string) => void
  clearCurrentTask: () => void
}

// ---- Combined Store ----
type Store = AuthSlice & CurrentTaskSlice

export const useStore = create<Store>()(
  subscribeWithSelector((set) => ({
    // Auth slice
    token: null,
    setToken: (token) => set({ token }),
    clearToken: () => set({ token: null }),

    // Current task slice
    currentTask: null,
    currentTaskId: null,
    setCurrentTask: (task) => set({ currentTask: task, currentTaskId: task.id }),
    setCurrentTaskId: (id) => set({ currentTaskId: id }),
    clearCurrentTask: () => set({ currentTask: null, currentTaskId: null }),
  })),
)

// Typed selectors
export const selectToken = (s: Store) => s.token
export const selectCurrentTask = (s: Store) => s.currentTask
export const selectCurrentTaskId = (s: Store) => s.currentTaskId

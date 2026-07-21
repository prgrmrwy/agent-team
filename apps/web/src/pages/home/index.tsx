import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../__root.js'
import { HomePage } from './ui/home-page.js'

export interface IndexSearch {
  /** 预选项目 — sidebar "+ for project X" 用 */
  project?: string
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    project: typeof search['project'] === 'string' ? search['project'] : undefined,
  }),
})

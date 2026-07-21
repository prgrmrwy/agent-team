import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../__root.js'
import { RetroPage } from './ui/retro-page.js'

export const retroRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/retro/$taskId',
  component: function RetroRouteComponent() {
    const { taskId } = retroRoute.useParams()
    return <RetroPage taskId={taskId} />
  },
})

import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../__root.js'
import { TaskPage } from './ui/task-page.js'

export const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$taskId',
  component: function TaskRouteComponent() {
    const { taskId } = taskRoute.useParams()
    return <TaskPage taskId={taskId} />
  },
})

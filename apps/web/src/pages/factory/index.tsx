import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../__root.js'
import { FactoryPage } from './ui/factory-page.js'

export const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/factories/$name',
  component: function FactoryRouteComponent() {
    const { name } = factoryRoute.useParams()
    return <FactoryPage name={name} />
  },
})

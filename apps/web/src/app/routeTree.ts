/**
 * 手动维护的路由树（Wave 2：app/pages/widgets/features 层）。
 * 不使用 router codegen 插件（交互式 CLI 不支持），按 FSD slice 范式手动注册。
 */
import { rootRoute } from '../pages/__root.js'
import { indexRoute } from '../pages/home/index.js'
import { taskRoute } from '../pages/task/index.js'
import { factoryRoute } from '../pages/factory/index.js'
import { retroRoute } from '../pages/retro/index.js'

export const routeTree = rootRoute.addChildren([
  indexRoute,
  taskRoute,
  factoryRoute,
  retroRoute,
])

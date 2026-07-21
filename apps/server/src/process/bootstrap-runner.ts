/**
 * 任务 bootstrap 编排入口 (Phase 2)。
 * 子模块在 ./bootstrap/ 下;此文件保持 spec 中约定的导入路径不变。
 */
export {
  TaskBootstrapRunner,
  PRIMARY_WORKTREE_ID,
  createGenericPnpmProvider,
  createSwProvider,
  parseSwOutput,
} from './bootstrap/index.js'
export type {
  BootstrapProvider,
  BootstrapProviderContext,
  PrepareResult,
  PrepareSuccess,
  PrepareFailure,
  StatusResult,
  ReleaseResult,
  RunnerEmit,
  RunnerOptions,
} from './bootstrap/index.js'

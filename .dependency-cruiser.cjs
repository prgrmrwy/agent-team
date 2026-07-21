/**
 * 全栈依赖纪律（preflight 的一环，见 design.md D6）。
 * 初始规则集（design.md Open Question 5 已决）：
 *   1. FSD 单向：app → pages → widgets → features → entities → shared（上可依赖下，下不可依赖上）
 *   2. 后端分层：domain 不可 import http / ws / mcp（领域层不依赖传输层）
 *   3. 跨 package 不可反向：apps/server 不可 import apps/web，反之亦然
 * 其余规则随开发逐步补充。
 */

/** FSD 层级，index 越小越靠上层 */
const FSD_LAYERS = ['app', 'pages', 'widgets', 'features', 'entities', 'shared']

/** 生成 FSD 单向依赖的 forbidden 规则：upper 层不可被 lower 层 import */
const fsdRules = FSD_LAYERS.flatMap((layer, i) =>
  FSD_LAYERS.slice(i + 1).map((lower) => ({
    name: `fsd-no-upward-${lower}-to-${layer}`,
    comment: `FSD 违规：${lower} 不可 import 更上层的 ${layer}`,
    severity: 'error',
    from: { path: `^apps/web/src/${lower}/` },
    to: { path: `^apps/web/src/${layer}/` },
  })),
)

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...fsdRules,
    {
      name: 'backend-domain-no-transport',
      comment: '后端领域层 domain 不可依赖传输层 http / ws / mcp',
      severity: 'error',
      from: { path: '^apps/server/src/domain/' },
      to: { path: '^apps/server/src/(http|ws|mcp)/' },
    },
    {
      name: 'no-server-to-web',
      comment: 'apps/server 不可 import apps/web',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^apps/web/' },
    },
    {
      name: 'no-web-to-server',
      comment: 'apps/web 不可 import apps/server（共享走 packages/protocol）',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/server/' },
    },
    {
      name: 'no-circular',
      comment: '禁止循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.(test|spec)\\.ts$' },
  },
}

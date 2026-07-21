import type { FC } from 'react'
import type { Factory } from '@agent-team/protocol'

interface FactoryReadonlyViewProps {
  factory: Factory
}

/**
 * 工厂详情只读视图（M1）。M2 起接入编辑表单。
 */
export const FactoryReadonlyView: FC<FactoryReadonlyViewProps> = ({ factory }) => {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold capitalize">{factory.name}</h2>
        <span className="rounded bg-secondary px-2 py-0.5 text-xs">
          v{factory.version}
        </span>
      </div>

      <p className="text-muted-foreground">{factory.persona}</p>

      {/* 核心 MCP */}
      <section>
        <h3 className="mb-1 font-medium">架构必装 MCP</h3>
        <div className="flex flex-wrap gap-1">
          {factory.coreMcps.map((m) => (
            <span key={m.name} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {m.name}
            </span>
          ))}
        </div>
      </section>

      {/* 推荐 Skill */}
      {factory.recommendedSkills.length > 0 && (
        <section>
          <h3 className="mb-1 font-medium">推荐 Skill</h3>
          <div className="flex flex-wrap gap-1">
            {factory.recommendedSkills.map((s) => (
              <span key={s} className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                {s}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 推荐 CLI Tools */}
      {factory.recommendedCliTools.length > 0 && (
        <section>
          <h3 className="mb-1 font-medium">推荐 CLI 工具</h3>
          <div className="flex flex-wrap gap-1">
            {factory.recommendedCliTools.map((t) => (
              <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs font-mono">
                {t}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 推荐 MCP */}
      {factory.recommendedMcps.length > 0 && (
        <section>
          <h3 className="mb-1 font-medium">推荐 MCP</h3>
          <div className="flex flex-wrap gap-1">
            {factory.recommendedMcps.map((m) => (
              <span key={m.name} className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                {m.name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 名字池 */}
      <section>
        <h3 className="mb-1 font-medium">默认名字池</h3>
        <div className="flex flex-wrap gap-1">
          {factory.defaultNamePool.map((n) => (
            <span key={n} className="rounded-full border px-2 py-0.5 text-xs">
              {n}
            </span>
          ))}
        </div>
      </section>

      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        编辑功能 M2 接入。
      </div>
    </div>
  )
}

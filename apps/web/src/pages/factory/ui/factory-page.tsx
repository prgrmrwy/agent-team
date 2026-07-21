import { type FC, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { restClient } from '../../../shared/api/index.js'
import { formatTokenCount } from '../../../shared/lib/token-usage.js'
import { Avatar } from '../../../shared/ui/avatar/index.js'
import { ROLE_NAMES, type RoleName } from '../../../shared/icons/index.js'
import type { AgentModelProfile, Factory, FactoryUsageResponse, ListLocalProvidersResponse } from '@agent-team/protocol'

interface FactoryPageProps {
  name: string
}

/**
 * Factory profile — M3 T4 实现
 * 羊皮纸 register 展示 persona / 工作习惯 / skills / MCPs / 等 profile 信息。
 */
export const FactoryPage: FC<FactoryPageProps> = ({ name }) => {
  const { data: factories = [], isLoading } = useQuery<Factory[]>({
    queryKey: ['factories'],
    queryFn: () => restClient.get<Factory[]>('/factories'),
  })
  const { data: localProviders = [] } = useQuery<ListLocalProvidersResponse>({
    queryKey: ['runtimes', 'local'],
    queryFn: () => restClient.get<ListLocalProvidersResponse>('/runtimes/local'),
  })
  const { data: usage } = useQuery<FactoryUsageResponse>({
    queryKey: ['factory-usage', name],
    queryFn: () => restClient.get<FactoryUsageResponse>(`/factories/${name}/usage`),
  })

  const factory = factories.find((f) => f.name === name)

  if (isLoading) {
    return <CenteredMessage text="加载中…" />
  }
  if (!factory) {
    return <CenteredMessage text={`工厂 "${name}" 不存在或尚未加载。`} />
  }

  const roleKey: RoleName = (factory.name === 'pm-ux' ? 'pmux' : factory.name) as RoleName
  const roleColor = `var(--${roleKey})`
  const providerStatus = Object.fromEntries(localProviders.map((r) => [r.provider, r]))
  const primaryModelProfile = factory.preferredModelProfile
  const fallbackModelProfiles = factory.fallbackModelProfiles

  return (
    <div style={{ padding: '24px 28px', height: '100%', overflow: 'auto' }}>
      <div className="paper-panel" style={{ maxWidth: 860, overflow: 'hidden', borderRadius: 2 }}>
        {/* Hero:Avatar + name + 怪兽身份 + version */}
        <div
          className="paper-head"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            padding: '18px 22px',
          }}
        >
          <Avatar role={roleKey} size={64} displayName={factory.name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: '0.08em',
                color: 'var(--paper)',
                margin: 0,
                textTransform: 'capitalize',
                textShadow: '0 1px 2px rgba(0,0,0,0.3)',
              }}
            >
              {factory.name}
            </h1>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 6,
              }}
            >
              <span
                className="ab-hud"
                style={{
                  fontSize: 10,
                  color: roleColor,
                  letterSpacing: '0.22em',
                  textShadow: `0 0 6px ${roleColor}`,
                }}
              >
                {ROLE_NAMES[roleKey]}
              </span>
              <span
                className="ab-tabular ab-hud"
                style={{
                  fontSize: 10,
                  background: 'rgba(234,216,168,0.12)',
                  border: '1px solid rgba(234,216,168,0.35)',
                  color: 'var(--paper)',
                  padding: '2px 8px',
                  letterSpacing: '0.18em',
                  borderRadius: 2,
                }}
              >
                v{factory.version}
              </span>
              <span
                className="ab-hud"
                style={{
                  fontSize: 10,
                  color: 'var(--paper)',
                  letterSpacing: '0.18em',
                  opacity: 0.82,
                }}
              >
                {factory.lifecycle}
              </span>
            </div>
          </div>
        </div>

        <div className="paper-body" style={{ padding: '22px 26px' }}>
          <Section title="persona">
            <p
              style={{
                fontSize: 16,
                color: 'var(--ink-brown)',
                lineHeight: 1.7,
                margin: 0,
                whiteSpace: 'pre-line',
              }}
            >
              {factory.persona}
            </p>
          </Section>

          {(primaryModelProfile || fallbackModelProfiles.length > 0) && (
            <Section title="model profile preference">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {primaryModelProfile && (
                  <ModelProfileRow
                    label="primary"
                    modelProfile={primaryModelProfile}
                    available={providerStatus[primaryModelProfile.provider]?.available}
                    reason={providerStatus[primaryModelProfile.provider]?.reason}
                  />
                )}
                {fallbackModelProfiles.map((modelProfile, index) => (
                  <ModelProfileRow
                    key={`${modelProfile.provider}-${modelProfile.model ?? index}`}
                    label={`fallback ${index + 1}`}
                    modelProfile={modelProfile}
                    available={providerStatus[modelProfile.provider]?.available}
                    reason={providerStatus[modelProfile.provider]?.reason}
                  />
                ))}
              </div>
            </Section>
          )}

          <Section title="token usage">
            <UsageSummary
              total={usage?.runtime.totalTokens ?? 0}
              items={usage?.tasks ?? []}
              emptyText="no task usage yet"
            />
          </Section>

        {factory.workingHabits.length > 0 && (
          <Section title="working habits">
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {factory.workingHabits.map((h, i) => (
                <li
                  key={i}
                  style={{
                    fontSize: 15,
                    color: 'var(--ink-brown)',
                    padding: '4px 0',
                    paddingLeft: 18,
                    position: 'relative',
                    lineHeight: 1.6,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 9,
                      width: 6,
                      height: 6,
                      background: roleColor,
                      boxShadow: `0 0 4px ${roleColor}`,
                      clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
                    }}
                  />
                  {h}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {factory.deliverables.length > 0 && (
          <Section title="deliverables">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {factory.deliverables.map((d) => (
                <code
                  key={d}
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-brown)',
                    background: 'rgba(107,79,31,0.12)',
                    border: '1px solid var(--paper-shadow)',
                    padding: '4px 8px',
                    fontFamily: 'var(--font-chrome)',
                    borderRadius: 2,
                    display: 'inline-block',
                    width: 'fit-content',
                  }}
                >
                  {d}
                </code>
              ))}
            </div>
          </Section>
        )}

        {factory.recommendedSkills.length > 0 && (
          <Section title="recommended skills">
            <ChipRow items={factory.recommendedSkills} />
          </Section>
        )}

        {factory.recommendedCliTools.length > 0 && (
          <Section title="recommended cli tools">
            <ChipRow items={factory.recommendedCliTools} />
          </Section>
        )}

        <Section title="core mcps (架构必装)">
          <ChipRow items={factory.coreMcps.map((m) => m.name)} variant="core" />
        </Section>

        {factory.recommendedMcps.length > 0 && (
          <Section title="recommended mcps">
            <ChipRow items={factory.recommendedMcps.map((m) => m.name)} />
          </Section>
        )}

        <Section title="default name pool (随机抽签)">
          <ChipRow items={factory.defaultNamePool} variant="name" />
        </Section>

        {factory.defaultPermissions.proposeTransitions.length > 0 && (
          <Section title="propose transitions (该工厂能推进的状态)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {factory.defaultPermissions.proposeTransitions.map((t) => (
                <span
                  key={t}
                  className="ab-tabular"
                  style={{
                    fontSize: 10,
                    color: 'var(--paper-deep)',
                    background: 'rgba(107,79,31,0.08)',
                    border: '1px solid var(--paper-shadow)',
                    padding: '3px 8px',
                    fontFamily: 'var(--font-chrome)',
                    letterSpacing: '0.08em',
                    borderRadius: 2,
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </Section>
        )}

        <Section title="system prompt template">
          <details
            style={{
              fontSize: 13,
              color: 'var(--ink-brown)',
              background: 'rgba(107,79,31,0.08)',
              border: '1px solid var(--paper-shadow)',
              padding: 0,
              borderRadius: 2,
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                padding: '8px 12px',
                color: 'var(--paper-deep)',
                fontSize: 10,
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              展开 / 折叠 ({factory.systemPromptTemplate.length} 字符)
            </summary>
            <pre
              style={{
                margin: 0,
                padding: 12,
                borderTop: '1px solid var(--paper-shadow)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-chrome)',
                fontSize: 11,
                lineHeight: 1.6,
                color: 'var(--ink-brown)',
                maxHeight: 480,
                overflow: 'auto',
              }}
            >
              {factory.systemPromptTemplate}
            </pre>
          </details>
        </Section>

        <p
          style={{
            marginTop: 24,
            fontSize: 13,
            color: 'var(--ink-brown-d)',
            fontStyle: 'italic',
          }}
        >
          工厂 yaml 在 apps/server/src/domain/factory/defaults/{factory.name}.yaml · 编辑 UI 还在 hold,目前只读
        </p>
        </div>
      </div>
    </div>
  )
}

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section style={{ marginTop: 20 }}>
    <h2 style={{ marginBottom: 8, color: 'var(--paper-deep)', fontSize: 18 }}>
      {title}
    </h2>
    <div
      style={{
        background: 'rgba(234,216,168,0.22)',
        border: '1px solid rgba(156,126,63,0.38)',
        padding: 14,
        borderRadius: 2,
      }}
    >
      {children}
    </div>
  </section>
)

const ModelProfileRow: FC<{
  label: string
  modelProfile: AgentModelProfile
  available?: boolean
  reason?: string
}> = ({ label, modelProfile, available, reason }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '86px 1fr auto',
      gap: 8,
      alignItems: 'center',
      color: 'var(--ink-brown)',
      fontSize: 13,
      border: '1px solid var(--paper-shadow)',
      background: 'rgba(107,79,31,0.08)',
      padding: '7px 9px',
      borderRadius: 2,
    }}
  >
    <span className="ab-eyebrow" style={{ color: 'var(--paper-deep)' }}>{label}</span>
    <span className="ab-tabular" style={{ minWidth: 0, wordBreak: 'break-word' }}>
      {modelProfile.provider}
      {modelProfile.model ? ` / ${modelProfile.model}` : ''}
      {modelProfile.reasoningEffort ? ` / ${modelProfile.reasoningEffort}` : ''}
    </span>
    <span
      title={reason}
      style={{
        color: available === false ? 'var(--malice)' : 'var(--link)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
      }}
    >
      {available === false ? 'unavailable' : available === true ? 'local' : 'unknown'}
    </span>
  </div>
)

const UsageSummary: FC<{
  total: number
  items: Array<{ id: string; label: string; totalTokens: number }>
  emptyText: string
}> = ({ total, items, emptyText }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div
      className="ab-tabular"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        color: 'var(--paper-deep)',
        fontSize: 13,
      }}
    >
      <span className="ab-eyebrow">total</span>
      <strong>{formatTokenCount(total)}</strong>
    </div>
    {items.length === 0 ? (
      <span style={{ color: 'var(--ink-brown-d)', fontSize: 13, fontStyle: 'italic' }}>
        ({emptyText})
      </span>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 10,
              alignItems: 'center',
              border: '1px solid var(--paper-shadow)',
              background: 'rgba(107,79,31,0.08)',
              padding: '6px 8px',
              borderRadius: 2,
            }}
          >
            <span style={{ color: 'var(--ink-brown)', fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            <span className="ab-tabular" style={{ color: 'var(--paper-deep)', fontSize: 12 }}>
              {formatTokenCount(item.totalTokens)}
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
)

const ChipRow: FC<{ items: string[]; variant?: 'default' | 'core' | 'name' }> = ({
  items,
  variant = 'default',
}) => {
  const styles = {
    default: {
      bg: 'rgba(107,79,31,0.08)',
      border: 'var(--paper-shadow)',
      color: 'var(--paper-deep)',
    },
    core: {
      bg: 'rgba(156,126,63,0.14)',
      border: 'var(--paper-deep)',
      color: 'var(--paper-deep)',
    },
    name: {
      bg: 'transparent',
      border: 'var(--paper-shadow)',
      color: 'var(--ink-brown)',
    },
  }
  const s = styles[variant]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((item) => (
        <span
          key={item}
          style={{
            fontSize: 11,
            color: s.color,
            background: s.bg,
            border: `1px solid ${s.border}`,
            padding: '3px 8px',
            fontFamily: 'var(--font-chrome)',
            letterSpacing: '0.04em',
            borderRadius: 2,
          }}
        >
          {item}
        </span>
      ))}
    </div>
  )
}

const CenteredMessage: FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12,
      color: 'var(--ink-dim)',
    }}
  >
    {text}
  </div>
)

import type { FC } from 'react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { GlobalUsageResponse, TokenUsageRankingItem } from '@agent-team/protocol'
import { restClient } from '../../../shared/api/index.js'
import { formatTokenCount } from '../../../shared/lib/token-usage.js'

type SubTab = 'total' | 'factories' | 'tasks'

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'total', label: 'TOTAL' },
  { key: 'factories', label: 'FACTORIES' },
  { key: 'tasks', label: 'TASKS' },
]

export const UsageTab: FC = () => {
  const [sub, setSub] = useState<SubTab>('total')
  const { data, isLoading, error } = useQuery<GlobalUsageResponse>({
    queryKey: ['global-usage'],
    queryFn: () => restClient.get<GlobalUsageResponse>('/usage'),
    staleTime: 10_000,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* horizontal sub-tabs */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--slate-edge)',
        }}
      >
        {SUB_TABS.map((t) => {
          const isActive = t.key === sub
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSub(t.key)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '6px 10px',
                fontSize: 10,
                letterSpacing: '0.18em',
                fontWeight: 600,
                color: isActive ? 'var(--cyan-bright)' : 'var(--ink-dim)',
                borderBottom: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`,
                marginBottom: -1,
                fontFamily: 'var(--font-chrome)',
                textShadow: isActive ? '0 0 4px var(--cyan-glow)' : 'none',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {isLoading && <Hint text="加载中…" />}
      {error && <Hint text={`加载失败:${(error as Error).message}`} />}
      {data && sub === 'total' && <TotalView data={data} />}
      {data && sub === 'factories' && <RankingTable items={data.factories} firstHeader="factory" />}
      {data && sub === 'tasks' && <RankingTable items={data.tasks} firstHeader="task" />}
    </div>
  )
}

const Hint: FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      padding: '20px 0',
      fontSize: 12,
      color: 'var(--ink-dim)',
      fontStyle: 'italic',
      textAlign: 'center',
    }}
  >
    {text}
  </div>
)

/** 5 行 KV + 一条分隔 + TOTAL(大数字精确) */
const TotalView: FC<{ data: GlobalUsageResponse }> = ({ data }) => {
  const t = data.runtime
  const rows: Array<[string, number]> = [
    ['input', t.inputTokens],
    ['cache input', t.cacheCreationTokens],
    ['output', t.outputTokens],
    ['cache output', t.cacheReadTokens],
  ]
  return (
    <dl
      style={{
        margin: 0,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        rowGap: 7,
        columnGap: 14,
        fontSize: 12,
      }}
    >
      {rows.map(([label, v]) => (
        <RowKV key={label} label={label} value={formatTokenCount(v)} />
      ))}
      <div
        style={{
          gridColumn: '1 / -1',
          borderTop: '1px dashed var(--slate-edge)',
          marginTop: 4,
          paddingTop: 6,
        }}
      />
      <RowKV label="TOTAL" value={formatTokenCount(t.totalTokens)} emphasize />
    </dl>
  )
}

const RowKV: FC<{ label: string; value: string; emphasize?: boolean }> = ({
  label,
  value,
  emphasize,
}) => (
  <>
    <dt
      className={emphasize ? 'ab-hud' : ''}
      style={{
        margin: 0,
        color: emphasize ? 'var(--ink-white)' : 'var(--ink-dim)',
        letterSpacing: emphasize ? '0.18em' : '0.06em',
        fontSize: emphasize ? 11 : 12,
        textTransform: emphasize ? 'uppercase' : 'none',
      }}
    >
      {label}
    </dt>
    <dd
      className="ab-tabular"
      style={{
        margin: 0,
        textAlign: 'right',
        color: emphasize ? 'var(--cyan-bright)' : 'var(--ink-soft)',
        fontWeight: emphasize ? 700 : 500,
        fontSize: emphasize ? 14 : 12,
      }}
    >
      {value}
    </dd>
  </>
)

/** ranking 表 — top 10,5 列(input / cin / out / cout / TOTAL)*/
const RankingTable: FC<{ items: TokenUsageRankingItem[]; firstHeader: string }> = ({
  items,
  firstHeader,
}) => {
  if (items.length === 0) {
    return <Hint text="暂无数据" />
  }
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 11,
      }}
    >
      <thead>
        <tr>
          <Th align="left">{firstHeader}</Th>
          <Th>input</Th>
          <Th>cin</Th>
          <Th>out</Th>
          <Th>cout</Th>
          <Th>TOTAL</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <Td align="left" title={it.label} truncate>
              {it.label}
            </Td>
            <Td>{formatTokenCount(it.inputTokens)}</Td>
            <Td>{formatTokenCount(it.cacheCreationTokens)}</Td>
            <Td>{formatTokenCount(it.outputTokens)}</Td>
            <Td>{formatTokenCount(it.cacheReadTokens)}</Td>
            <Td emphasize>{formatTokenCount(it.totalTokens)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const Th: FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({
  children,
  align = 'right',
}) => (
  <th
    className="ab-eyebrow"
    style={{
      textAlign: align,
      padding: '6px 6px',
      borderBottom: '1px solid var(--slate-edge)',
      color: 'var(--ink-dim)',
      fontSize: 9,
      letterSpacing: '0.14em',
      fontWeight: 600,
    }}
  >
    {children}
  </th>
)

const Td: FC<{
  children: React.ReactNode
  align?: 'left' | 'right'
  emphasize?: boolean
  truncate?: boolean
  title?: string
}> = ({ children, align = 'right', emphasize, truncate, title }) => (
  <td
    className={align === 'right' ? 'ab-tabular' : ''}
    title={title}
    style={{
      textAlign: align,
      padding: '5px 6px',
      borderBottom: '1px solid var(--slate-edge)',
      color: emphasize ? 'var(--cyan-bright)' : 'var(--ink-soft)',
      fontWeight: emphasize ? 700 : 400,
      maxWidth: truncate ? 120 : undefined,
      overflow: truncate ? 'hidden' : undefined,
      textOverflow: truncate ? 'ellipsis' : undefined,
      whiteSpace: truncate ? 'nowrap' : undefined,
    }}
  >
    {children}
  </td>
)

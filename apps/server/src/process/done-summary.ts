import type { DbClient } from '../db/client.js'

/**
 * 任务 done 后的 chatroom 系统总结 — 纯渲染,从 task DB 拉数据拼 markdown,
 * 不带任何 lifecycle / IPC side effect。
 *
 * 抽出的好处:
 * - task-process-entry 减一段 90 行混合 SQL + 拼字符串的逻辑
 * - 后续若要在 REST /tasks/:id/summary 暴露同样信息,直接复用本函数
 * - 测试只需 mock DbClient,不用拉起 task-process
 */

const MR_REGEX = /https?:\/\/[^\s)`'"]+(?:\/pull\/\d+|\/-?\/?merge_requests\/\d+|\/pull-requests\/\d+)/g

export function buildDoneSummaryMarkdown(
  db: DbClient,
  taskId: string,
  fromState: string,
): string {
  const meta = db.prepare('SELECT title, created_at FROM tasks_meta WHERE id = ?').get(taskId) as
    | { title: string; created_at: string }
    | undefined
  const title = meta?.title ?? taskId
  const durationStr = meta?.created_at
    ? formatDuration(Date.now() - new Date(meta.created_at).getTime())
    : '?'

  const hist = db
    .prepare('SELECT from_state, to_state FROM state_history WHERE task_id = ? ORDER BY version')
    .all(taskId) as { from_state: string; to_state: string }[]
  const path = hist.length === 0
    ? `${fromState} → done`
    : [hist[0]!.from_state, ...hist.map((h) => h.to_state)].join(' → ')

  const resources = db
    .prepare('SELECT id, provider, status, path, summary FROM bootstrap_resources WHERE task_id = ?')
    .all(taskId) as {
    id: string
    provider: string
    status: string
    path: string | null
    summary: string | null
  }[]

  const artifacts = db
    .prepare('SELECT id, path, type FROM artifacts WHERE task_id = ?')
    .all(taskId) as { id: string; path: string; type: string }[]

  // SQL LIKE 预过滤候选行,避免在长 chatroom 上 regex 全表扫描
  const candidates = db
    .prepare(
      `SELECT content FROM chatroom_messages
       WHERE task_id = ? AND channel = 'main' AND type IN ('agent-text','human-msg')
         AND (content LIKE '%pull/%' OR content LIKE '%merge_requests/%' OR content LIKE '%pull-requests/%')`,
    )
    .all(taskId) as { content: string }[]
  const mrUrls = new Set<string>()
  for (const m of candidates) {
    const matches = m.content.match(MR_REGEX)
    if (matches) for (const u of matches) mrUrls.add(u)
  }

  const lines: string[] = [`✅ **任务已完成** — ${title}`, '', `- 用时:${durationStr}`, `- 状态轨迹:\`${path}\``]

  if (resources.length > 0) {
    lines.push('- 资源终态:')
    for (const r of resources) {
      const tail = r.path ? ` · \`${r.path}\`` : ''
      const note = r.summary ? ` — ${r.summary}` : ''
      lines.push(`  - \`${r.id}\` (${r.provider}) → **${r.status}**${tail}${note}`)
    }
  }

  const retroArtifacts = artifacts.filter((a) => a.path.startsWith('retro/') || a.type === 'retrospective')
  const otherCount = artifacts.length - retroArtifacts.length
  if (retroArtifacts.length > 0) {
    lines.push('- 收尾文档:')
    for (const a of retroArtifacts) lines.push(`  - \`${a.path}\` (\`${a.id}\`)`)
  }
  if (otherCount > 0) {
    lines.push(`- 其它制品:${otherCount} 份(plan / eng / qa 等,详见 artifact_list)`)
  }

  if (mrUrls.size > 0) {
    lines.push('- MR / PR 链接:')
    for (const u of mrUrls) lines.push(`  - ${u}`)
  }

  return lines.join('\n')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}

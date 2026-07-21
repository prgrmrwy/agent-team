#!/usr/bin/env node
import { createHash } from 'node:crypto'

const args = parseArgs(process.argv.slice(2))

const token = args.token ?? process.env.AGENT_TEAM_TOKEN
const port = args.port ?? process.env.PORT ?? '3001'
const taskId = args.taskId ?? process.env.TASK_ID
const agentId = args.agentId ?? process.env.AGENT_ID
const phase = args.phase ?? 'unknown'
const toolName =
  args.toolName ?? process.env.CLAUDE_TOOL_NAME ?? process.env.CODEX_TOOL_NAME ?? 'unknown'
const rawArgs = args.args ?? process.env.CLAUDE_TOOL_ARGS ?? process.env.CODEX_TOOL_ARGS ?? ''

if (!token || !taskId || !agentId) {
  process.stderr.write('at-hook: missing token, task-id, or agent-id\n')
  process.exit(0)
}

const secret = createHash('sha256').update(`${token}hook`).digest('hex').slice(0, 16)
const action = inferAction(toolName)
const ref = inferRef(rawArgs, toolName, phase)

try {
  const response = await fetch(`http://localhost:${port}/internal/at-hook/${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId,
      agentId,
      action,
      ref,
      ts: new Date().toISOString(),
    }),
  })

  if (!response.ok) {
    process.stderr.write(`at-hook: server returned ${response.status}\n`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`at-hook: ${message}\n`)
}

process.exit(0)

function parseArgs(argv) {
  const out = {}
  const positional = []

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (!current.startsWith('--')) {
      positional.push(current)
      continue
    }

    const key = current.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = 'true'
    }
  }

  const [agentId, phase, toolName, rawArgs, token] = positional
  return {
    agentId: out.agentId ?? agentId,
    taskId: out.taskId,
    phase: out.phase ?? phase,
    toolName: out.toolName ?? toolName,
    args: out.args ?? rawArgs,
    token: out.token ?? token,
    port: out.port,
  }
}

function inferAction(toolName) {
  const normalized = toolName.toLowerCase()
  if (normalized.includes('read') || normalized.includes('open') || normalized.includes('cat'))
    return 'read-file'
  if (normalized.includes('websearch') || normalized.includes('search')) return 'websearch'
  if (normalized.includes('webfetch') || normalized.includes('fetch')) return 'webfetch'
  if (normalized.includes('mcp')) return 'mcp-call'
  if (normalized.includes('skill')) return 'skill-load'
  return 'run-cmd'
}

function inferRef(rawArgs, toolName, phase) {
  if (!rawArgs) return `${phase}:${toolName}`
  try {
    const parsed = JSON.parse(rawArgs)
    if (typeof parsed === 'string') return parsed.slice(0, 500)
    for (const key of ['file_path', 'path', 'cmd', 'command', 'url', 'query', 'ref_id']) {
      if (typeof parsed?.[key] === 'string') return parsed[key].slice(0, 500)
    }
  } catch {
    // Fall back to raw text below.
  }
  return String(rawArgs).slice(0, 500)
}

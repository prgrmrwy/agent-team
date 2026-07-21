import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ThreadEvent } from '@openai/codex-sdk'
import { mapCodexEvent } from './codex-event-mapper.js'

export interface CodexPreflightResult {
  ok: boolean
  version?: string
  warnings: string[]
  errors: string[]
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export async function runCodexPreflight(opts: {
  codexBin?: string
  cwd?: string
  runSmoke?: boolean
} = {}): Promise<CodexPreflightResult> {
  const codexBin = opts.codexBin ?? process.env['AGENT_TEAM_CODEX_BIN'] ?? 'codex'
  const cwd = opts.cwd ?? process.cwd()
  const warnings: string[] = []
  const errors: string[] = []

  const version = await runCommand(codexBin, ['--version'], { cwd })
  if (version.code !== 0) {
    errors.push(`codex --version failed: ${firstNonEmpty(version.stderr, version.stdout)}`)
    return { ok: false, warnings, errors }
  }

  const doctor = await runCommand(codexBin, ['doctor', '--json'], { cwd, timeoutMs: 30_000 })
  if (doctor.stdout.trim()) {
    inspectDoctorJson(doctor.stdout, warnings, errors)
  } else if (doctor.code !== 0) {
    errors.push(`codex doctor --json failed: ${firstNonEmpty(doctor.stderr, doctor.stdout)}`)
  }

  if (opts.runSmoke ?? true) {
    const smoke = await runCommand(
      codexBin,
      [
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--config',
        'approval_policy="never"',
        'Reply exactly CODEX_OK.',
      ],
      { cwd, timeoutMs: 120_000 }
    )
    if (smoke.code !== 0) {
      errors.push(`codex exec smoke failed: ${firstNonEmpty(smoke.stderr, smoke.stdout)}`)
    } else {
      const parsed = parseCodexExecJsonl(smoke.stdout)
      if (parsed.errors.length > 0) {
        errors.push(...parsed.errors)
      }
      if (!parsed.text.includes('CODEX_OK')) {
        errors.push('codex exec smoke did not include CODEX_OK in agent message output')
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: version.stdout.trim(),
    warnings,
    errors,
  }
}

export function parseCodexExecJsonl(stdout: string): { text: string; errors: string[] } {
  const text: string[] = []
  const errors: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: ThreadEvent
    try {
      event = JSON.parse(line) as ThreadEvent
    } catch {
      errors.push(`codex exec emitted non-JSONL line: ${line.slice(0, 120)}`)
      continue
    }
    const action = mapCodexEvent(event)
    if (action?.kind === 'text') text.push(action.text)
    if (action?.kind === 'runtime-error') errors.push(action.message)
  }
  return { text: text.join('\n'), errors }
}

function inspectDoctorJson(stdout: string, warnings: string[], errors: string[]): void {
  let report: { checks?: Record<string, { status?: string; summary?: string; category?: string }> }
  try {
    report = JSON.parse(stdout) as typeof report
  } catch {
    warnings.push('codex doctor --json returned non-JSON output')
    return
  }
  for (const check of Object.values(report.checks ?? {})) {
    if (check.status !== 'fail') continue
    const summary = check.summary ?? 'unknown failure'
    if (check.category === 'terminal') {
      warnings.push(`doctor terminal warning: ${summary}`)
    } else {
      errors.push(`doctor ${check.category ?? 'check'} failed: ${summary}`)
    }
  }
}

function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 15_000)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ code: 1, stdout: '', stderr: err.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      })
    })
  })
}

function firstNonEmpty(a: string, b: string): string {
  return (a.trim() || b.trim()).slice(0, 1000)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runCodexPreflight({ cwd: process.cwd(), runSmoke: true })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

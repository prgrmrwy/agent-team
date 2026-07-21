/**
 * 组 14.2: ACP adapter 实现
 * bootstrap-notes #4-#10 实测结论的正式落地：
 *   - bridge = @zed-industries/claude-code-acp (bin claude-code-acp)
 *   - driving = @agentclientprotocol/sdk ClientSideConnection
 *   - 鉴权：继承当前环境（Keychain 订阅登录，无需 API key）
 *   - 注入走 session/new 参数：cwd + additionalDirectories + mcpServers
 *
 * 注意：单元测试用 FakeCliAdapter（见测试文件），不启动真实 bridge。
 * 真实联调由架构师验收。
 */

import { EventEmitter } from 'node:events'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import type { CliAdapter, RuntimeProvider, SpawnOpts } from './cli-adapter.js'
import { toRuntimeErrorEvent } from './cli-adapter.js'
import { mapAcpUpdate } from './event-mapper.js'

// ACP SDK 类型（动态 import 以支持测试时 mock）
// 实际 import 在 createAcpAdapter 工厂函数内执行

/** ACP session/new 支持的 MCP server 声明（stdio + http + sse 联合）*/
type AcpEnvVar = { name: string; value: string }
type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: AcpEnvVar[] }
  | { type: 'http'; name: string; url: string; headers: AcpEnvVar[] }
  | { type: 'sse'; name: string; url: string; headers: AcpEnvVar[] }

type ClientSideConnectionType = {
  initialize(opts: {
    protocolVersion: number
    clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean } }
  }): Promise<void>
  newSession(opts: {
    cwd: string
    additionalDirectories: string[]
    mcpServers: AcpMcpServer[]
  }): Promise<{ sessionId: string }>
  prompt(opts: {
    sessionId: string
    prompt: Array<{ type: 'text'; text: string }>
  }): Promise<{ stopReason: string }>
}

/** 单个 session 的内部状态 */
interface SessionState {
  sessionId: string
  bridgeProcess: ChildProcess
  conn: ClientSideConnectionType
}

/**
 * ACP adapter 实现（EventEmitter）。
 * 一次 spawn() 对应一个 bridge 进程 + 一个 ACP session。
 *
 * NOTE: 多次 prompt() 复用同一 session（ACP 有状态会话）。
 *
 * bridge 的 agentCapabilities 含 loadSession/fork/resume，
 * crash 重 spawn 时可 resume 会话 —— M1 先不用，留注释备后续实现。
 */
export class AcpAdapter extends EventEmitter implements CliAdapter {
  readonly provider: RuntimeProvider = 'claude-acp'

  private sessions = new Map<string, SessionState>()

  async spawn(opts: SpawnOpts): Promise<string> {
    const {
      workspace,
      additionalDirectories,
      mcpServers,
      initialPrompt,
      env: extraEnv,
    } = opts

    // 继承当前环境（复用 Keychain 订阅登录），但剥掉「我在 Claude Code 会话内」的标记，
    // 否则内嵌的 Agent SDK 会报 "Claude Code cannot be launched inside another Claude Code session"。
    // （bootstrap-notes：spike 实测发现，开发态在 Claude Code 内启动 bridge 必须剥这些 env。）
    const env = {
      ...process.env,
      ...extraEnv,
    } as Record<string, string>
    for (const k of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_AGENT_SDK_VERSION',
    ]) {
      delete env[k]
    }

    // 启动 bridge
    const bridgeProcess = nodeSpawn('claude-code-acp', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    // 桥接进程 stderr → 日志（不崩）
    bridgeProcess.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[acp-bridge] ${chunk.toString()}`)
    })

    // bridge 意外退出时发出 exit 事件
    bridgeProcess.on('exit', (code, signal) => {
      // 找出哪个 sessionId 对应此 bridge
      for (const [sid, state] of this.sessions) {
        if (state.bridgeProcess === bridgeProcess) {
          this.emit('exit', { sessionId: sid, code, signal })
          this.sessions.delete(sid)
          break
        }
      }
    })

    // 建立 ACP 连接
    let conn: ClientSideConnectionType

    try {
      // 动态 import ACP SDK（避免在测试时强依赖真实包）
      const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import(
        '@agentclientprotocol/sdk'
      )

      const stdin = bridgeProcess.stdin!
      const stdout = bridgeProcess.stdout!

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout as any))

      // client 处理器：处理 sessionUpdate + requestPermission
      // 用 unknown 转型绕过 ACP SDK 内部类型（SDK 类型与实测 spike 行为一致，但 TS 类型较严格）
      const adapter = this
      // biome-ignore lint/suspicious/noExplicitAny: ACP SDK 内部类型需要绕过
      const clientHandlerFactory: any = () => ({
        async sessionUpdate(params: Record<string, unknown>) {
          // 把流式事件抛出去，供 task-process-entry 记日志 + 映射进 chatroom（拿回 agent 可见性）
          const sessionId = params['sessionId'] as string | undefined
          const update = params['update'] as Record<string, unknown> | undefined
          adapter.emit('update', {
            sessionId,
            update,
          })
          const normalizedSessionId = sessionId ?? 'unknown-session'
          const action = mapAcpUpdate(normalizedSessionId, update ?? {})
          if (!action) return
          if (action.kind === 'append-text') {
            adapter.emit('text', { sessionId: normalizedSessionId, text: action.text, kind: 'message' })
          } else if (action.kind === 'append-thought') {
            adapter.emit('text', { sessionId: normalizedSessionId, text: action.text, kind: 'thought' })
          } else if (action.kind === 'tool-trace') {
            adapter.emit('tool', {
              sessionId: normalizedSessionId,
              title: action.title,
              rawInput: action.rawInput,
              toolCallId: action.toolCallId,
            })
          }
        },
        async requestPermission(params: Record<string, unknown>) {
          // M1: 自动选择第一个选项（架构师验收时可改为询问人类）
          const options = params['options'] as Array<{ optionId: string }> | undefined
          return {
            outcome: {
              outcome: 'selected',
              optionId: options?.[0]?.optionId ?? '',
            },
          }
        },
        async readTextFile() {
          return { content: '' }
        },
        async writeTextFile() {
          return {}
        },
      })

      conn = new ClientSideConnection(clientHandlerFactory, stream) as unknown as ClientSideConnectionType

      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION as unknown as number,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })

      // 规整 mcpServers 成 ACP 要求的形态：
      //  - http/sse 必带 headers[]
      //  - stdio（无 type）必带 env 为 EnvVariable[]（{name,value}），把 Record 转成数组
      // biome-ignore lint/suspicious/noExplicitAny: ACP SDK 入参形态在此本地规整
      const normalizedMcps = (mcpServers as any[]).map((s) => {
        if (s.type === 'http') return { type: 'http', name: s.name, url: s.url, headers: s.headers ?? [] }
        if (s.type === 'sse') return { type: 'sse', name: s.name, url: s.url, headers: s.headers ?? [] }
        const envArr = Array.isArray(s.env)
          ? s.env
          : Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value: String(value) }))
        return { name: s.name, command: s.command, args: s.args ?? [], env: envArr }
      })

      const { sessionId } = await conn.newSession({
        cwd: workspace,
        additionalDirectories,
        mcpServers: normalizedMcps as AcpMcpServer[],
      })

      this.sessions.set(sessionId, { sessionId, bridgeProcess, conn })

      if (initialPrompt.trim()) {
        this.prompt(sessionId, initialPrompt).catch((err) => {
          this.emit('runtime-error', toRuntimeErrorEvent(this.provider, err, { sessionId }))
        })
      }

      return sessionId
    } catch (err) {
      // bridge 启动失败，清理进程
      bridgeProcess.kill('SIGKILL')
      throw err
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      this.emit(
        'runtime-error',
        toRuntimeErrorEvent(this.provider, new Error(`session not found: ${sessionId}`), {
          sessionId,
          reason: 'session-not-found',
        })
      )
      return
    }

    try {
      const result = await state.conn.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      })
      this.emit('done', { sessionId, stopReason: result.stopReason })
    } catch (err) {
      this.emit('runtime-error', toRuntimeErrorEvent(this.provider, err, { sessionId }))
      throw err
    }
  }

  pause(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.bridgeProcess.kill('SIGSTOP')
  }

  resume(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.bridgeProcess.kill('SIGCONT')
  }

  /** 人类打断:ACP 无 per-turn cancel,best-effort 用 SIGSTOP 冻结(resume 时 SIGCONT 续)。 */
  interrupt(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.bridgeProcess.kill('SIGSTOP')
  }

  async kill(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return

    // SIGTERM → 5s 超时 → SIGKILL
    return new Promise<void>((resolve) => {
      const proc = state.bridgeProcess
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL')
        this.sessions.delete(sessionId)
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(timeout)
        this.sessions.delete(sessionId)
        resolve()
      })

      proc.kill('SIGTERM')
    })
  }

  isAlive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (!state) return false
    return state.bridgeProcess.exitCode === null && state.bridgeProcess.killed === false
  }
}

/**
 * 工厂函数（方便测试时替换）。
 * process 层通过此函数创建 adapter 实例。
 */
export function createAcpAdapter(): AcpAdapter {
  return new AcpAdapter()
}

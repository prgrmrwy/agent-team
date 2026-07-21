/**
 * 组 14.x: Computer 抽象（add-computer-abstraction change）
 * Computer = 运行 agent 运行时 + 执行本地能力的一台机器（本地或远程）。
 * 与 CliAdapter 分层：Computer 管"位置/传输"，CliAdapter 管"provider 协议"。
 * M1 只落抽象缝（接口 + 按 agent 级解析 + LocalComputer），RemoteComputer 后续。
 *
 * 纪律：本文件只定义接口 + 纯解析逻辑，不 import 任何实现（LocalComputer 在 local-computer.ts）。
 */

import type { CliAdapter, RuntimeProvider } from './cli-adapter.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** 一台能跑 agent 运行时 + 执行本地能力的机器 */
export interface Computer {
  /** 'local' | 远程机器 id */
  readonly id: string
  /** 在这台机器上创建对应 provider 的 CliAdapter */
  createCliAdapter(provider: RuntimeProvider): CliAdapter
  /** 在这台机器上执行命令 */
  exec(argv: string[], opts?: { cwd?: string }): Promise<ExecResult>
}

export interface ResolveComputerOpts {
  /** seat 级 override（最高优先级）*/
  seatComputer?: string | undefined
  /** factory 级偏好 */
  factoryPreferredComputer?: string | undefined
  /** 环境变量来源（默认 process.env）*/
  env?: NodeJS.ProcessEnv
}

/**
 * 按 agent 级解析 computer id：
 * seat override → factory preferred → env AGENT_TEAM_COMPUTER → 默认 'local'。
 */
export function resolveComputerId(opts: ResolveComputerOpts = {}): string {
  const env = opts.env ?? process.env
  return (
    opts.seatComputer?.trim() ||
    opts.factoryPreferredComputer?.trim() ||
    env['AGENT_TEAM_COMPUTER']?.trim() ||
    'local'
  )
}

export class UnsupportedComputerError extends Error {
  constructor(readonly computerId: string) {
    super(`unsupported computer id: ${computerId}（RemoteComputer 尚未实现）`)
  }
}

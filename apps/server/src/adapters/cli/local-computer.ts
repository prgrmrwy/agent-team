/**
 * LocalComputer：server 同机执行（add-computer-abstraction change，M1）。
 * createCliAdapter 委托现有本机 createCliAdapter；exec 在本机执行命令。
 * 零行为变化：等价于抽象引入前的"同机直接 spawn"。
 */

import { execFile } from 'node:child_process'
import type { CliAdapter, RuntimeProvider } from './cli-adapter.js'
import { createCliAdapter } from './adapter-factory.js'
import {
  type Computer,
  type ExecResult,
  type ResolveComputerOpts,
  resolveComputerId,
  UnsupportedComputerError,
} from './computer.js'

export class LocalComputer implements Computer {
  readonly id = 'local'

  createCliAdapter(provider: RuntimeProvider): CliAdapter {
    return createCliAdapter(provider)
  }

  exec(argv: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
    const [cmd, ...args] = argv
    if (!cmd) return Promise.reject(new Error('exec: empty argv'))
    return new Promise<ExecResult>((resolve) => {
      execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
  }
}

const localComputer = new LocalComputer()

/** 返回进程内唯一的 LocalComputer 单例 */
export function getLocalComputer(): LocalComputer {
  return localComputer
}

/**
 * 解析使用哪个 Computer（按 agent 级）。M1 只支持 'local'；其余 id 抛错（RemoteComputer 后续）。
 */
export function resolveComputer(opts: ResolveComputerOpts = {}): Computer {
  const id = resolveComputerId(opts)
  if (id === 'local') return localComputer
  throw new UnsupportedComputerError(id)
}

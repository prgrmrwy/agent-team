/**
 * 组 16.5: process-pool.ts
 * M1 设 2 个并发 task 上限（可配，生产目标 20）+ 排队。
 *
 * agent-runtime spec "进程池容量与心跳"：
 *   超过上限的新 task SHALL 排队；
 *   池容量通过 maxConcurrent 配置。
 */

export interface ProcessPoolEntry {
  taskId: string
  /** 任务启动函数（pool 决定何时执行）*/
  start: () => Promise<void>
}

export interface ProcessPoolOpts {
  /** 最大并发 task 数（M1 默认 2）*/
  maxConcurrent?: number
}

/**
 * 进程池：限制并发 task 数量，超出时排队。
 *
 * 使用方法：
 *   1. pool.submit(taskId, startFn) → 返回 Promise，当 startFn 执行完毕时 resolve
 *   2. pool.release(taskId) → task 结束时调用，允许队列中的下一个进入
 */
export class ProcessPool {
  private maxConcurrent: number
  private active = new Map<string, true>()
  private queue: Array<{ taskId: string; resolve: () => void; reject: (e: Error) => void }> = []

  constructor(opts: ProcessPoolOpts = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 2
  }

  /** 当前活跃 task 数 */
  get activeCount(): number {
    return this.active.size
  }

  /** 当前排队 task 数 */
  get queuedCount(): number {
    return this.queue.length
  }

  /** 是否还能接受新 task */
  get hasCapacity(): boolean {
    return this.active.size < this.maxConcurrent
  }

  /**
   * 提交新 task。
   * 若有容量，立即调用 startFn；否则排队等待。
   * 若排队中已有相同 taskId，拒绝。
   *
   * @throws Error 若已达上限且调用方选择不排队（M1 WS handler 场景）
   */
  async submit(taskId: string, startFn: () => Promise<void>): Promise<void> {
    if (this.active.has(taskId)) {
      throw new Error(`task ${taskId} is already active`)
    }

    if (this.queue.some((q) => q.taskId === taskId)) {
      throw new Error(`task ${taskId} is already queued`)
    }

    if (this.active.size >= this.maxConcurrent) {
      // 排队
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ taskId, resolve, reject })
      })
    }

    this.active.set(taskId, true)
    try {
      await startFn()
    } finally {
      // startFn 结束（无论成功失败），不自动 release
      // release 由调用方在 task-process 真正退出时显式调用
    }
  }

  /**
   * 释放槽位（task 结束时调用）。
   * 若队列非空，自动拉起队列头部的 task。
   */
  release(taskId: string): void {
    this.active.delete(taskId)

    // 拉起队列头部
    const next = this.queue.shift()
    if (next) {
      next.resolve()
    }
  }

  /**
   * 取消排队中的 task（task 被 abort 但还未进入 active 时调用）。
   */
  cancelQueued(taskId: string): boolean {
    const idx = this.queue.findIndex((q) => q.taskId === taskId)
    if (idx === -1) return false

    const [entry] = this.queue.splice(idx, 1)
    entry!.reject(new Error(`task ${taskId} cancelled before starting`))
    return true
  }

  /** 强制移除 active task（crash 时调用，不触发 queue）*/
  forceRemove(taskId: string): void {
    this.active.delete(taskId)
  }
}

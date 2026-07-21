/**
 * 组 10: factory-loader.ts
 * 扫描 ~/.agent-team/factories/*.yaml，zod 校验，注入内存 registry。
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Factory } from '@agent-team/protocol'
import { Factory as FactorySchema } from '@agent-team/protocol'
import type { Logger } from '../../util/logger.js'

/** 内存 registry：factory name → Factory */
const registry = new Map<string, Factory>()

/**
 * 加载给定目录下的所有 *.yaml 工厂文件。
 * 失败的单个文件记 ERROR 日志，不阻止其他文件加载。
 */
export function loadFactories(factoriesDir: string, log: Logger): void {
  registry.clear()

  if (!fs.existsSync(factoriesDir)) {
    log.warn({ factoriesDir }, 'factories dir not found, skipping')
    return
  }

  const files = fs.readdirSync(factoriesDir).filter((f) => f.endsWith('.yaml') && !f.includes('.v'))

  for (const file of files) {
    const filePath = path.join(factoriesDir, file)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = yaml.load(raw)
      const result = FactorySchema.safeParse(parsed)
      if (!result.success) {
        log.error({ file, errors: result.error.flatten() }, 'factory yaml validation failed')
        continue
      }
      registry.set(result.data.name, result.data)
      log.info({ name: result.data.name, version: result.data.version, file }, 'factory loaded')
    } catch (err) {
      log.error({ file, err }, 'failed to read/parse factory yaml')
    }
  }
}

/** 从内存 registry 获取工厂（未加载则 undefined）*/
export function getFactory(name: string): Factory | undefined {
  return registry.get(name)
}

/** 获取所有已加载工厂 */
export function getAllFactories(): Factory[] {
  return Array.from(registry.values())
}

/** 直接注入（测试用）*/
export function _registerFactory(f: Factory): void {
  registry.set(f.name, f)
}

/** 清空 registry（测试用）*/
export function _clearRegistry(): void {
  registry.clear()
}

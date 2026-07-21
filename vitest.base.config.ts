import { defineConfig } from 'vitest/config'

/**
 * 共享 vitest 基础配置。各 package 的 vitest.config.ts 通过
 * `mergeConfig(base, {...})` 复用本配置（见 packages/protocol）。
 * 决策见 design.md Open Question 3。
 */
export const baseConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})

export default baseConfig

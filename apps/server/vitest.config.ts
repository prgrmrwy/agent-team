import { mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.base.config.ts'

export default mergeConfig(baseConfig, {
  test: {
    name: 'server',
  },
})

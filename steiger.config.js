import { defineConfig } from 'steiger'
import fsd from '@feature-sliced/steiger-plugin'

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // 骨架阶段（Wave 1）：features/widgets/pages 多为 Wave 2 stub，
    // entities/* 暂无消费方属预期增量状态。关掉"无引用建议删除"噪声，
    // Wave 2 接入消费方后这些 slice 自然被引用。
    rules: {
      'fsd/insignificant-slice': 'off',
    },
  },
])

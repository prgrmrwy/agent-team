export type {
  Message,
  MessageType,
  Channel,
} from '@agent-team/protocol'

import type { Channel } from '@agent-team/protocol'

export const CHANNEL_LABEL: Record<Channel, string> = {
  main: '主频道',
  'eng-internal': 'Engineer 内部',
  'tool-traces': '工具调用',
  mentions: '@提及',
}

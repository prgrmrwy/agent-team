import { describe, expect, it } from 'vitest'
import {
  collectAttributes,
  normalizeClaudeTelemetryPayload,
  normalizeCodexUsage,
} from './token-usage-normalizer.js'

describe('token usage normalizers', () => {
  it('normalizes Codex usage with cached input, reasoning output, and total tokens', () => {
    const usage = normalizeCodexUsage({
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
        reasoning_output_tokens: 9,
        total_tokens: 134,
      },
    })

    expect(usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 40,
      outputTokens: 25,
      reasoningTokens: 9,
      totalTokens: 134,
    })
  })

  it('normalizes Claude OTel JSON records with request id and resource attributes', () => {
    const payload = {
      resource: {
        attributes: {
          'agent_team.task_id': 'task-1',
          'agent_team.agent_id': 'agent-1',
        },
      },
      attributes: [
        { key: 'request_id', value: { stringValue: 'req-1' } },
        { key: 'input_tokens', value: { intValue: 100 } },
        { key: 'cache_creation_input_tokens', value: { intValue: 10 } },
        { key: 'cache_read_input_tokens', value: { intValue: 20 } },
        { key: 'output_tokens', value: { intValue: 30 } },
      ],
    }

    const attrs = collectAttributes(payload)
    expect(attrs['agent_team.task_id']).toBe('task-1')
    expect(attrs['agent_team.agent_id']).toBe('agent-1')

    const usage = normalizeClaudeTelemetryPayload(payload)
    expect(usage).toMatchObject({
      externalRequestId: 'req-1',
      inputTokens: 100,
      cacheCreationTokens: 10,
      cacheReadTokens: 20,
      outputTokens: 30,
      totalTokens: 160,
    })
  })

  it('returns null for telemetry records without token fields', () => {
    expect(normalizeClaudeTelemetryPayload({ attributes: [{ key: 'request_id', value: 'req-2' }] })).toBeNull()
  })
})

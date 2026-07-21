// Re-export protocol types for feature layers — they import from here, not directly from protocol
export type {
  Task,
  CreateTaskInput,
  TaskState,
  Project,
  Factory,
  FactoryRole,
  Seat,
  SeatSpec,
  SeatStatus,
  Agent,
  AgentRunState,
  Message,
  MessageType,
  Channel,
  Artifact,
  ArtifactType,
  ServerToClient,
  ClientToServer,
  ContextLink,
  StateTransition,
  TaskUsageResponse,
  ProjectUsageResponse,
  FactoryUsageResponse,
  AgentUsageResponse,
  TokenUsageRankingItem,
  TokenUsageTotals,
} from '@agent-team/protocol'

export { ApiError, restClient } from './rest-client.js'
export { wsClient } from './ws-client.js'

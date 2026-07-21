import { z } from 'zod'
import { TaskBootstrapInit } from '../domain/bootstrap.js'
import { Task, CreateTaskInput } from '../domain/task.js'
import { Project } from '../domain/project.js'
import { Factory } from '../domain/factory.js'
import {
  AgentUsageResponse,
  FactoryUsageResponse,
  ProjectUsageResponse,
  TaskUsageResponse,
} from '../domain/token-usage.js'

/**
 * REST 端点的 request/response 契约（proposal：HTTP 路由）。
 * 鉴权见 local-auth spec（Bearer / ?token=）。
 */

// POST /tasks
export const CreateTaskRequest = CreateTaskInput
/**
 * Task 创建响应同时包含 bootstrap 初始化状态(provider 实际用了什么、是否启动、初始 resource 快照)。
 * 旧字段保留在 Task 上;bootstrap 字段始终存在(provider=none 时 started=false)。
 */
export const CreateTaskResponse = Task.extend({
  bootstrap: TaskBootstrapInit,
})

// GET /tasks
export const ListTasksResponse = z.array(Task)

// GET /tasks/:id
export const GetTaskResponse = Task

// GET /projects
export const ListProjectsResponse = z.array(Project)

// GET /factories
export const ListFactoriesResponse = z.array(Factory)

// GET /tasks/:id/usage
export const GetTaskUsageResponse = TaskUsageResponse

// GET /tasks/:id/agents/:agentId/usage
export const GetAgentUsageResponse = AgentUsageResponse

// GET /projects/:id/usage
export const GetProjectUsageResponse = ProjectUsageResponse

// GET /factories/:name/usage
export const GetFactoryUsageResponse = FactoryUsageResponse

// PATCH /factories/:name
export const UpdateFactoryRequest = Factory.partial().omit({ name: true })
export const UpdateFactoryResponse = Factory

export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>
export type ListTasksResponse = z.infer<typeof ListTasksResponse>
export type GetTaskResponse = z.infer<typeof GetTaskResponse>
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>
export type ListFactoriesResponse = z.infer<typeof ListFactoriesResponse>
export type GetTaskUsageResponse = z.infer<typeof GetTaskUsageResponse>
export type GetAgentUsageResponse = z.infer<typeof GetAgentUsageResponse>
export type GetProjectUsageResponse = z.infer<typeof GetProjectUsageResponse>
export type GetFactoryUsageResponse = z.infer<typeof GetFactoryUsageResponse>
export type UpdateFactoryRequest = z.infer<typeof UpdateFactoryRequest>
export type UpdateFactoryResponse = z.infer<typeof UpdateFactoryResponse>

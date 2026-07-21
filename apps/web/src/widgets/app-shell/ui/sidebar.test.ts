import { describe, expect, it } from 'vitest'
import type { Project, Task } from '@agent-team/protocol'
import { findFirstVisibleTask } from './sidebar-task-filter.js'

const now = '2026-06-29T00:00:00.000Z'

const project = (id: string): Project => ({
  id,
  name: id,
  createdAt: now,
})

const task = (id: string, projectId: string, state: Task['state']): Task => ({
  id,
  projectId,
  title: id,
  description: id,
  contextLinks: [],
  state,
  history: [],
  stalled: false,
  createdAt: now,
  updatedAt: now,
})

describe('findFirstVisibleTask', () => {
  const projects = [project('alpha'), project('beta')]
  const tasks = [
    task('beta-active', 'beta', 'S6'),
    task('alpha-releasing', 'alpha', 'releasing'),
    task('alpha-done', 'alpha', 'done'),
    task('alpha-active', 'alpha', 'S2'),
  ]

  it('uses the same project-group order as the sidebar list', () => {
    expect(findFirstVisibleTask(tasks, projects, 'active')?.id).toBe('alpha-active')
    expect(findFirstVisibleTask(tasks, projects, 'releasing')?.id).toBe('alpha-releasing')
    expect(findFirstVisibleTask(tasks, projects, 'done')?.id).toBe('alpha-done')
  })

  it('returns the first visible task for all and null for empty filters', () => {
    expect(findFirstVisibleTask(tasks, projects, 'all')?.id).toBe('alpha-releasing')
    expect(findFirstVisibleTask([task('done-only', 'alpha', 'done')], projects, 'releasing')).toBeNull()
  })
})

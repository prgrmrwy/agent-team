import { type FC } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ProjectItem } from '../../../entities/project/index.js'
import { TaskCard } from '../../../entities/task/index.js'
import { restClient } from '../../../shared/api/index.js'
import type { Project, Task } from '@agent-team/protocol'

// currentTaskId used by tanstack-router active matching via Link component
interface ProjectNavProps {
  currentTaskId?: string
}

export const ProjectNav: FC<ProjectNavProps> = ({ currentTaskId }) => {
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => restClient.get<Project[]>('/projects'),
  })

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks'],
    queryFn: () => restClient.get<Task[]>('/tasks'),
  })

  return (
    <nav className="flex h-full flex-col overflow-y-auto border-r bg-background">
      <div className="px-3 py-3">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold hover:opacity-80">
          Agent Team
        </Link>
      </div>

      {/* 项目列表 */}
      {projects.map((project) => {
        const projectTasks = tasks.filter((t) => t.projectId === project.id)
        return (
          <div key={project.id} className="flex flex-col">
            <ProjectItem project={project} />
            {/* 该项目下的任务 */}
            <div className="pl-3 flex flex-col gap-0.5">
              {projectTasks.map((task) => (
                <Link
                  key={task.id}
                  to="/tasks/$taskId"
                  params={{ taskId: task.id }}
                  className="block"
                >
                  {({ isActive }) => (
                    <TaskCard
                      task={task}
                      active={isActive}
                    />
                  )}
                </Link>
              ))}
            </div>
          </div>
        )
      })}

      {projects.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          暂无项目。请检查 ~/.agent-team/projects/
        </div>
      )}
    </nav>
  )
}

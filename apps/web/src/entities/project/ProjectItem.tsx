import type { FC } from 'react'
import type { Project } from './model.js'

interface ProjectItemProps {
  project: Project
  active?: boolean
  onClick?: () => void
}

export const ProjectItem: FC<ProjectItemProps> = ({ project, active = false, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-accent font-medium' : 'hover:bg-accent',
      ].join(' ')}
    >
      <span className="truncate">{project.name}</span>
    </button>
  )
}

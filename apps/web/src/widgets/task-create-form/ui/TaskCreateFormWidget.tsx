import { type FC } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Dialog } from '../../../shared/ui/dialog.js'
import { CreateTaskForm } from '../../../features/create-task/index.js'
import type { Task } from '@agent-team/protocol'

interface TaskCreateFormWidgetProps {
  open: boolean
  onClose: () => void
}

export const TaskCreateFormWidget: FC<TaskCreateFormWidgetProps> = ({ open, onClose }) => {
  const navigate = useNavigate()

  function handleSuccess(task: Task) {
    onClose()
    navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose() }}
      title="新建任务"
      description="填写任务信息，Planner 将在 S1 阶段与你对齐。"
    >
      <CreateTaskForm onSuccess={handleSuccess} />
    </Dialog>
  )
}

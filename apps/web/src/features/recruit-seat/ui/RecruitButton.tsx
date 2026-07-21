import type { FC } from 'react'
import { Button } from '../../../shared/ui/button.js'

interface RecruitButtonProps {
  seatId: string
  taskId: string
  onSuccess?: () => void
}

/**
 * M1 stub — 重招岗位按钮。后端 agent crash 自动重招，
 * 此按钮为手动触发备用，M1 阶段仅渲染占位，M2 再接入 POST /tasks/:id/seats/:seatId/recruit。
 */
export const RecruitButton: FC<RecruitButtonProps> = ({ seatId }) => {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled
      title="M1 自动重招，手动按钮 M2 接入"
    >
      重招 {seatId}
    </Button>
  )
}

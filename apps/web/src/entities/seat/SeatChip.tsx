import type { FC } from 'react'
import type { Seat, SeatStatus } from './model.js'
import { SEAT_STATUS_LABEL } from './model.js'

interface SeatChipProps {
  seat: Seat
  /** 历史人名（从 Agent 实体解析后传入，entities 层不互 import）*/
  displayName?: string
  onClick?: () => void
}

const STATUS_DOT_COLOR: Record<SeatStatus, string> = {
  init: 'bg-gray-400',
  idle: 'bg-green-500',
  working: 'bg-blue-500 animate-pulse',
  switching: 'bg-cyan-400 animate-pulse',
  offline: 'bg-yellow-500',
  vacant: 'bg-red-500',
}

export const SeatChip: FC<SeatChipProps> = ({ seat, displayName, onClick }) => {
  const name = displayName ?? seat.role
  const dotColor = STATUS_DOT_COLOR[seat.status]

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm',
        'transition-colors hover:bg-accent',
        seat.status === 'vacant' ? 'opacity-60' : '',
      ].join(' ')}
      title={`${seat.role} · ${SEAT_STATUS_LABEL[seat.status]}`}
    >
      <span className={`h-2 w-2 rounded-full ${dotColor}`} />
      <span className="font-medium">{name}</span>
      <span className="text-xs text-muted-foreground">{seat.factory}</span>
    </button>
  )
}

import type { FC, ReactNode } from 'react'

type ChipVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'muted'

const variantClasses: Record<ChipVariant, string> = {
  default: 'bg-secondary text-secondary-foreground',
  success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  muted: 'bg-muted text-muted-foreground',
}

interface ChipProps {
  variant?: ChipVariant
  dot?: boolean
  children: ReactNode
  className?: string
}

export const Chip: FC<ChipProps> = ({ variant = 'default', dot = false, children, className = '' }) => {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        variantClasses[variant],
        className,
      ].join(' ')}
    >
      {dot && (
        <span
          className={[
            'h-1.5 w-1.5 rounded-full',
            variant === 'success' ? 'bg-green-500' :
            variant === 'warning' ? 'bg-yellow-500' :
            variant === 'error' ? 'bg-red-500' :
            variant === 'info' ? 'bg-blue-500' :
            'bg-current',
          ].join(' ')}
        />
      )}
      {children}
    </span>
  )
}

import { Dialog as BaseDialog } from '@base-ui-components/react/dialog'
import type { FC, ReactNode } from 'react'

interface DrawerProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: ReactNode
  title?: string
  children: ReactNode
  side?: 'left' | 'right'
}

export const Drawer: FC<DrawerProps> = ({
  open,
  onOpenChange,
  trigger,
  title,
  children,
  side = 'right',
}) => {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <BaseDialog.Trigger render={<span />}>{trigger}</BaseDialog.Trigger>}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-black/50" />
        <BaseDialog.Popup
          className={[
            'fixed inset-y-0 z-50 flex h-full w-3/4 max-w-sm flex-col bg-background p-6 shadow-lg',
            side === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          <div className="flex items-center justify-between">
            {title && <BaseDialog.Title className="text-lg font-semibold">{title}</BaseDialog.Title>}
            <BaseDialog.Close className="rounded-sm opacity-70 hover:opacity-100">
              <span className="sr-only">Close</span>
              <span aria-hidden>×</span>
            </BaseDialog.Close>
          </div>
          <div className="mt-4 flex-1 overflow-y-auto">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

import { Dialog as BaseDialog } from '@base-ui-components/react/dialog'
import type { FC, ReactNode } from 'react'

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: ReactNode
  title?: string
  description?: string
  children: ReactNode
}

export const Dialog: FC<DialogProps> = ({ open, onOpenChange, trigger, title, description, children }) => {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <BaseDialog.Trigger render={<span />}>{trigger}</BaseDialog.Trigger>}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-black/50" />
        <BaseDialog.Popup className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
          {title && (
            <BaseDialog.Title className="text-lg font-semibold leading-none tracking-tight">
              {title}
            </BaseDialog.Title>
          )}
          {description && (
            <BaseDialog.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </BaseDialog.Description>
          )}
          <div className={title ?? description ? 'mt-4' : ''}>{children}</div>
          <BaseDialog.Close className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100">
            <span className="sr-only">Close</span>
            <span aria-hidden>×</span>
          </BaseDialog.Close>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

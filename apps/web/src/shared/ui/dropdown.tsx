import { Menu as BaseMenu } from '@base-ui-components/react/menu'
import type { FC, ReactNode } from 'react'

export interface DropdownItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

interface DropdownProps {
  trigger: ReactNode
  items: DropdownItem[]
  align?: 'start' | 'center' | 'end'
}

export const Dropdown: FC<DropdownProps> = ({ trigger, items, align = 'end' }) => {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={<span />}>{trigger}</BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner align={align} sideOffset={4}>
          <BaseMenu.Popup className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            {items.map((item, i) => (
              <BaseMenu.Item
                key={i}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={[
                  'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
                  'transition-colors focus:bg-accent focus:text-accent-foreground',
                  item.disabled ? 'pointer-events-none opacity-50' : '',
                  item.destructive ? 'text-destructive focus:text-destructive' : '',
                ].join(' ')}
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

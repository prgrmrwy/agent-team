import type { FC } from 'react'
import { ROLE_ICON_PATHS, type RoleName } from './role-paths.js'

interface RoleIconProps {
  role: RoleName
  size?: number
  className?: string
  title?: string
}

/**
 * 单色 SVG icon,fill=currentColor 继承父级 role 色。
 * 配套 `<Avatar>` 一起用;独立使用见 docs/design-handoff.md §5.1。
 */
export const RoleIcon: FC<RoleIconProps> = ({ role, size = 30, className, title }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path fill="currentColor" d={ROLE_ICON_PATHS[role]} />
    </svg>
  )
}

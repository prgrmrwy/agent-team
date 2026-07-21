import type { FC } from 'react'

interface SheikahEyeProps {
  size?: number
  className?: string
}

/**
 * Sheikah Eye 品牌 SVG — titlebar 用。
 * 自绘风(参考 BotW Sheikah 部族标志,简化几何),不依赖外部 icon set。
 * design-handoff §5.12
 */
export const SheikahEye: FC<SheikahEyeProps> = ({ size = 22, className }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Sheikah Eye"
      style={{ color: 'var(--cyan)', filter: 'drop-shadow(0 0 6px var(--cyan-glow))' }}
    >
      {/* 三条上眉(Sheikah 部族标志的三道泪) */}
      <path
        d="M14 18 Q22 12 32 12 Q42 12 50 18 L48 22 Q40 17 32 17 Q24 17 16 22 Z"
        fill="currentColor"
        opacity="0.85"
      />
      {/* 眼眶轮廓 */}
      <ellipse cx="32" cy="34" rx="20" ry="11" fill="none" stroke="currentColor" strokeWidth="2" />
      {/* 瞳孔 */}
      <circle cx="32" cy="34" r="6" fill="currentColor" />
      <circle cx="32" cy="34" r="2.5" fill="var(--slate-bg)" />
      {/* 泪滴(竖向下) */}
      <path
        d="M32 47 L29 56 Q32 60 35 56 Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  )
}

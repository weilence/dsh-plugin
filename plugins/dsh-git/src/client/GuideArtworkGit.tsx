import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** 右侧栏指南页的固定配色 Git 图标，对齐官方 GuideArtwork* 的 36×36 规格。 */
export function GuideArtworkGit({ size = 36, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="#7BC96F" strokeWidth="2" strokeLinecap="round">
        <path d="M12 27V9.5" />
        <path d="M12 21C12 16.5 16 15 20 15H23" />
        <circle cx="12" cy="28" r="2.6" fill="#363E4A" />
        <circle cx="12" cy="7" r="2.6" fill="#363E4A" />
        <circle cx="24" cy="15" r="2.6" fill="#363E4A" />
      </g>
    </svg>
  )
}

import { useState, type ReactNode } from 'react'
import { Button, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** 简化的菜单项（id + 文案）；MenuEntry 的其余形态直接透传 items 亦可。 */
export interface MenuButtonItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** 危险项（错误色文字 + danger hover）。 */
  danger?: boolean
}

// 官方 Menu 的即用封装：portal 挂 body 防被滚动容器裁剪，closeOnPointerLeave
// 做指针容错；需要子菜单等高级形态时直接用官方 Menu。
export function MenuButton(props: {
  label: ReactNode
  items: readonly (MenuButtonItem | MenuEntry)[]
  onSelect(id: string): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const disabled = props.disabled ?? false
  return (
    <Menu
      open={open}
      portal
      align="end"
      closeOnPointerLeave
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        props.onSelect(id)
      }}
      anchor={
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          onPointerEnter={() => {
            if (!disabled) setOpen(true)
          }}
          onClick={() => {
            if (!disabled) setOpen((previous) => !previous)
          }}
        >
          {props.label}
        </Button>
      }
      items={props.items as readonly MenuEntry[]}
    />
  )
}

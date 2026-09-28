/**
 * 下拉按钮：官方 Menu 之上的即用封装——内置 open 状态、hover / 点击双触发
 * （closeOnPointerLeave 带指针容错）、portal 挂 body 防被滚动容器裁剪。
 * 官方 MenuEntry（分隔线 / 标题 / danger）原样透传，需要子菜单等高级形态
 * 时直接用 @deepseek-ai/dsh-client-ui-primitives 的 Menu。
 */

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

export function MenuButton(props: {
  /** 按钮文字。 */
  label: ReactNode
  /** 菜单项（MenuButtonItem 或官方 MenuEntry）。 */
  items: readonly (MenuButtonItem | MenuEntry)[]
  onSelect(id: string): void
  disabled?: boolean
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'outline' | 'primary'
  /** 相对锚点的水平对齐（动作区靠右时用 end）；缺省 end。 */
  align?: 'start' | 'end'
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const disabled = props.disabled ?? false
  return (
    <Menu
      open={open}
      portal
      align={props.align ?? 'end'}
      closeOnPointerLeave
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        props.onSelect(id)
      }}
      anchor={
        <Button
          size={props.size ?? 'sm'}
          variant={props.variant ?? 'ghost'}
          disabled={disabled}
          title={props.title}
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

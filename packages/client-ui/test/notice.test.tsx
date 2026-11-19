import { createElement, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoticeRelay, NoticeToast, ResidentNoticeSlotEntry, ResidentNoticeToast, useNotice } from '../src'

const toastProps: { text: string; holdMs?: number; onDone?: () => void }[] = []
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Toast: (props: { text: string; holdMs?: number; onDone?: () => void }) => {
    toastProps.push({ text: props.text, holdMs: props.holdMs, onDone: props.onDone })
    return <div>{props.text}</div>
  },
}))

beforeEach(() => {
  toastProps.length = 0
})

describe('NoticeRelay', () => {
  it('emit 无订阅者时丢弃；有订阅者时投递；退订后不再投递', () => {
    const relay = new NoticeRelay<string>()
    // 面板卸载后完成的迟到反馈无处显示，直接丢弃——排队只会在重开时重放
    relay.emit('迟到')
    const seen: string[] = []
    const unsubscribe = relay.subscribe((message) => seen.push(message))
    relay.emit('a')
    unsubscribe()
    relay.emit('b')
    expect(seen).toEqual(['a'])
  })
})

/** 测试探针：把 useNotice 的状态平铺成文本，并把 dismiss 暴露给断言方。 */
function NoticeProbe(props: { relay: NoticeRelay<string>; holder: { dismiss?: () => void } }): ReactNode {
  const { notice, dismiss } = useNotice(props.relay)
  props.holder.dismiss = dismiss
  return <div>{notice === null ? '无' : `${notice.message}#${notice.nonce}`}</div>
}

/** react-test-renderer 的树序列化成文本便于断言。 */
function rendered(renderer: { toJSON(): unknown }): string {
  return JSON.stringify(renderer.toJSON())
}

describe('useNotice', () => {
  it('投递即显示，重复投递递增 nonce（同文案重新计时），dismiss 清空', () => {
    const relay = new NoticeRelay<string>()
    const holder: { dismiss?: () => void } = {}
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(NoticeProbe, { relay, holder }))
    })
    expect(rendered(renderer)).toContain('无')

    act(() => relay.emit('已保存'))
    expect(rendered(renderer)).toContain('已保存#1')
    act(() => relay.emit('已保存'))
    expect(rendered(renderer)).toContain('已保存#2')

    act(() => holder.dismiss?.())
    expect(rendered(renderer)).toContain('无')
    act(() => renderer.unmount())
  })

  it('卸载后通道投递不再渲染（组件态随分区卸载消亡）', () => {
    const relay = new NoticeRelay<string>()
    const holder: { dismiss?: () => void } = {}
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(NoticeProbe, { relay, holder }))
    })
    act(() => renderer.unmount())
    expect(() => act(() => relay.emit('卸载后'))).not.toThrow()
  })
})

describe('NoticeToast', () => {
  it('notice 为 null 不渲染；有通知渲染文本，holdMs 缺省 5000、显式传值生效', () => {
    const onDismiss = (): void => {}
    expect(
      renderToStaticMarkup(createElement(NoticeToast<string>, { notice: null, text: (m) => m, onDismiss })),
    ).toBe('')

    const html = renderToStaticMarkup(
      createElement(NoticeToast<string>, {
        notice: { message: '已保存', nonce: 3 },
        text: (m) => m,
        onDismiss,
      }),
    )
    expect(html).toContain('已保存')
    expect(toastProps.at(-1)?.holdMs).toBe(5000)

    renderToStaticMarkup(
      createElement(NoticeToast<string>, {
        notice: { message: '详情', nonce: 1 },
        text: (m) => m,
        holdMs: 8000,
        onDismiss,
      }),
    )
    expect(toastProps.at(-1)?.holdMs).toBe(8000)
  })
})

describe('ResidentNoticeToast', () => {
  it('emit 即渲染横幅，播完自清，再次投递重新渲染（owner 不卸载则反馈必达）', () => {
    const relay = new NoticeRelay<string>()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(ResidentNoticeToast<string>, { relay, text: (m) => m }))
    })
    expect(renderer.toJSON()).toBe(null)

    act(() => relay.emit('已保存'))
    expect(toastProps.at(-1)?.text).toBe('已保存')
    expect(toastProps.at(-1)?.holdMs).toBe(5000)

    // 模拟横幅播完：onDone 清空后不再渲染，无残留。
    act(() => toastProps.at(-1)?.onDone?.())
    expect(renderer.toJSON()).toBe(null)

    // 清空后再投递照常显示；未清空就再投递则换 nonce 重开计时（由 Toast key 保证）。
    act(() => relay.emit('已保存'))
    expect(toastProps.at(-1)?.text).toBe('已保存')
    act(() => renderer.unmount())
  })
})

describe('ResidentNoticeSlotEntry', () => {
  it('注入面提供 relay 即渲染纯文本横幅，播完自清（无需 locale seat）', () => {
    const relay = new NoticeRelay<string>()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        createElement(ResidentNoticeSlotEntry, { relay } as unknown as ComponentProps<
          typeof ResidentNoticeSlotEntry
        >),
      )
    })
    expect(renderer.toJSON()).toBe(null)

    act(() => relay.emit('已保存'))
    expect(toastProps.at(-1)?.text).toBe('已保存')

    act(() => toastProps.at(-1)?.onDone?.())
    expect(renderer.toJSON()).toBe(null)
    act(() => renderer.unmount())
  })
})

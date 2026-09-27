import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

/** 一次行拖拽的共享状态。 */
interface RowDragState {
  from: number
  over: { index: number; half: 'before' | 'after' } | null
}

/** 单行的拖拽属性（未启用排序时全部缺省，可直接展开到元素上）。 */
export interface RowDragHandlers {
  draggable?: true
  onDragStart?(event: ReactDragEvent): void
  onDragOver?(event: ReactDragEvent): void
  onDrop?(event: ReactDragEvent): void
  onDragEnd?(): void
}

export interface RowDragControllers {
  lineAt(index: number, total: number): 'top' | 'bottom' | null
  isDragging(index: number): boolean
  rowProps(index: number, key: string): RowDragHandlers
}

function rowDropHalf(event: { clientY: number; currentTarget: Element }): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

// 拖拽进行中在 document 层接受原生拖拽：拖到行间隙、列表之外时浏览器不把
// 放置渲染成「拒绝」，drop 照常发生，dragend 按最后一个悬停标记提交。
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    // 这里的 DragEvent 是 DOM 全局类型（document 监听拿到的原生事件）。
    const acceptDrag = (event: DragEvent) => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent) => {
      event.preventDefault()
    }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/**
 * 行拖拽排序控制器，语义对齐官方 workspace 的 Rows：onReorder(from, to)
 * 收到原始下标语义的目标位（半区边界已折算），原位放置不会触发调用；插入
 * 标记画在插入边界上，光标在边界两侧的行半区之间晃动时标记纹丝不动。
 */
export function useRowDragReorder(
  onReorder: ((from: number, to: number) => void) | undefined,
): RowDragControllers {
  const [drag, setDrag] = useState<RowDragState | undefined>(undefined)
  /** 一次拖拽只提交一次：drop 与 dragend 都可能先到。 */
  const dropCommitted = useRef(false)
  const reorderRef = useRef(onReorder)
  reorderRef.current = onReorder
  useNativeDragAcceptance(drag !== undefined)

  const commit = (state: RowDragState, over: { index: number; half: 'before' | 'after' }) => {
    if (dropCommitted.current) return
    dropCommitted.current = true
    setDrag(undefined)
    const insertAt = over.half === 'before' ? over.index : over.index + 1
    if (insertAt === state.from || insertAt === state.from + 1) return
    reorderRef.current?.(state.from, insertAt > state.from ? insertAt - 1 : insertAt)
  }

  return {
    isDragging: (index) => drag?.from === index,
    lineAt: (index, total) => {
      const over = drag?.over
      if (over === null || over === undefined) return null
      const boundary = over.half === 'before' ? over.index : over.index + 1
      if (boundary === index) return 'top'
      if (boundary === total && index === total - 1) return 'bottom'
      return null
    },
    rowProps: (index, key) => {
      if (onReorder === undefined) return {}
      return {
        draggable: true,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', key)
          dropCommitted.current = false
          setDrag({ from: index, over: null })
        },
        onDragOver: (event) => {
          if (drag === undefined) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const half = rowDropHalf(event)
          setDrag((current) => (current === undefined ? current : { ...current, over: { index, half } }))
        },
        onDrop: (event) => {
          if (drag === undefined) return
          event.preventDefault()
          // 半区从当前事件现算，不依赖可能过期的 state。
          commit(drag, { index, half: rowDropHalf(event) })
        },
        onDragEnd: () => {
          // drop 没发生时按最后一个悬停标记提交，否则清空状态。
          if (drag?.over !== null && drag?.over !== undefined) commit(drag, drag.over)
          else setDrag(undefined)
        },
      }
    },
  }
}

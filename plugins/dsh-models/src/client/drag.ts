// 行拖拽排序的共享实现（官方 workspace Rows 同款语义）。
//
// 之前在 ModelTable（模型行）与列表页（Provider 卡片）各复制了一份：
// from/over 状态、drop 与 dragend 的双路径提交守卫、插入边界计算与事件
// 处理完全相同，这里收敛为一个 hook；调用方只提供 onReorder(from, to)
// 与每行的 key，标记渲染用 lineAt / isDragging。

import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

/** 一次行拖拽的共享状态：from = 源行下标；over = 当前悬停行 + 半区（null = 还没悬停到任何行）。 */
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
	/** 第 index 行的插入线：'top' 顶边 / 'bottom' 底边 / null 无。 */
	lineAt(index: number, total: number): 'top' | 'bottom' | null
	isDragging(index: number): boolean
	/** 第 index 行（标识 key）的拖拽属性。 */
	rowProps(index: number, key: string): RowDragHandlers
}

/**
 * 拖拽插入位置判定（官方 workspace Rows.rowHalf 同款）：指针在行上半区
 * = 插到行前（before），下半区 = 插到行后（after）。
 */
function rowDropHalf(event: { clientY: number; currentTarget: Element }): 'before' | 'after' {
	const rect = event.currentTarget.getBoundingClientRect()
	return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * 拖拽进行中在 document 层接受原生拖拽（官方 workspace useNativeDragAcceptance
 * 同款）：行 hover 仍然独占插入标记的更新，但拖到行与行的空隙、列表之外时，
 * 浏览器不再把放置渲染成「拒绝」——drop 照常发生，dragend 按最后一个悬停
 * 标记提交，松手位置稍偏也不会让整次拖拽作废。
 */
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
 * 行拖拽排序控制器。
 *
 * onReorder(from, to) 收到「原始下标语义」的目标位：半区边界已折算
 * （after = 下一行之前），原位放置——插到源行自身前 / 后——不会触发调用。
 *
 * 插入标记画在「插入边界」上而不是悬停行的边缘：boundary = 插到第
 * boundary 行之前。一条边界只有一个标记，光标在边界两侧的行半区之间
 * 晃动时标记纹丝不动（官方行距为 0，before/after 天然重叠在分割线上；
 * 卡片列表有间隙，必须显式收敛到边界）。
 */
export function useRowDragReorder(
	onReorder: ((from: number, to: number) => void) | undefined,
): RowDragControllers {
	const [drag, setDrag] = useState<RowDragState | undefined>(undefined)
	/** 一次拖拽只提交一次：drop 与 dragend 都可能先到（官方同款 ref 守卫）。 */
	const dropCommitted = useRef(false)
	const reorderRef = useRef(onReorder)
	reorderRef.current = onReorder
	useNativeDragAcceptance(drag !== undefined)

	/** 提交一次拖拽（官方 commitSessionDrag 同款）：drop 与 dragend 谁先到谁生效。 */
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
					// 悬停源行自身同样显示标记（官方行为）：原位放置结果是不移动。
					const half = rowDropHalf(event)
					setDrag((current) => (current === undefined ? current : { ...current, over: { index, half } }))
				},
				onDrop: (event) => {
					if (drag === undefined) return
					event.preventDefault()
					// 半区从当前事件现算（官方同款），不依赖可能过期的 state。
					commit(drag, { index, half: rowDropHalf(event) })
				},
				onDragEnd: () => {
					// 官方兜底：drop 没发生（松手在空隙 / 列表外）时，dragend 按
					// 最后一个悬停标记提交；否则清空状态。
					if (drag?.over !== null && drag?.over !== undefined) commit(drag, drag.over)
					else setDrag(undefined)
				},
			}
		},
	}
}

// 客户端轻量二次封装：把「字段行 + 官方控件」的重复样板收敛到一处。
//
// 原则：只组合官方 primitives 控件与本项目的布局类，不新增样式概念——
// 官方组件升级（令牌、暗色适配）时这一层自动跟随，不产生第二套视觉体系。
// 布局上字段行统一单列全宽：官方 settings 表单的既定惯例，也彻底规避
// 相邻输入框在暗色主题下边界相接的观感问题。
//
// 多层弹窗的 Escape 依次关闭由官方 Modal 的 useModalLayer 层栈负责
// （ui-primitives 是 PLATFORM_MODULES 共享模块，宿主与插件共用同一张
// 栈），插件侧不再自实现。

import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'
import local from './ui.module.css'

const styles = { ...shared, ...local }
/** 官方 Input 外框类名；disabled 时叠加淡显（视觉对齐原生 input:disabled）。 */
export function fieldInputCls(disabled?: boolean): string {
	return disabled ? `${styles.fieldInput} ${styles.fieldInputDisabled}` : styles.fieldInput
}

/** 字段行：label 文案 + 控件。官方 Input、自绘 select / textarea 都可作为 children。 */
export function Field(props: { label: string; wide?: boolean; children: ReactNode }) {
	return (
		<label className={props.wide ? styles.fieldWide : styles.field}>
			<span className={styles.label}>{props.label}</span>
			{props.children}
		</label>
	)
}

/** 官方 Input 的字段行封装：禁用态淡显内聚在这里，调用处不再拼类名。 */
export function TextField(props: {
	label: string
	value: string
	onChange(value: string): void
	type?: 'text' | 'password'
	placeholder?: string
	/** datalist 联想（官方 Input 原样透传给内部 input）。 */
	list?: string
	inputMode?: 'numeric'
	autoComplete?: 'off'
	disabled?: boolean
	/** 跨满网格整行（grid-column: 1 / -1）。 */
	wide?: boolean
}) {
	const { label, value, onChange, type, placeholder, list, inputMode, autoComplete, disabled, wide } = props
	return (
		<Field label={label} wide={wide}>
			<Input
				className={fieldInputCls(disabled)}
				type={type}
				value={value}
				placeholder={placeholder}
				list={list}
				inputMode={inputMode}
				autoComplete={autoComplete}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	)
}

/** 下拉选择的字段行封装（官方无对应组件，保留自绘 .select）。 */
export function SelectField(props: {
	label: string
	value: string
	options: readonly { value: string; label: string }[]
	disabled?: boolean
	onChange(value: string): void
}) {
	const { label, value, options, disabled, onChange } = props
	return (
		<Field label={label}>
			<select
				className={styles.select}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</Field>
	)
}

/** 多行文本的字段行封装（官方无对应组件，保留自绘 .textarea）。 */
export function TextAreaField(props: {
	label: string
	value: string
	onChange(value: string): void
	placeholder?: string
}) {
	const { label, value, onChange, placeholder } = props
	return (
		<Field label={label}>
			<textarea
				className={styles.textarea}
				value={value}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	)
}

/**
 * 表单校验问题列表： touched / mutated 之后的集中报错块（编辑页、新建
 * Provider、模型表单共用同一样式）。path 可选：模型表单带字段路径展示。
 */
export function IssueList(props: { issues: readonly { path?: string; message: string }[] }) {
	return (
		<div className={styles.error} role="alert">
			<ul className={styles.issueList}>
				{props.issues.map((issue, index) => (
					<li key={index}>
						{issue.path !== undefined ? <code className={styles.code}>{issue.path}</code> : null}{' '}
						{issue.message}
					</li>
				))}
			</ul>
		</div>
	)
}

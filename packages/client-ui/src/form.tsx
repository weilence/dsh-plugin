import { useId, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'
import local from './field.module.css'

const styles = { ...shared, ...local }

export function fieldInputCls(disabled?: boolean): string {
  return disabled ? `${styles.fieldInput} ${styles.fieldInputDisabled}` : styles.fieldInput
}

/** 无标签工具行里的裸 select 取用同一套 select 样式（Field 之外使用）。 */
export const selectCls: string = styles.select

// 字段行统一单列全宽：官方 settings 表单的既定惯例。
export function Field(props: { label: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={props.wide ? styles.fieldWide : styles.field}>
      <span className={styles.label}>{props.label}</span>
      {props.children}
    </label>
  )
}

export function TextField(props: {
  /** 字段标签；可传 ReactNode 以在标签内嵌状态点等附属信息。 */
  label: ReactNode
  value: string
  onChange(value: string): void
  type?: 'text' | 'password'
  placeholder?: string
  /** datalist 联想（官方 Input 原样透传给内部 input）。 */
  list?: string
  inputMode?: 'numeric'
  autoComplete?: 'off'
  disabled?: boolean
  /** 挂载即聚焦（新建表单开卡即输入，省一次点击）。 */
  autoFocus?: boolean
  /** 跨满网格整行（grid-column: 1 / -1）。 */
  wide?: boolean
  /** 联动按钮（文本 + 回调；样式与输入框等高，不收缩不换行）。 */
  addon?: { label: string; onClick(): void; disabled?: boolean }
  /** 控件下方的单条校验错误。 */
  error?: string
  /** 联想候选：传入即渲染内置 datalist 并自动关联（优先于 list）。 */
  datalist?: readonly { value: string; label?: string }[]
}) {
  const {
    label,
    value,
    onChange,
    type,
    placeholder,
    list,
    inputMode,
    autoComplete,
    disabled,
    autoFocus,
    wide,
    addon,
    error,
    datalist,
  } = props
  // datalist id 只在组件树内唯一即可，useId 免去调用方手工起名。
  const listId = useId()
  const listAttr = datalist !== undefined ? listId : list
  const input = (
    <Input
      className={fieldInputCls(disabled)}
      type={type}
      value={value}
      placeholder={placeholder}
      list={listAttr}
      inputMode={inputMode}
      autoComplete={autoComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  )
  return (
    <Field label={label} wide={wide}>
      {addon === undefined ? (
        input
      ) : (
        <div className={styles.inputRow}>
          {input}
          <button
            type="button"
            className={styles.addonButton}
            disabled={disabled || addon.disabled}
            onClick={addon.onClick}
          >
            {addon.label}
          </button>
        </div>
      )}
      {datalist !== undefined ? (
        <datalist id={listId}>
          {datalist.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </datalist>
      ) : null}
      {error !== undefined && error.length > 0 ? <div className={styles.error}>{error}</div> : null}
    </Field>
  )
}

/** 下拉选择的字段行封装（官方无对应组件，保留自绘 .select）。 */
export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string; disabled?: boolean }[]
  disabled?: boolean
  onChange(value: T): void
}) {
  const { label, value, options, disabled, onChange } = props
  return (
    <Field label={label}>
      <select
        className={styles.select}
        value={value}
        disabled={disabled}
        // option 的 value 都来自 T 类型的 options，DOM 只回传 string
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** 多行文本的字段行封装（官方无对应组件，保留自绘 .textarea）。 */
export function TextAreaField(props: {
  label: ReactNode
  value: string
  onChange?(value: string): void
  placeholder?: string
  /** 只读展示（配置原文等）。 */
  readOnly?: boolean
  /** 覆盖默认 96px 的最小高度（多行正文 / 代码原文）。 */
  minHeight?: number
  spellCheck?: boolean
}) {
  const { label, value, onChange, placeholder, readOnly, minHeight, spellCheck } = props
  return (
    <Field label={label}>
      <textarea
        className={styles.textarea}
        style={minHeight === undefined ? undefined : { minHeight }}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={spellCheck}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </Field>
  )
}

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

import { useId, type ReactNode } from 'react'
import { Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'
import local from './field.module.css'

const styles = { ...shared, ...local }

export function fieldInputCls(disabled?: boolean): string {
  return disabled ? `${styles.fieldInput} ${styles.fieldInputDisabled}` : styles.fieldInput
}

/** 无标签工具行里的裸 select 取用同一套 select 样式（Field 之外使用）。 */
export const selectCls: string = styles.select

/** 覆盖默认值交互（对齐官方 SettingsValueField）：标题行右侧「已覆盖」徽标 +
 *  「恢复默认」入口；重置只把字段清回继承态，提交仍由表单保存完成。 */
export interface FieldOverride {
  /** 徽标文案（调用方词典，如「已覆盖」）。 */
  label: string
  /** 重置入口文案（如「恢复默认」）。 */
  resetLabel: string
  /** 清回继承态（只改草稿，不落库）。 */
  onReset(): void
}

/** 字段行外壳：标题行（标签 + 可选覆盖徽标）→ 控件 → 说明 / 错误单槽。
 *  错误与说明互斥同槽（错误优先），非法时控件层以 aria-invalid 标红。 */
export function Field(props: {
  label: ReactNode
  /** 控件 id：传入即 label 以 htmlFor 关联（含覆盖徽标的字段必须传，
   *  徽标内按钮不得嵌进 label）。 */
  htmlFor?: string
  wide?: boolean
  /** 说明文案（无错误时显示）。 */
  hint?: string
  /** 非法态：控件标红，说明槽原位换成错误文案。 */
  invalid?: boolean
  invalidLabel?: string
  override?: FieldOverride
  children: ReactNode
}) {
  const { label, htmlFor, wide, hint, invalid, invalidLabel, override } = props
  const message = invalid === true ? (invalidLabel ?? '') : hint
  return (
    <div className={wide ? styles.fieldWide : styles.field}>
      <div className={styles.fieldHead}>
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
        {override ? (
          <span className={styles.badges}>
            <Tag tone="neutral">{override.label}</Tag>
            <button type="button" className={styles.reset} onClick={override.onReset}>
              {override.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      {props.children}
      {message !== undefined && message.length > 0 ? (
        <p className={invalid ? styles.fieldInvalid : styles.fieldHint}>{message}</p>
      ) : null}
    </div>
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
  /** 字段校验错误：非空即非法态（输入框标红，说明槽原位显示本条红字）。 */
  error?: string
  /** 说明文案（无错误时显示）。 */
  hint?: string
  /** 覆盖默认值交互（见 FieldOverride）。 */
  override?: FieldOverride
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
    hint,
    override,
    datalist,
  } = props
  const id = useId()
  // datalist id 只在组件树内唯一即可，useId 免去调用方手工起名。
  const listId = useId()
  const listAttr = datalist !== undefined ? listId : list
  const invalid = error !== undefined && error.length > 0
  const input = (
    <Input
      id={id}
      className={invalid ? `${fieldInputCls(disabled)} ${styles.fieldInputInvalid}` : fieldInputCls(disabled)}
      aria-invalid={invalid || undefined}
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
    <Field
      label={label}
      htmlFor={id}
      wide={wide}
      hint={hint}
      invalid={invalid}
      invalidLabel={error}
      override={override}
    >
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
  /** 字段校验错误：非空即非法态（下拉标红，说明槽原位显示本条红字）。 */
  error?: string
  /** 说明文案（无错误时显示）。 */
  hint?: string
  /** 覆盖默认值交互（见 FieldOverride）。 */
  override?: FieldOverride
}) {
  const { label, value, options, disabled, onChange, error, hint, override } = props
  const id = useId()
  const invalid = error !== undefined && error.length > 0
  return (
    <Field label={label} htmlFor={id} hint={hint} invalid={invalid} invalidLabel={error} override={override}>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
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
  /** 字段校验错误：非空即非法态（文本域标红，说明槽原位显示本条红字）。 */
  error?: string
  /** 说明文案（无错误时显示）。 */
  hint?: string
  /** 覆盖默认值交互（见 FieldOverride）。 */
  override?: FieldOverride
}) {
  const { label, value, onChange, placeholder, readOnly, minHeight, spellCheck, error, hint, override } =
    props
  const id = useId()
  const invalid = error !== undefined && error.length > 0
  return (
    <Field label={label} htmlFor={id} hint={hint} invalid={invalid} invalidLabel={error} override={override}>
      <textarea
        id={id}
        className={styles.textarea}
        style={minHeight === undefined ? undefined : { minHeight }}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={spellCheck}
        aria-invalid={invalid || undefined}
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

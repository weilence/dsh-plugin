import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'
import local from './field.module.css'

const styles = { ...shared, ...local }

export function fieldInputCls(disabled?: boolean): string {
  return disabled ? `${styles.fieldInput} ${styles.fieldInputDisabled}` : styles.fieldInput
}

// 字段行统一单列全宽：官方 settings 表单的既定惯例。
export function Field(props: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={props.wide ? styles.fieldWide : styles.field}>
      <span className={styles.label}>{props.label}</span>
      {props.children}
    </label>
  )
}

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

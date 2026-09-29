import shared from './shared.module.css'

export function MetaItem(props: { label: string; value: string | undefined; wide?: boolean }) {
  return (
    <div className={props.wide ? shared.metaWide : shared.meta}>
      <span className={shared.label}>{props.label}</span>
      <span className={shared.metaValue}>{props.value ?? '—'}</span>
    </div>
  )
}

import shared from './shared.module.css'

/** 元信息网格（配 shared.module.css 的 .metaGrid）中的单项：label 在上、
 *  值在下，值缺省显示 —；wide 跨满整行。 */
export function MetaItem(props: { label: string; value: string | undefined; wide?: boolean }) {
  return (
    <div className={props.wide ? shared.metaWide : shared.meta}>
      <span className={shared.label}>{props.label}</span>
      <span className={shared.metaValue}>{props.value ?? '—'}</span>
    </div>
  )
}

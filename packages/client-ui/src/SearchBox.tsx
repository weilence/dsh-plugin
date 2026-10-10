import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './search-box.module.css'

/** 列表过滤搜索框：样式对齐官方插件清单页（ui-settings-plugin-inventory）的搜索——
 *  36px 高、左侧放大镜、focus-visible 焦点环；占位、aria-label 与视觉隐藏标签共用同一个词。
 *  基础样式 width: 100%（独立整行用）；放进 flex 工具行时调用方必须以 `flex: 1`
 *  （basis 0）收放——basis auto 会让 width: 100% 生效，搜索框独占一行。 */
export function SearchBox(props: {
  value: string
  onChange(value: string): void
  /** 占位 / aria-label / 视觉隐藏标签共用词。 */
  label: string
  className?: string
}) {
  return (
    <label className={props.className === undefined ? css.search : `${css.search} ${props.className}`}>
      <IconSearchOutlineRegular aria-hidden="true" />
      <span className={css.visuallyHidden}>{props.label}</span>
      <input
        type="search"
        value={props.value}
        placeholder={props.label}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}

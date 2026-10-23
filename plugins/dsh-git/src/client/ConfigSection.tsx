/** 插件详情页配置面板（plugins.bundle.config 槽位，keyed 包名）：悬停弹出延时。
 *  详情页头部已带插件名与描述，Panel 整体无头部；字段用官方 SettingsValueField——
 *  说明与错误同槽互斥、与默认值不同时右上「已覆盖」徽标 + 「恢复默认」入口。
 *  重置与官方同口径：只把默认值暂存进草稿，写入仍由保存完成。 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel } from '@dsh-plugins/client-ui'
import type { NS } from './locales'
import {
  DEFAULT_HOVER_DELAY_MS,
  MAX_HOVER_DELAY_MS,
  MIN_HOVER_DELAY_MS,
  getHoverDelay,
  setHoverDelay,
  subscribeHoverDelay,
} from './hoverDelay'
import styles from './ConfigSection.module.css'

export type ConfigSectionProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS>

export function ConfigSection({ t }: ConfigSectionProps) {
  const hoverDelayMs = useSyncExternalStore(subscribeHoverDelay, getHoverDelay, getHoverDelay)
  // 草稿：输入不即时落库，保存才写入；store 变化（保存收敛、别处修改）时跟随
  const [draft, setDraft] = useState(() => String(getHoverDelay()))
  useEffect(() => {
    setDraft(String(hoverDelayMs))
  }, [hoverDelayMs])

  const parsed = Number.parseInt(draft, 10)
  const valid = Number.isFinite(parsed) && parsed >= MIN_HOVER_DELAY_MS && parsed <= MAX_HOVER_DELAY_MS
  const changed = valid && parsed !== hoverDelayMs
  // 覆盖徽标（暂存口径）：保存后会留下与默认不同的值；重置暂存默认值即消失
  const overridden = valid && parsed !== DEFAULT_HOVER_DELAY_MS

  return (
    <Panel>
      <SettingsValueField
        id="dsh-git-hover-delay"
        label={t('config.hoverDelay')}
        hint={t('config.hoverDelayHint')}
        overriddenLabel={t('config.overridden')}
        resetLabel={t('config.resetDefault')}
        invalidLabel={t('config.invalid')}
        numeric
        disabled={false}
        text={draft}
        overridden={overridden}
        invalid={!valid}
        onEdit={setDraft}
        onReset={() => {
          setDraft(String(DEFAULT_HOVER_DELAY_MS))
        }}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.save}
          disabled={!changed}
          onClick={() => setHoverDelay(parsed)}
        >
          {t('config.save')}
        </button>
      </div>
    </Panel>
  )
}

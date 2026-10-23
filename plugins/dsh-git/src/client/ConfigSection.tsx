/** 插件详情页配置面板（plugins.bundle.config 槽位，keyed 包名）：悬停弹出延时。
 *  详情页头部已带插件名与描述，Panel 整体无头部；布局对齐官方插件配置页——
 *  字段标题、通宽输入框、辅助说明、保存按钮（未改动或非法时禁用）。 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { NS } from './locales'
import {
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

  return (
    <Panel>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="dsh-git-hover-delay">
          {t('config.hoverDelay')}
        </label>
        <input
          id="dsh-git-hover-delay"
          className={styles.input}
          type="number"
          min={MIN_HOVER_DELAY_MS}
          max={MAX_HOVER_DELAY_MS}
          step={50}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className={shared.hint}>{t('config.hoverDelayHint')}</p>
      </div>
      <div className={styles.actions}>
        {!valid && (
          <span className={shared.error} role="alert">
            {t('config.invalid')}
          </span>
        )}
        <Button variant="outline" size="sm" disabled={!changed} onClick={() => setHoverDelay(parsed)}>
          {t('config.save')}
        </Button>
      </div>
    </Panel>
  )
}

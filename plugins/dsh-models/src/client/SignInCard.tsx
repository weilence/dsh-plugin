import { useState, type ReactNode } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthAttemptState, AuthState } from './store'
import type { AuthFlow, AuthSequencedEvent } from './operations'
import { IssueList, fieldInputCls } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SignInCard.module.css'

const styles = { ...shared }

/** 未应答的问题 = 最后一条 prompt 之后没有同 id 的 answered / withdrawn。 */
export function activePromptOf(events: readonly AuthSequencedEvent[]) {
  let active: (AuthSequencedEvent & { kind: 'prompt' }) | undefined
  const retired = new Set<number>()
  for (const event of events) {
    if (event.kind === 'prompt') active = event
    else if (event.kind === 'answered' || event.kind === 'withdrawn') retired.add(event.promptId)
  }
  return active !== undefined && !retired.has(active.promptId) ? active : undefined
}

function NoticeLine(props: { message: string; url?: string; code?: string }) {
  return (
    <div className={styles.notice}>
      <span>{props.message}</span>
      {props.url !== undefined ? (
        <>
          {' '}
          {/* 浏览器由用户点开：授权页在系统浏览器完成，回调回 127.0.0.1。 */}
          <a href={props.url} target="_blank" rel="noreferrer">
            {props.url}
          </a>
        </>
      ) : null}
      {props.code !== undefined ? (
        <>
          {' '}
          <code className={styles.code}>{props.code}</code>
        </>
      ) : null}
    </div>
  )
}

/**
 * 表单嵌入的登录视图：card 是登录卡本体；replacesApiKey 说明该 Provider 的
 * flow 没有 api-key 方法（oauth-only，API Key 字段没有意义要隐藏）——双形态
 * Provider（如 openrouter）两个凭据入口并排显示。
 */
export interface SignInView {
  card: ReactNode
  replacesApiKey: boolean
}

/**
 * 账号登录卡：状态点（已授权 = Host 凭据记录在座）+ 登录入口 + 进行中的
 * 事件流（提示 / 授权链接 / 设备码 / 问题应答）。账号授权与 API Key 是两种
 * 不同的凭据形态，此卡只管前者；同一时刻面板只驱动一个登录尝试。
 */
export function SignInCard(props: {
  provider: string
  flow: AuthFlow
  auth: AuthState
  /** oauth-only 时为 true：提示行说明不使用 API Key，且表单已隐藏 Key 字段。 */
  replacesApiKey: boolean
  onBegin(provider: string): void
  onAnswer(value: string): void
  onDecline(): void
  onCancel(): void
}) {
  const { auth } = props
  const mine: AuthAttemptState | null =
    auth.attempt !== null && auth.attempt.provider === props.provider ? auth.attempt : null
  const record = auth.records[props.provider]
  const authorized = record?.configured === true
  const running = mine?.running === true
  const [manualValue, setManualValue] = useState('')
  const [selectDraft, setSelectDraft] = useState('')

  const activePrompt = mine !== null ? activePromptOf(mine.events) : undefined
  const outcome = mine !== null && !mine.running ? mine.events.at(-1) : undefined
  // 选择题草稿回退到首项：授权流程的问题总有推荐项，避免空选择卡住提交。
  const selectOptions =
    (activePrompt?.prompt.kind === 'select' ? activePrompt.prompt.options : undefined) ?? []
  const selectValue = selectOptions.some((option) => option.id === selectDraft)
    ? selectDraft
    : (selectOptions[0]?.id ?? '')

  let promptForm: ReactNode = null
  if (activePrompt !== undefined) {
    const submit = () => {
      // 空答案是合法应答：pi-ai 的问题没有「必填」标记，copilot 的第一步
      // 「GitHub Enterprise URL（空 = github.com）」就靠空提交推进。
      props.onAnswer(activePrompt.prompt.kind === 'select' ? selectValue : manualValue.trim())
      if (activePrompt.prompt.kind !== 'select') setManualValue('')
    }
    const declineButton = (
      <Button variant="outline" onClick={props.onDecline}>
        拒绝
      </Button>
    )
    // 问题收敛为一行：标签在上，输入/选择自适应占宽，提交与拒绝贴右相邻。
    promptForm =
      activePrompt.prompt.kind === 'select' ? (
        <div key={activePrompt.promptId} className={local.promptBlock}>
          <div className={local.promptLabel}>{activePrompt.prompt.message}</div>
          <div className={local.promptRow}>
            <div className={local.promptControl}>
              <select
                className={styles.select}
                value={selectValue}
                onChange={(event) => setSelectDraft(event.target.value)}
              >
                {selectOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="primary" disabled={selectValue.length === 0} onClick={submit}>
              提交
            </Button>
            {declineButton}
          </div>
        </div>
      ) : (
        <div key={activePrompt.promptId} className={local.promptBlock}>
          <div className={local.promptLabel}>{activePrompt.prompt.message}</div>
          <div className={local.promptRow}>
            <div className={local.promptControl}>
              <Input
                className={fieldInputCls()}
                type={activePrompt.prompt.kind === 'secret' ? 'password' : 'text'}
                value={manualValue}
                autoComplete="off"
                placeholder={activePrompt.prompt.placeholder}
                onChange={(event) => setManualValue(event.target.value)}
              />
            </div>
            <Button variant="primary" onClick={submit}>
              提交
            </Button>
            {declineButton}
          </div>
        </div>
      )
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        账号登录
        {record !== undefined ? (
          <>
            {' '}
            <StateDot className={styles.inlineDot} state={authorized ? 'done' : 'warning'} />
            {authorized ? '已授权' : '未授权'}
          </>
        ) : null}
      </h3>
      <div className={styles.notice}>
        {props.replacesApiKey
          ? `该 Provider 通过账号登录（${props.flow.label}），不使用 API Key。`
          : `该 Provider 支持账号登录（${props.flow.label}）；也可继续使用 API Key。`}
      </div>
      {mine !== null ? (
        // 进行中 / 刚结束的尝试收进同一块有边界的面板：事件流、问题、收口
        // 按钮在视觉上是一个整体，不再与表单字段的松散堆叠混排。
        <div className={local.attempt}>
          {mine.events.map((event) =>
            event.kind === 'notice' ? (
              <NoticeLine key={event.seq} message={event.message} url={event.url} code={event.code} />
            ) : null,
          )}
          {promptForm}
          {outcome !== undefined && outcome.kind === 'outcome' ? (
            outcome.status === 'authorized' ? (
              <div className={styles.success}>登录成功。</div>
            ) : outcome.status === 'cancelled' ? (
              <div className={styles.notice}>登录已取消。</div>
            ) : (
              <IssueList issues={[{ message: outcome.error ?? '登录失败。' }]} />
            )
          ) : null}
          <div className={local.attemptActions}>
            {running ? (
              <Button variant="outline" onClick={props.onCancel}>
                取消登录
              </Button>
            ) : (
              // 尝试已结束：结果行只回看这一次，入口必须立即还给用户，否则
              // 取消后卡片死在「登录已取消」上。
              <Button
                variant="primary"
                disabled={auth.attempt?.running === true}
                onClick={() => props.onBegin(props.provider)}
              >
                {authorized ? '重新登录' : '再次登录'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={auth.attempt?.running === true}
            onClick={() => props.onBegin(props.provider)}
          >
            {authorized ? '重新登录' : '登录'}
          </Button>
        </div>
      )}
    </section>
  )
}

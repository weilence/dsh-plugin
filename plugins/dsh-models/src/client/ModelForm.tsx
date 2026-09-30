import { useEffect, useMemo, useRef, useState } from 'react'
import { DisclosureRow, Switch, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { THINKING_LEVELS, type PiAiModelEntry, type PiAiModality, type ThinkingLevel } from '../pi-ai/types'
import type { ModelsDevLookup } from '../catalog/matching'
import { jsonEqual } from '../pi-ai/ops'
import { validateModelEntry, type FieldIssue } from '../pi-ai/validate'
import type { ModelRow } from '../pi-ai/profile'
import type { EffectiveModelFacts } from './operations'
import { IssueList, TextAreaField, TextField } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import local from './ModelForm.module.css'

const styles = { ...shared, ...local }

export interface ModelFormProps {
  /** 被编辑的行（新建时为空白行，id 可编辑）。 */
  row: ModelRow
  creating: boolean
  existingRows: readonly ModelRow[]
  /** 该行当前生效的能力事实（新建时为 undefined；用于 placeholder 显示默认值）。 */
  facts: EffectiveModelFacts | undefined
  /** route 级默认容量（schema 默认值）；placeholder 的最后一级回退。 */
  routeDefaults?: { contextWindow?: number; maxTokens?: number }
  /**
   * 该 route 安装目录里的模型 id（仅目录 route 有）。新建时若输入的 id 不在其中，
   * 官方 `modelOverrides` 无法承载它，保存会展开整份 `models` 清单——提前给出明确警告。
   */
  catalogIds?: ReadonlySet<string>
  busy: boolean
  /** 实时应用：任一有效修改立即折叠进所在页面的草稿（不写文件）。 */
  onChange(entry: PiAiModelEntry): void
  /**
   * 新增模式下按 models.dev 元数据自动填充：传入模型 id，返回填充候选与
   * 命中来源；目录不可用或未收录返回 undefined。
   */
  onLookupMetadata?(id: string): Promise<ModelsDevLookup | undefined>
}

export interface Draft {
  name: string
  contextWindow: string
  maxTokens: string
  /** text 恒选（Agent 必需、不可取消），这里只记录可选的 image。 */
  input: { image: boolean }
  /** 勾选 = 显式禁用推理（reasoningEfforts: false），此时等级表整体禁用。 */
  disableEfforts: boolean
  efforts: Partial<Record<ThinkingLevel, string>>
  compatText: string
}

function effortModeValues(value: PiAiModelEntry['reasoningEfforts']): Partial<Record<ThinkingLevel, string>> {
  if (value === undefined || value === false) return {}
  const result: Partial<Record<ThinkingLevel, string>> = {}
  for (const level of THINKING_LEVELS) {
    const wire = value[level]
    if (wire === undefined) continue
    result[level] = wire === null ? '' : wire
  }
  return result
}

// 只有用户层显式写过的字段才预填；没写的一律留空 = 继承，placeholder 显示
// 当前生效的默认值——留空保存不会把继承值写成显式配置。
function initialDraft(row: ModelRow, facts: EffectiveModelFacts | undefined): Draft {
  const entry = row.userEntry
  const input = entry?.input ?? facts?.inputModalities
  const name =
    entry?.name ??
    [facts?.name, row.catalogEntry?.name].find(
      (candidate) => candidate !== undefined && candidate !== row.id,
    ) ??
    ''
  const efforts: Partial<Record<ThinkingLevel, string>> =
    entry?.reasoningEfforts === undefined ? {} : effortModeValues(entry.reasoningEfforts)
  if (entry?.reasoningEfforts === undefined) {
    const effectiveIds = new Set((facts?.reasoning?.efforts ?? []).map((effort) => effort.id))
    for (const level of THINKING_LEVELS) {
      if (effectiveIds.has(level)) efforts[level] = level === 'off' ? '' : level
    }
  }
  return {
    name,
    contextWindow: entry?.contextWindow === undefined ? '' : String(entry.contextWindow),
    maxTokens: entry?.maxTokens === undefined ? '' : String(entry.maxTokens),
    input: { image: input?.includes('image') ?? false },
    disableEfforts: entry?.reasoningEfforts === false,
    efforts,
    compatText: entry?.compat === undefined ? '' : JSON.stringify(entry.compat, null, 2),
  }
}

function sameModalities(a: readonly PiAiModality[], b: readonly string[]) {
  return a.length === b.length && a.every((modality) => b.includes(modality))
}

/**
 * 草稿 → 官方条目：勾选即设置（推理等级勾了才写字典、全不勾 = 不写该
 * 字段）；输入模态与继承默认一致时不写 input（保持继承态，配置最小化）。
 */
function draftToEntry(id: string, draft: Draft, defaultInput?: readonly string[]): PiAiModelEntry {
  const entry: PiAiModelEntry = { id }
  if (draft.name.trim().length > 0) entry.name = draft.name.trim()
  if (draft.contextWindow.trim().length > 0) entry.contextWindow = Number(draft.contextWindow)
  if (draft.maxTokens.trim().length > 0) entry.maxTokens = Number(draft.maxTokens)
  // text 是 Agent 必需模态，恒选；没有已知的继承默认时以 ['text'] 为隐式基线。
  const input: PiAiModality[] = ['text']
  if (draft.input.image) input.push('image')
  const baseline = defaultInput !== undefined && defaultInput.length > 0 ? defaultInput : ['text']
  if (!sameModalities(input, baseline)) entry.input = input
  if (draft.disableEfforts) {
    entry.reasoningEfforts = false
  } else {
    const raw: Partial<Record<ThinkingLevel, string | null>> = {}
    for (const level of THINKING_LEVELS) {
      const wire = draft.efforts[level]
      if (wire === undefined) continue
      // off 留空 = null（支持但不发送参数）；其余等级留空 = 非法空串，交给校验报错。
      raw[level] = wire.trim().length === 0 ? (level === 'off' ? null : '') : wire.trim()
    }
    if (Object.keys(raw).length > 0) entry.reasoningEfforts = raw
  }
  if (draft.compatText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(draft.compatText)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        entry.compat = parsed as Record<string, unknown>
      }
    } catch {
      // 由 issuesFor 报告
    }
  }
  return entry
}

function compatIssue(text: string): FieldIssue[] {
  if (text.trim().length === 0) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [{ path: 'compat', message: 'compat 必须是 JSON 对象' }]
    }
  } catch (error) {
    return [{ path: 'compat', message: `compat 不是合法 JSON：${(error as Error).message}` }]
  }
  return []
}

function issuesFor(entry: PiAiModelEntry, draft: Draft): FieldIssue[] {
  const issues = validateModelEntry(entry)
  issues.push(...compatIssue(draft.compatText))
  return issues
}

/** models.dev 条目 → 表单可自动填充的字段值（compat 不来自目录，不参与）。 */
function autofillValuesOf(entry: PiAiModelEntry) {
  return {
    name: entry.name ?? '',
    contextWindow: entry.contextWindow !== undefined ? String(entry.contextWindow) : '',
    maxTokens: entry.maxTokens !== undefined ? String(entry.maxTokens) : '',
    image: entry.input?.includes('image') ?? false,
    disableEfforts: entry.reasoningEfforts === false,
    efforts: effortModeValues(entry.reasoningEfforts),
  }
}

function adopted<T>(
  current: T,
  blankValue: T,
  previousValue: T | undefined,
  next: T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  if (isEqual(current, blankValue)) return next
  if (previousValue !== undefined && isEqual(current, previousValue)) return next
  return current
}

/**
 * 自动填充合并：字段当前为空白、或仍等于上一次填充值时采纳新值，用户手动
 * 改过的字段永不覆盖——半截 id 的误填充随输入完成自动纠正（与导入合并
 * 语义同构：已有用户字段优先，填充只补缺失）。
 */
export function mergedAutofillDraft(
  draft: Draft,
  entry: PiAiModelEntry,
  previous: PiAiModelEntry | undefined,
): Draft {
  const next = autofillValuesOf(entry)
  const previousValues = previous === undefined ? undefined : autofillValuesOf(previous)
  const blank = autofillValuesOf({ id: entry.id })
  return {
    ...draft,
    name: adopted(draft.name, blank.name, previousValues?.name, next.name),
    contextWindow: adopted(
      draft.contextWindow,
      blank.contextWindow,
      previousValues?.contextWindow,
      next.contextWindow,
    ),
    maxTokens: adopted(draft.maxTokens, blank.maxTokens, previousValues?.maxTokens, next.maxTokens),
    input: { image: adopted(draft.input.image, blank.image, previousValues?.image, next.image) },
    disableEfforts: adopted(
      draft.disableEfforts,
      blank.disableEfforts,
      previousValues?.disableEfforts,
      next.disableEfforts,
    ),
    efforts: adopted(draft.efforts, blank.efforts, previousValues?.efforts, next.efforts, jsonEqual),
  }
}

/** id 自动填充的防抖：停顿即查询，与表单实时应用哲学一致。 */
const AUTOFILL_DEBOUNCE_MS = 500

type AutofillStatus = { state: 'loading' | 'matched' | 'none'; source?: string } | undefined

export function ModelForm(props: ModelFormProps) {
  const [id, setId] = useState(props.row.id)
  const [draft, setDraft] = useState<Draft>(() => initialDraft(props.row, props.facts))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [autofillStatus, setAutofillStatus] = useState<AutofillStatus>(undefined)
  /** 上一次自动填充的条目：重查时判定「哪些字段仍是我们填的」。 */
  const autofillEntryRef = useRef<PiAiModelEntry | undefined>(undefined)
  const lookupRef = useRef(props.onLookupMetadata)
  lookupRef.current = props.onLookupMetadata

  // 新增模式的 id 防抖查询：回调经 ref 取最新，父组件重渲染不重置计时；
  // 结果按 mergedAutofillDraft 合并（只补空白 / 替换上次填充）。
  useEffect(() => {
    if (!props.creating) return
    const trimmed = id.trim()
    if (trimmed.length === 0 || lookupRef.current === undefined) {
      setAutofillStatus(undefined)
      return
    }
    let cancelled = false
    setAutofillStatus({ state: 'loading' })
    const timer = setTimeout(() => {
      void lookupRef.current?.(trimmed).then((found) => {
        if (cancelled) return
        if (found === undefined) {
          setAutofillStatus({ state: 'none' })
          return
        }
        setDraft((current) => mergedAutofillDraft(current, found.entry, autofillEntryRef.current))
        autofillEntryRef.current = found.entry
        setAutofillStatus({
          state: 'matched',
          ...(found.source === undefined ? {} : { source: found.source }),
        })
      })
    }, AUTOFILL_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // 只有 id 与编辑模式参与防抖重置；查询回调与上次填充均经 ref 读取最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, props.creating])

  const entry = useMemo(() => {
    const defaultInput = props.facts?.inputModalities ?? props.row.catalogEntry?.input
    return draftToEntry(id.trim(), draft, defaultInput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, draft, props.facts, props.row.catalogEntry])
  const issues = useMemo(() => issuesFor(entry, draft), [entry, draft])
  const duplicate = props.creating && props.existingRows.some((row) => row.id === id.trim())
  const allIssues = duplicate
    ? [...issues, { path: 'id', message: `模型 id「${id.trim()}」已存在于本 Provider` }]
    : issues

  /** 打开表单时的初始条目：用于判定用户是否修改过（修改过即持续推送）。 */
  const initialEntryRef = useRef<PiAiModelEntry | undefined>(undefined)
  if (initialEntryRef.current === undefined) initialEntryRef.current = entry
  const [mutated, setMutated] = useState(false)
  const mutatedRef = useRef(false)

  // 实时应用：用户修改过之后每个有效状态都立即推给外层折叠进草稿——包括
  // 「改回初始值」；有校验问题时暂停推送，修正后自动继续。
  useEffect(() => {
    if (!mutatedRef.current && !jsonEqual(entry, initialEntryRef.current)) {
      mutatedRef.current = true
      setMutated(true)
    }
    if (!mutatedRef.current || allIssues.length > 0) return
    props.onChange(entry)
    // entry / allIssues 变化即推送；onChange 由外层保证语义稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, allIssues])

  return (
    <div className={styles.modelFormBox}>
      {/* 编辑态卡片行头已标识模型，不再重复标题；新增态保留，标示这是新条目表单。 */}
      {props.creating ? <h3 className={styles.sectionTitle}>新增模型</h3> : null}

      {mutated && allIssues.length > 0 ? <IssueList issues={allIssues} /> : null}

      {props.creating &&
      props.catalogIds !== undefined &&
      id.trim().length > 0 &&
      !props.catalogIds.has(id.trim()) ? (
        <div className={styles.notice}>
          模型 <code className={styles.code}>{id.trim()}</code> 不在 pi-ai 安装目录里。官方{' '}
          <code className={styles.code}>modelOverrides</code> 不能指定目录未描述的模型，因此保存会把该 route
          固定为一份显式 <code className={styles.code}>models</code> 清单：以后 pi-ai
          升级新增的目录模型不会自动出现。
        </div>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>基础</h3>
        <div className={styles.grid}>
          <TextField
            label="模型 ID（请求时发送给 Provider）"
            value={id}
            disabled={!props.creating || props.busy}
            onChange={setId}
          />
          <TextField
            label="显示名（留空显示 ID）"
            value={draft.name}
            disabled={props.busy}
            placeholder={props.row.id}
            onChange={(value) => setDraft({ ...draft, name: value })}
          />
          <TextField
            label="上下文窗口（token 总数）"
            inputMode="numeric"
            value={draft.contextWindow}
            disabled={props.busy}
            placeholder={placeholderNumber(
              props.facts?.contextWindow ??
                props.row.catalogEntry?.contextWindow ??
                props.routeDefaults?.contextWindow,
            )}
            onChange={(value) => setDraft({ ...draft, contextWindow: value })}
          />
          <TextField
            label="最大输出 token"
            inputMode="numeric"
            value={draft.maxTokens}
            disabled={props.busy}
            placeholder={placeholderNumber(
              props.facts?.defaultMaxTokens ??
                props.row.catalogEntry?.maxTokens ??
                props.routeDefaults?.maxTokens,
            )}
            onChange={(value) => setDraft({ ...draft, maxTokens: value })}
          />
        </div>
        {props.creating && autofillStatus !== undefined ? (
          <div className={autofillStatus.state === 'matched' ? styles.notice : styles.hint}>
            {autofillStatus.state === 'loading'
              ? '正在按 models.dev 查询模型元数据…'
              : autofillStatus.state === 'matched'
                ? `已按 models.dev${autofillStatus.source === undefined ? '' : `（${autofillStatus.source}）`}填充空白字段，可手动修改`
                : 'models.dev 未收录该模型（或目录暂不可用），可手动填写能力字段'}
          </div>
        ) : null}
        <p className={styles.hint}>
          显式配置 <code className={styles.code}>maxTokens</code>{' '}
          后，它不仅描述模型能力，还会成为该模型每次请求的默认输出上限。
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>输入模态</h3>
        <div className={styles.checkRow}>
          <label className={styles.check}>
            <Switch checked disabled onChange={() => {}} label="text" />
            text（Agent 必需）
          </label>
          <label className={styles.check}>
            <Switch
              checked={draft.input.image}
              disabled={props.busy}
              onChange={(next) => setDraft({ ...draft, input: { ...draft.input, image: next } })}
              label="image"
            />
            image（图像输入）
          </label>
        </div>
        <p className={styles.hint}>
          text 恒选且不可取消；勾选结果与继承默认一致时不写 <code className={styles.code}>input</code>
          （保持继承），不同才显式写入。
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>推理强度</h3>
        <label className={styles.check}>
          <Switch
            checked={draft.disableEfforts}
            disabled={props.busy}
            onChange={(next) => setDraft({ ...draft, disableEfforts: next })}
            label="不支持推理"
          />
          不支持推理（<code className={styles.code}>reasoningEfforts: false</code>）
        </label>
        <div
          className={
            draft.disableEfforts ? `${styles.effortTable} ${styles.effortTableDisabled}` : styles.effortTable
          }
        >
          {THINKING_LEVELS.map((level) => {
            const value = draft.efforts[level]
            const checked = value !== undefined
            return (
              <div className={styles.effortRow} key={level}>
                <label className={styles.check}>
                  <Switch
                    checked={checked}
                    disabled={props.busy || draft.disableEfforts}
                    onChange={(next) => {
                      const nextEfforts = { ...draft.efforts }
                      if (next) nextEfforts[level] = level === 'off' ? '' : level
                      else delete nextEfforts[level]
                      setDraft({ ...draft, efforts: nextEfforts })
                    }}
                    label={level}
                  />
                  <code className={styles.code}>{level}</code>
                </label>
                <input
                  className={styles.input}
                  value={value ?? ''}
                  disabled={!checked || props.busy || draft.disableEfforts}
                  placeholder={level === 'off' ? '留空 = 不发送参数' : level}
                  onChange={(event) =>
                    setDraft({ ...draft, efforts: { ...draft.efforts, [level]: event.target.value } })
                  }
                />
              </div>
            )
          })}
          <p className={styles.hint}>
            勾选等级会自动预填同名 wire 值，可手动修改。<code className={styles.code}>off</code> 留空 =
            不发送参数；其余等级必须给出非空值，且至少要有一个非 <code className={styles.code}>off</code>{' '}
            等级。全不勾选 = 不写 <code className={styles.code}>reasoningEfforts</code>
            （档位继承目录），与上方「不支持推理」（显式写 <code className={styles.code}>false</code>
            ）是两种不同的状态。
          </p>
        </div>
      </section>

      <section className={styles.section}>
        <DisclosureRow
          icon={<IconSettingsOutlineRegular />}
          title="高级（compat，含推理参数格式 thinkingFormat）"
          open={showAdvanced}
          expandable
          expandOnRowClick
          onToggle={() => setShowAdvanced(!showAdvanced)}
        >
          <TextAreaField
            label="compat（JSON 对象，选填）"
            value={draft.compatText}
            placeholder={'{\n  "thinkingFormat": "openai"\n}'}
            onChange={(value) => setDraft({ ...draft, compatText: value })}
          />
          <p className={styles.hint}>
            模型级 compat 只在其协议（由 route 的 <code className={styles.code}>api</code>{' '}
            决定）支持该字段时才被 Host 接受。要让推理强度真正过线，在这里设置{' '}
            <code className={styles.code}>thinkingFormat</code>
            （openai-compatible 网关多为 <code className={styles.code}>openai</code>，DeepSeek 用{' '}
            <code className={styles.code}>deepseek</code>，vLLM/OpenRouter 等各有自己的值）。
          </p>
        </DisclosureRow>
      </section>
    </div>
  )
}

function placeholderNumber(value: number | undefined) {
  return value === undefined ? '默认' : String(value)
}

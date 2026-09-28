/**
 * 技能表单（新建 / 编辑）与只读视图，内嵌在列表的展开卡片里。
 * 编辑：加载原文做行级 frontmatter 往返（未知字段原样保留），名称锁定；
 * 只读：展示元信息与原文。保存成功后回调 onDone，由父级收起卡片。
 */

import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, MetaItem, SelectField, TextAreaField, TextField } from '@dsh-plugins/client-ui'
import type { RootId, RootInfo, SaveRequest, SkillFormat, SkillRow } from '../shared'
import { SKILL_NAME_PATTERN, sourceLabel } from '../shared'
import { bodyForEditor, parseKnown, splitFrontmatter } from '../frontmatter'
import type { SkillsStore } from './store'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SkillsSection.module.css'

const styles = { ...shared, ...local }

export interface SkillFormProps {
  mode: 'create' | 'edit'
  skill?: SkillRow
  roots: readonly RootInfo[]
  skills: readonly SkillRow[]
  busy: boolean
  error: string | null
  store: SkillsStore
  /** 保存成功后回调（父级收起卡片）。 */
  onDone(): void
  /** 取消编辑（父级收起卡片，未保存的草稿丢弃）。 */
  onCancel(): void
}

interface DraftState {
  rootId: RootId
  name: string
  format: SkillFormat
  description: string
  whenToUse: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}

const CREATE_PLACEHOLDER = `# 指南标题（可选）

一步一步的操作说明……`

export function SkillForm(props: SkillFormProps) {
  const { mode, skill, store } = props
  const [loaded, setLoaded] = useState<string | null>(mode === 'create' ? '' : null)
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props))
  const [touched, setTouched] = useState(false)

  // 编辑：拉原文并填表（frontmatter 行级往返）。
  useEffect(() => {
    if (mode === 'create' || skill === undefined || skill.path === undefined) return
    let cancelled = false
    setLoaded(null)
    void store.loadFile(skill.name, skill.path).then((text) => {
      if (cancelled || text === null) return
      setLoaded(text)
      const split = splitFrontmatter(text)
      const known = parseKnown(split?.fm ?? '')
      setDraft((previous) => ({
        ...previous,
        name: skill.name,
        description: known.description ?? skill.description,
        whenToUse: known.whenToUse ?? skill.whenToUse ?? '',
        modelInvocable: !(known.disableModelInvocation === true),
        userInvocable: known.userInvocable !== false,
        body: split === undefined ? text : bodyForEditor(split.body),
      }))
    })
    return () => {
      cancelled = true
    }
    // 卡片按技能身份挂载，加载一次即止。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const issues = validateDraft(draft, mode, props.skills)
  const busy = props.busy || loaded === null

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const request: SaveRequest = {
      ...(store.getSnapshot().scope === '' ? {} : { cwd: store.getSnapshot().scope }),
      rootId: draft.rootId,
      name: draft.name,
      ...(mode === 'create' ? { format: draft.format } : {}),
      description: draft.description.trim(),
      ...(draft.whenToUse.trim().length > 0 ? { whenToUse: draft.whenToUse.trim() } : {}),
      modelInvocable: draft.modelInvocable,
      userInvocable: draft.userInvocable,
      body: draft.body,
      ...(mode === 'edit' && skill?.path !== undefined ? { editPath: skill.path } : {}),
    }
    if (await store.save(request)) props.onDone()
  }

  return (
    <div className={styles.section}>
      {mode === 'create' ? (
        <div className={styles.grid}>
          <SelectField
            label="目标根"
            value={draft.rootId}
            options={props.roots.map((root) => ({
              value: root.id,
              label: `${root.label}（${root.path}）`,
            }))}
            onChange={(rootId) => setDraft((previous) => ({ ...previous, rootId: rootId as RootId }))}
          />
          <SelectField
            label="形态"
            value={draft.format}
            options={[
              { value: 'flat', label: '单文件（<name>.md）' },
              { value: 'bundle', label: '目录包（<name>/SKILL.md，可带资源）' },
            ]}
            onChange={(format) => setDraft((previous) => ({ ...previous, format: format as SkillFormat }))}
          />
          <TextField
            label="名称（kebab-case）"
            value={draft.name}
            placeholder="my-skill"
            onChange={(name) => setDraft((previous) => ({ ...previous, name }))}
          />
        </div>
      ) : (
        <div className={styles.grid}>
          <TextField label="名称（编辑时不可改）" value={draft.name} disabled onChange={() => {}} />
          <div className={styles.field}>
            <span className={styles.label}>目标</span>
            <span className={styles.hintLine}>{skill?.path}</span>
          </div>
        </div>
      )}
      <TextField
        label="描述（必填，模型路由依据）"
        wide
        value={draft.description}
        placeholder="一句话说明这个技能做什么、什么时候用"
        onChange={(description) => setDraft((previous) => ({ ...previous, description }))}
      />
      <TextField
        label="适用时机（可选 whenToUse）"
        wide
        value={draft.whenToUse}
        placeholder="补充路由提示：什么情况下应该选用这个技能"
        onChange={(whenToUse) => setDraft((previous) => ({ ...previous, whenToUse }))}
      />
      <div className={styles.checkRow}>
        <label className={styles.check}>
          <Switch
            checked={draft.modelInvocable}
            onChange={(checked) => setDraft((previous) => ({ ...previous, modelInvocable: checked }))}
            label="允许模型调用"
          />
          允许模型调用（进入 skill 工具目录）
        </label>
        <label className={styles.check}>
          <Switch
            checked={draft.userInvocable}
            onChange={(checked) => setDraft((previous) => ({ ...previous, userInvocable: checked }))}
            label="允许用户调用"
          />
          允许用户 /命令调用
        </label>
      </div>
      <TextAreaField
        label="正文（Markdown 指令）"
        value={draft.body}
        placeholder={CREATE_PLACEHOLDER}
        spellCheck={false}
        minHeight={260}
        onChange={(body) => setDraft((previous) => ({ ...previous, body }))}
      />
      {touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
      {props.error ? (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      ) : null}
      <div className={styles.formActions}>
        <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {props.busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

function initialDraft(props: SkillFormProps): DraftState {
  const preferRoot = props.roots.find((root) => root.id === 'user-dsh') ?? props.roots[0]
  return {
    rootId: preferRoot?.id ?? 'user-dsh',
    name: '',
    format: 'flat',
    description: '',
    whenToUse: '',
    modelInvocable: true,
    userInvocable: true,
    body: '',
  }
}

function validateDraft(draft: DraftState, mode: 'create' | 'edit', known: readonly SkillRow[]): string[] {
  const issues: string[] = []
  // 名称检查只在新建做：编辑时名称锁定，无效名称的修复 = 删除后新建。
  if (mode === 'create') {
    if (!SKILL_NAME_PATTERN.test(draft.name)) {
      issues.push('名称需为 kebab-case：小写字母 / 数字 / 连字符，如 commit-message-style')
    } else if (known.some((skill) => skill.name === draft.name && skill.rootId === draft.rootId)) {
      // 同根同名会直接撞文件（host 侧 409）；跨根同名是合法的遮蔽用法，不拦。
      issues.push(`目标根里已存在同名技能「${draft.name}」`)
    }
  }
  if (draft.description.trim().length === 0) issues.push('描述不能为空')
  return issues
}

/** 只读视图（只读来源 / Git 安装的技能展开体）：元信息 + 原文。 */
export function SkillView(props: {
  skill: SkillRow
  busy: boolean
  error: string | null
  store: SkillsStore
}) {
  const { skill, store } = props
  const [loaded, setLoaded] = useState<string | null>(null)

  useEffect(() => {
    if (skill.path === undefined) return
    let cancelled = false
    setLoaded(null)
    void store.loadFile(skill.name, skill.path).then((text) => {
      if (!cancelled && text !== null) setLoaded(text)
    })
    return () => {
      cancelled = true
    }
    // 按技能身份挂载，加载一次即止。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.section}>
      <div className={styles.metaGrid}>
        <MetaItem label="名称" value={skill.name} />
        <MetaItem label="来源" value={sourceLabel(skill.source)} />
        {skill.git !== undefined ? (
          <MetaItem
            label="Git 仓库"
            value={`${skill.git.url}（${skill.git.dir}，安装于 ${skill.git.installedAt.slice(0, 10)}）`}
            wide
          />
        ) : null}
        <MetaItem label="描述" value={skill.description} wide />
        {skill.whenToUse !== undefined ? <MetaItem label="适用时机" value={skill.whenToUse} wide /> : null}
        <MetaItem
          label="调用策略"
          value={`${skill.modelInvocable ? '模型可调用' : '模型不可调用'} · ${skill.userInvocable ? '用户可调用' : '用户不可调用'}`}
        />
      </div>
      {props.error ? (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      ) : null}
      <TextAreaField label="原文" value={loaded ?? '加载中…'} readOnly minHeight={320} spellCheck={false} />
    </div>
  )
}

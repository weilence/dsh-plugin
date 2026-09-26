import { useRef, useState } from 'react'
import { Button, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsDevCatalog } from '../catalog/types'
import type { PanelRoute } from '../pi-ai/view'
import { validateApiKey } from './operations'
import { ModelsDevImport, type ModelsDevImportHandle, type ModelsDevImportProps } from './ModelsDevImport'
import { IssueList, SelectField, TextField } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import local from './CreateProviderDialog.module.css'

const styles = { ...shared, ...local }

export function CreateProviderDialog(props: {
  busy: boolean
  /** store 级最近错误（写入失败等）：弹窗内展示，避免被遮罩挡住。 */
  error: string | null
  /** 已被任何层配置过的 route（含手写），不能重复创建。 */
  knownProviders: readonly string[]
  /** pi-ai 内置但尚未配置的 route：选中即继承目录，无需填协议与 Endpoint。 */
  dormantProviders: readonly string[]
  catalog: ModelsDevCatalog | null
  modelsDevLoading: boolean
  modelsDevError: string | null
  /** 已配置的 route（自定义 Provider 只能新建，命中即拒绝）。 */
  routes: readonly PanelRoute[]
  onCancel(): void
  onLoadCatalog(): void
  onCreate(provider: string, profile: Record<string, unknown>, apiKey?: string): void
  onSaveProfile: ModelsDevImportProps['onSaveProfile']
  onFetchModels: ModelsDevImportProps['onFetchModels']
  onError(message: string): void
}) {
  const [mode, setMode] = useState<'builtin' | 'modelsdev'>(
    props.dormantProviders.length > 0 ? 'builtin' : 'modelsdev',
  )
  const [builtinId, setBuiltinId] = useState(props.dormantProviders[0] ?? '')
  const [displayName, setDisplayName] = useState('')
  const [key, setKey] = useState('')
  const [touched, setTouched] = useState(false)
  const importRef = useRef<ModelsDevImportHandle | null>(null)

  const issues: string[] = []
  if (mode === 'builtin') {
    if (builtinId.length === 0) issues.push('请选择一个内置 Provider')
    if (props.knownProviders.includes(builtinId)) issues.push(`Provider ID「${builtinId}」已存在`)
  }
  const keyError = key.trim().length > 0 ? validateApiKey(key) : undefined
  if (keyError) issues.push(keyError)

  const submit = () => {
    setTouched(true)
    if (issues.length > 0) return
    if (mode === 'builtin') {
      // 显示名为空时不写 displayName：展示回退内置目录的名称 / Provider ID。
      const name = displayName.trim()
      props.onCreate(
        builtinId,
        name.length > 0 ? { displayName: name } : {},
        key.trim().length > 0 ? key.trim() : undefined,
      )
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!props.busy) props.onCancel()
      }}
      title="新建 Provider"
      closeLabel="关闭"
      className={mode === 'modelsdev' ? styles.dialog : styles.dialogSmall}
      contentClassName={styles.scrollBody}
      footer={
        mode === 'modelsdev' ? (
          <Button variant="primary" disabled={props.busy} onClick={() => importRef.current?.apply()}>
            {props.busy ? '创建中…' : '创建'}
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
              取消
            </Button>
            <Button variant="primary" disabled={props.busy} onClick={submit}>
              {props.busy ? '创建中…' : '创建'}
            </Button>
          </>
        )
      }
    >
      {/* 创建方式始终可见，切到自定义 Provider 后仍可换方式。 */}
      <div className={styles.modeBar}>
        <div className={styles.checkRow}>
          <Pill
            active={mode === 'builtin'}
            disabled={props.dormantProviders.length === 0}
            onClick={() => setMode('builtin')}
          >
            使用内置 Provider
          </Pill>
          <Pill
            active={mode === 'modelsdev'}
            onClick={() => {
              setMode('modelsdev')
              props.onLoadCatalog()
            }}
          >
            自定义 Provider
          </Pill>
        </div>
      </div>
      {props.error ? (
        <div className={`${styles.error} ${styles.dialogError}`} role="alert">
          {props.error}
        </div>
      ) : null}
      {mode === 'modelsdev' ? (
        <ModelsDevImport
          ref={importRef}
          catalog={props.catalog}
          loading={props.modelsDevLoading}
          error={props.modelsDevError}
          routes={props.routes}
          busy={props.busy}
          onCancel={props.onCancel}
          onError={props.onError}
          onSaveProfile={props.onSaveProfile}
          onFetchModels={props.onFetchModels}
        />
      ) : (
        <>
          {touched && issues.length > 0 ? (
            <IssueList issues={issues.map((message) => ({ message }))} />
          ) : null}
          <div className={styles.grid}>
            <SelectField
              label="内置 Provider"
              value={builtinId}
              options={props.dormantProviders.map((id) => ({ value: id, label: id }))}
              onChange={setBuiltinId}
            />
            <TextField label="显示名（可选）" value={displayName} onChange={setDisplayName} />
            <TextField label="API Key" type="password" autoComplete="off" value={key} onChange={setKey} />
          </div>
        </>
      )}
    </Modal>
  )
}

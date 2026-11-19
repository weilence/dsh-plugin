import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only：ctx.configEditor 的 Context 声明合并（dsh-config-editor 契约类型）。
import type {} from '@deepseek-ai/dsh-config-editor'
import { WebError } from '@deepseek-ai/dsh-web'
import { errMsg } from '@dsh-plugins/shared'
import { ZhipuFetchProvider, ZhipuSearchProvider } from './providers'
import { createZhipuReader } from './reader'
import { createZhipuSearch } from './search'
import { FETCH_PROVIDER_TITLES, KEY_REFS, SEARCH_PROVIDER_TITLES } from './shared'

export const inject: string[] = ['credentials', 'web', 'configEditor']

export async function apply(ctx: Context) {
  // 缺席才尝试次选；首选解析失败时继续搜索会悄然切换账户和计费凭据。
  async function resolveKey(): Promise<{ key: string | null; failure: string | undefined }> {
    for (const name of KEY_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(name as CredentialRef)
        if (resolved) return { key: resolved.value, failure: undefined }
      } catch (error) {
        return { key: null, failure: `凭证解析失败（${name}: ${errMsg(error)}）` }
      }
    }
    return { key: null, failure: undefined }
  }

  // 搜索与网页阅读共用一把凭据、同一种失败语义。
  const requireKey = async (): Promise<string> => {
    const { key, failure } = await resolveKey()
    if (failure) throw new WebError(failure, 'WEB_PROVIDER_ERROR')
    if (!key) {
      throw new WebError('未配置智谱 Coding Plan API Key（ZAI_CODING_CN_API_KEY）', 'WEB_PROVIDER_ERROR')
    }
    return key
  }
  const search = createZhipuSearch(requireKey)
  const read = createZhipuReader(requireKey)

  // available() 须同步且不发网络：凭据在场性用快照表达。
  let credentialReady = false
  async function probeCredential(): Promise<{ key: string | null; failure: string | undefined }> {
    const resolved = await resolveKey()
    credentialReady = resolved.key !== null
    return resolved
  }

  // 界面语言偏好存宿主 user-settings（locale 行，与官方语言设置同一事实源）；
  // 缺席 = 跟随浏览器，各客户端语言可不同，宿主无从得知。
  function localePreference(): string | undefined {
    const row = ctx.configEditor.configuration().find((item) => item.entry.options.id === 'locale')
    if (row === undefined) return undefined
    const effective = Object.keys(row.override).length > 0 ? row.override : row.inherited
    const preference = (effective as { preference?: unknown }).preference
    return typeof preference === 'string' && preference.length > 0 ? preference : undefined
  }

  // 下拉显示名启动时取一：显式 zh* 用中文，其余（含缺席 = 跟随浏览器）用英文；
  // 运行中改语言需重启或 HMR 重载后生效。
  function resolveTitle(preference: string | undefined, titles: { zh: string; en: string }): string {
    if (preference !== undefined && preference.toLowerCase().startsWith('zh')) return titles.zh
    return titles.en
  }
  const preference = localePreference()
  const searchTitle = resolveTitle(preference, SEARCH_PROVIDER_TITLES)
  const fetchTitle = resolveTitle(preference, FETCH_PROVIDER_TITLES)

  // 注册随本插件 fiber 生灭：HMR 重载自动换新，卸载即从注册表消失。
  ctx.effect(() => {
    const disposeSearch = ctx.web.registerSearchProvider(
      new ZhipuSearchProvider(searchTitle, search, () => credentialReady),
    )
    const disposeFetch = ctx.web.registerFetchProvider(
      new ZhipuFetchProvider(fetchTitle, read, () => credentialReady),
    )
    return () => {
      disposeSearch()
      disposeFetch()
    }
  }, 'dsh-zhipu-tools: web providers')

  // 补配后无需重启：provider 写入或存储变更提交后刷新快照（进程环境变量不可观测，重启即重读）。
  ctx.effect(
    () =>
      ctx.on('credentials/reference-updated', (ref) => {
        if (!(KEY_REFS as readonly string[]).includes(ref)) return
        void probeCredential().then(({ failure: credentialFailure }) => {
          if (credentialFailure !== undefined) {
            ctx.logger.error(`dsh-zhipu-tools: ${credentialFailure}`)
          }
        })
      }),
    'dsh-zhipu-tools: credential snapshot refresh',
  )

  const { key: apiKey, failure } = await probeCredential()
  if (failure !== undefined) {
    ctx.logger.error(`dsh-zhipu-tools: ${failure}，智谱 provider 保持不可用`)
  } else if (apiKey === null) {
    ctx.logger.error('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱 provider 保持不可用')
  }
}

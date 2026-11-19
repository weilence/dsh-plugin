import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 本插件的词典命名空间：经 `ctx.locale.register` 注册、`ctx.locale.bind` 取词，
 * 语言选择与回退由宿主 locale 服务统一裁决，插件不自建语言状态。
 */
export const NS = 'dsh-gitlab'

export type GitlabT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': 'GitLab',
  'panel.subtitle':
    '配置 GitLab 站点连接并检查 glab CLI 环境：保存后 glab 工具即可使用。认证使用你自己的 glab 登录态（glab auth login），插件不代存 token；「测试连接」验证认证是否有效。',

  'action.new': '新建站点',
  'action.refresh': '刷新',
  'action.edit': '编辑',
  'action.test': '测试连接',
  'action.testing': '测试中…',
  'action.saving': '保存中…',

  'list.loading': '正在读取站点列表…',
  'list.empty': '还没有站点。点「新建站点」添加你的 GitLab 站点（如 https://gitlab.example.com）。',
  'problems.title': '以下配置行无效，已忽略（可在 cordis.patch.yml 修正）：',

  'glab.found': 'glab：{path}（{version}）',
  'glab.broken': 'glab：{path}（版本探测失败：{error}）',
  'glab.missing': '未找到 glab 可执行文件：{error}',
  'glab.missingHint': '安装后点「刷新」重新探测；或在本插件行配置里用 glabPath 指定路径',

  'site.defaultBadge': '默认',
  'site.workspacesBadge': '工作区 ×{count}',

  'form.name': '站点名',
  'form.nameHint': '小写字母、数字、连字符；glab 工具的 site 参数按它寻址',
  'form.url': 'GitLab 地址',
  'form.urlHint': 'GitLab 根地址，如 https://gitlab.example.com',
  'form.workspaces': '关联工作区',
  'form.workspacesHint':
    '本站点关联的工作区目录绝对路径，逗号分隔（如 /Users/me/code/acme）；当前会话的工作目录命中且唯一时自动选此站点',
  'form.default': '设为默认站点',
  'form.defaultHint': '多站点时，工作区未唯一命中的调用落到默认站点',

  'validate.name': '站点名需匹配 ^[a-z0-9][a-z0-9-]{0,31}$，如 yamu',
  'validate.duplicate': '站点名「{name}」已存在',
  'validate.urlRequired': '站点需要 GitLab 地址',
  'validate.url': 'GitLab 地址必须是 http(s) URL',

  'test.ok': '认证有效：{user}',
  'test.fail': '失败：{reason}',
  'test.hint': '失败多因 glab 未认证或 token 失效：在终端运行 glab auth login --hostname <站点域名> 后重试',

  'delete.title': '删除站点 {name}',
  'delete.body': '将移除站点配置；进行中的 glab 调用会立即失败。你的 glab 登录态不受影响。',

  'notice.saved': '已保存站点 {name}',
  'notice.deleted': '已删除站点 {name}',
} as const

export type GitlabKey = keyof typeof zh

export const en: { [Key in GitlabKey]: string } = {
  'section.label': 'GitLab',
  'panel.subtitle':
    'Configure GitLab site connections and check the glab CLI environment: once saved, the glab tool becomes available. Authentication uses your own glab login (glab auth login); the plugin never stores tokens. "Test connection" verifies whether your auth works.',

  'action.new': 'New site',
  'action.refresh': 'Refresh',
  'action.edit': 'Edit',
  'action.test': 'Test connection',
  'action.testing': 'Testing…',
  'action.saving': 'Saving…',

  'list.loading': 'Reading sites…',
  'list.empty': 'No sites yet. Click "New site" to add your GitLab site (e.g. https://gitlab.example.com).',
  'problems.title': 'These config lines are invalid and ignored (fix them in cordis.patch.yml):',

  'glab.found': 'glab: {path} ({version})',
  'glab.broken': 'glab: {path} (version probe failed: {error})',
  'glab.missing': 'glab executable not found: {error}',
  'glab.missingHint':
    'Install glab and click "Refresh" to probe again; or set glabPath in this plugin row config',

  'site.defaultBadge': 'Default',
  'site.workspacesBadge': '{count} workspace(s)',

  'form.name': 'Site name',
  'form.nameHint': 'Lowercase letters, digits, hyphens; the glab tool addresses it via the site argument',
  'form.url': 'GitLab URL',
  'form.urlHint': 'The GitLab root address, e.g. https://gitlab.example.com',
  'form.workspaces': 'Linked workspaces',
  'form.workspacesHint':
    'Absolute workspace directories linked to this site, comma-separated (e.g. /Users/me/code/acme); the site is auto-selected when the current session directory matches it uniquely',
  'form.default': 'Set as default site',
  'form.defaultHint': 'Calls matching no workspace land here in multi-site setups',

  'validate.name': 'Site name must match ^[a-z0-9][a-z0-9-]{0,31}$, e.g. yamu',
  'validate.duplicate': 'Site name "{name}" already exists',
  'validate.urlRequired': 'Sites need a GitLab URL',
  'validate.url': 'GitLab URL must be an http(s) URL',

  'test.ok': 'Auth OK: {user}',
  'test.fail': 'Failed: {reason}',
  'test.hint':
    'Failures usually mean glab is unauthenticated or the token expired: run glab auth login --hostname <host> in a terminal and retry',

  'delete.title': 'Delete site {name}',
  'delete.body':
    'Removes the site configuration; in-flight glab calls fail immediately. Your glab login state is unaffected.',

  'notice.saved': 'Site {name} saved',
  'notice.deleted': 'Site {name} deleted',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-gitlab': GitlabKey
  }
}

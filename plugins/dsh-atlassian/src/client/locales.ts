import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 本插件的词典命名空间：经 `ctx.locale.register` 注册、`ctx.locale.bind` 取词，
 * 语言选择与回退由宿主 locale 服务统一裁决，插件不自建语言状态。
 */
export const NS = 'dsh-atlassian'

export type AtlassianT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'action.new': '新建站点',
  'action.refresh': '刷新',
  'action.edit': '编辑',
  'action.test': '测试连接',
  'action.testing': '测试中…',
  'action.saving': '保存中…',

  'list.loading': '正在读取站点列表…',
  'list.empty': '还没有站点。点「新建站点」添加 Jira / Confluence 所在的 Atlassian 站点。',
  'problems.title': '以下配置行无效，已忽略（可在 cordis.patch.yml 修正）：',

  'tool.jira.hits': 'Jira 命中 {count} 条',
  'tool.jira.shown': 'Jira 返回 {count} 条（总数未知）',
  'tool.conf.hits': 'Confluence 命中 {count} 条',
  'tool.conf.shown': 'Confluence 返回 {count} 条（总数未知）',
  'tool.search.truncated': '已截断',

  'site.kindCloud': 'Cloud',
  'site.kindServer': 'Server / DC',
  'site.defaultBadge': '默认',
  'site.workspacesBadge': '工作区 ×{count}',
  'site.commentFilterBadge': '评论过滤 ×{count}',
  'site.tokenConfigured': 'token 已配置',
  'site.tokenMissing': 'token 未配置',
  'site.jiraTokenOk': 'Jira token 已配置',
  'site.jiraTokenMissing': 'Jira token 未配置',
  'site.confTokenOk': 'Confluence token 已配置',
  'site.confTokenMissing': 'Confluence token 未配置',
  'site.tokenSource': '来源：{source}',
  'site.tokenBroken': 'token 状态不可知：{reason}',

  'form.titleNew': '新建站点',
  'form.titleEdit': '编辑站点 {name}',
  'form.name': '站点名',
  'form.nameHint': '小写字母、数字、连字符；工具的 site 参数与命令按它寻址',
  'form.kind': '部署类型',
  'form.atlassianUrl': 'Atlassian 地址',
  'form.atlassianUrlHint': 'Cloud：Jira 与 Confluence 同域，如 https://acme.atlassian.net',
  'form.jiraUrl': 'Jira 地址',
  'form.jiraUrlHint': 'Server / DC：Jira 根地址（如 https://jira.example.com）',
  'form.confluenceUrl': 'Confluence 地址',
  'form.confluenceUrlHint': 'Server / DC 必填：Confluence 根地址（与 Jira 分开部署）',
  'form.email': '账号邮箱',
  'form.emailHint': 'Cloud：API token 所属账号的邮箱（Basic 认证用户名，两产品共用）',
  'form.projects': '项目 / 空间键',
  'form.projectsHint':
    '本站点的 Jira 项目键或 Confluence 空间键，逗号分隔（如 ACME, DEV）；调用未指明站点时按工单号 / 查询内容自动匹配到唯一站点',
  'form.workspaces': '关联工作区',
  'form.workspacesHint':
    '本站点关联的工作区目录绝对路径，逗号分隔（如 C:\\code\\acme, /home/me/acme）；当前会话的工作目录命中且唯一时自动选此站点',
  'form.commentFilter': '评论过滤',
  'form.commentFilterHint':
    '读取工单时排除的评论作者，displayName 子串匹配不区分大小写，逗号分隔（如 gitlab, ci-bot）；机器账号刷屏时保住真实用户的最近评论',
  'form.token': 'API token',
  'form.tokenHint': 'Cloud：一份 Atlassian API token 两产品共用；写入宿主凭据库，不回显；留空 = 保持已存值',
  'form.tokenStored': '已保存（不回显）；留空保持不变',
  'form.eraseToken': '清除已存',
  'form.tokenJira': 'Jira Token（PAT）',
  'form.tokenJiraHint': 'Server / DC：Jira 的个人访问令牌；保存后写入宿主凭据库，不回显；留空 = 保持已存值',
  'form.tokenJiraStored': '已保存（不回显）；留空保持不变',
  'form.tokenConfluence': 'Confluence Token（PAT）',
  'form.tokenConfluenceHint':
    'Server / DC：Confluence 的独立个人访问令牌（与 Jira 不通用）；留空 = 保持已存值',
  'form.tokenConfluenceStored': '已保存（不回显）；留空保持不变',
  'form.default': '设为默认站点',
  'form.defaultHint': '多站点时，工作区与项目键都未唯一命中的调用落到默认站点',

  'validate.name': '站点名需匹配 ^[a-z0-9][a-z0-9-]{0,31}$，如 acme',
  'validate.duplicate': '站点名「{name}」已存在',
  'validate.atlassianUrlRequired': 'Cloud 站点需要 Atlassian 地址',
  'validate.atlassianUrl': 'Atlassian 地址必须是 http(s) URL',
  'validate.jiraUrlRequired': 'Server / DC 站点需要 Jira 地址',
  'validate.jiraUrl': 'Jira 地址必须是 http(s) URL',
  'validate.confluenceRequired': 'Server / DC 站点需要单独的 Confluence 地址',
  'validate.confluenceUrl': 'Confluence 地址必须是 http(s) URL',
  'validate.email': 'Cloud 站点需要账号邮箱',
  'validate.projects': '项目键需为 2-10 位大写字母数字（保存时自动转大写）',

  'test.jiraOk': 'Jira 正常',
  'test.jiraFail': 'Jira 失败：{reason}',
  'test.confOk': 'Confluence 正常',
  'test.confFail': 'Confluence 失败：{reason}',

  'delete.title': '删除站点 {name}',
  'delete.body':
    '将移除站点配置并清除已存的两份凭据（Jira 与 Confluence token；环境变量不受影响）；进行中的调用会立即失败。',

  'notice.saved': '已保存站点 {name}',
  'notice.deleted': '已删除站点 {name}',
  'notice.tokenCleared': '已清除 {name} 的 token 凭据',
} as const

export type AtlassianKey = keyof typeof zh

export const en: { [Key in AtlassianKey]: string } = {
  'action.new': 'New site',
  'action.refresh': 'Refresh',
  'action.edit': 'Edit',
  'action.test': 'Test connection',
  'action.testing': 'Testing…',
  'action.saving': 'Saving…',

  'list.loading': 'Reading sites…',
  'list.empty': 'No sites yet. Click "New site" to add the Atlassian site hosting your Jira / Confluence.',
  'problems.title': 'These config lines are invalid and ignored (fix them in cordis.patch.yml):',

  'tool.jira.hits': '{count} Jira results',
  'tool.jira.shown': '{count} Jira results returned (total unknown)',
  'tool.conf.hits': '{count} Confluence results',
  'tool.conf.shown': '{count} Confluence results returned (total unknown)',
  'tool.search.truncated': 'truncated',

  'site.kindCloud': 'Cloud',
  'site.kindServer': 'Server / DC',
  'site.defaultBadge': 'Default',
  'site.workspacesBadge': '{count} workspace(s)',
  'site.commentFilterBadge': '{count} filter(s)',
  'site.tokenConfigured': 'token configured',
  'site.tokenMissing': 'token missing',
  'site.jiraTokenOk': 'Jira token configured',
  'site.jiraTokenMissing': 'Jira token missing',
  'site.confTokenOk': 'Confluence token configured',
  'site.confTokenMissing': 'Confluence token missing',
  'site.tokenSource': 'source: {source}',
  'site.tokenBroken': 'token state unknown: {reason}',

  'form.titleNew': 'New site',
  'form.titleEdit': 'Edit site {name}',
  'form.name': 'Site name',
  'form.nameHint': 'Lowercase letters, digits, hyphens; tools address it via the site argument',
  'form.kind': 'Deployment',
  'form.atlassianUrl': 'Atlassian URL',
  'form.atlassianUrlHint': 'Cloud: Jira and Confluence share the domain, e.g. https://acme.atlassian.net',
  'form.jiraUrl': 'Jira URL',
  'form.jiraUrlHint': 'Server / DC: the Jira root address (e.g. https://jira.example.com)',
  'form.confluenceUrl': 'Confluence URL',
  'form.confluenceUrlHint':
    'Required for Server / DC: the Confluence root address (deployed separately from Jira)',
  'form.email': 'Account email',
  'form.emailHint':
    'Cloud: email of the account owning the API token (Basic-auth username, shared by both products)',
  'form.projects': 'Project / space keys',
  'form.projectsHint':
    'Jira project keys or Confluence space keys of this site, comma-separated (e.g. ACME, DEV); calls without a site auto-match when exactly one site declares a mentioned key',
  'form.workspaces': 'Linked workspaces',
  'form.workspacesHint':
    'Absolute workspace directories linked to this site, comma-separated (e.g. C:\\code\\acme, /home/me/acme); the site is auto-selected when the current session directory matches it uniquely',
  'form.commentFilter': 'Comment filter',
  'form.commentFilterHint':
    'Comment authors to exclude when reading issues; displayName substring match, case-insensitive, comma-separated (e.g. gitlab, ci-bot); keeps recent comments from real users visible when bots flood issues',
  'form.token': 'API token',
  'form.tokenHint':
    'Cloud: one Atlassian API token serves both products; stored in the host credential store on save, never echoed; leave empty to keep',
  'form.tokenStored': 'Stored (not echoed); leave empty to keep',
  'form.eraseToken': 'Clear stored',
  'form.tokenJira': 'Jira token (PAT)',
  'form.tokenJiraHint':
    'Server / DC: the Jira personal access token; stored in the host credential store on save, never echoed; leave empty to keep',
  'form.tokenJiraStored': 'Stored (not echoed); leave empty to keep',
  'form.tokenConfluence': 'Confluence token (PAT)',
  'form.tokenConfluenceHint':
    'Server / DC: the separate Confluence personal access token (not valid for Jira); leave empty to keep',
  'form.tokenConfluenceStored': 'Stored (not echoed); leave empty to keep',
  'form.default': 'Set as default site',
  'form.defaultHint': 'Calls matching no workspace and no project key land here in multi-site setups',

  'validate.name': 'Site name must match ^[a-z0-9][a-z0-9-]{0,31}$, e.g. acme',
  'validate.duplicate': 'Site name "{name}" already exists',
  'validate.atlassianUrlRequired': 'Cloud sites need an Atlassian URL',
  'validate.atlassianUrl': 'Atlassian URL must be an http(s) URL',
  'validate.jiraUrlRequired': 'Server / DC sites need a Jira URL',
  'validate.jiraUrl': 'Jira URL must be an http(s) URL',
  'validate.confluenceRequired': 'Server / DC sites need a separate Confluence URL',
  'validate.confluenceUrl': 'Confluence URL must be an http(s) URL',
  'validate.email': 'Cloud sites need an account email',
  'validate.projects': 'Keys must be 2-10 uppercase letters/digits (uppercased on save)',

  'test.jiraOk': 'Jira OK',
  'test.jiraFail': 'Jira failed: {reason}',
  'test.confOk': 'Confluence OK',
  'test.confFail': 'Confluence failed: {reason}',

  'delete.title': 'Delete site {name}',
  'delete.body':
    'Removes the site configuration and clears both stored credentials (Jira and Confluence tokens; environment variables unaffected); in-flight calls fail immediately.',

  'notice.saved': 'Site {name} saved',
  'notice.deleted': 'Site {name} deleted',
  'notice.tokenCleared': 'Token credential cleared for {name}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-atlassian': AtlassianKey
  }
}

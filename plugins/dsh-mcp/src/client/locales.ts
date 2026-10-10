import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 本插件的词典命名空间：经 `ctx.locale.register` 注册、`ctx.locale.bind` 取词，
 * 语言选择与回退由宿主 locale 服务统一裁决，插件不自建语言状态。
 */
export const NS = 'dsh-mcp'

/**
 * 面板消息描述子：可翻译文案用词典 key + `{参数}` 插值参数表达；Host 原因等
 * 无法翻译的事实用 text 原样展示，不猜不吞。
 */
export type PanelMessage = { key: McpKey; params?: Record<string, unknown> } | { text: string }

export type McpT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': 'MCP 管理',
  'panel.subtitle': '管理 MCP 服务器的配置与启停：保存前自动检查连接，运行状态与工具数量实时展示。',

  'action.create': '新建服务器',
  'action.refresh': '刷新',
  'action.enable': '启用',
  'action.disable': '停用',
  'action.checking': '检查中…',
  'action.saving': '保存中…',

  'list.loading': '正在读取 MCP 服务器目录…',
  'list.empty':
    '还没有 MCP 服务器。stdio（本地命令）或 streamable-http（远程端点）都支持，点「新建服务器」开始。',

  'row.unnamed': '（未命名）',
  'row.readOnly': '只读',
  'row.toolsHint': '点击查看工具清单',
  'row.endpointMissing': '（缺少端点信息）',
  'row.disabled': '已停用',
  'row.pendingEffect': '待生效',
  'row.connecting': '连接中…',
  'row.connectFailed': '连接失败',
  'row.unloaded': '已卸载',
  'row.absent': '已声明未挂载',
  'row.activeTools': '运行中 · {count} 工具',

  'delete.title': '删除服务器 {name}',
  'delete.body': '将删除这条声明（id {id}），HMR 会随即卸载其工具；不影响其他服务器。',

  'notice.created': '已创建服务器 {name}（写入 {scope} 层，等待 HMR 应用）',
  'notice.saved': '已保存服务器 {name}（等待 HMR 应用）',
  'notice.enabled': '已启用 {name}（等待 HMR 应用）',
  'notice.disabled': '已停用 {name}（等待 HMR 应用）',
  'notice.deleted': '已删除服务器 {name}（等待 HMR 卸载）',

  'check.failed':
    '服务器「{name}」连接检查未通过：{reason}。修正后重试，或再点一次「保存」跳过检查直接写入。',
  'check.unknownReason': '未知原因',
  'check.requestFailed': '连接检查请求失败：{detail}',

  'input.formTab': '表单',
  'input.jsonTab': 'JSON',
  'input.jsonEditLabel': '配置（外层键即 serverName，名称以当前行为准）',
  'input.jsonPasteLabel':
    '粘贴 JSON（支持 {"mcpServers": {...}} 包装、{"名称": {...}} 直接映射与单个服务器对象）',
  'input.needSingleEntry': '需要恰好一个服务器对象；多台批量导入请用「新建服务器」的 JSON 粘贴',
  'input.duplicateInBatch': 'serverName「{name}」已存在（或与本批重名）',
  'input.scope': '目标层',
  'input.scopeProfile': 'Profile 层（仅当前 profile）',
  'input.scopeHome': '全局层（~/.dsh，所有 profile）',
  'input.transport': '传输形态',
  'input.transportStdio': 'stdio（本地命令子进程）',
  'input.transportHttp': 'streamable-http（HTTP 端点）',
  'input.serverName': 'serverName（工具名前缀）',
  'input.command': 'command（可执行文件）',
  'input.url': 'url（MCP 端点）',
  'input.args': 'args（每行一个，不经 shell 插值）',
  'input.env': 'env（每行 KEY=VALUE）',
  'input.cwd': 'cwd（可选，子进程工作目录）',
  'input.headers': 'headers（每行 KEY=VALUE，如 Authorization=Bearer …）',
  'input.timeout': '调用超时 ms（可选，缺省 60000）',
  'input.failOnStartup': '启动失败即报错',
  'input.failOnStartupHint': '初始连接失败时让插件行失败（阻止激活；缺省关闭并进入自动重连）',

  'view.transport': '传输',
  'view.endpoint': '端点',
  'view.live': '运行态',
  'view.toolCount': '工具数',
  'view.livePending': '待生效（尚未挂载）',
  'view.tools': '已注册工具',
  'view.toolsSearch': '搜索工具',
  'view.toolsTotal': '共 {count} 个工具',
  'view.toolsNoMatch': '没有匹配的工具',
  'view.effectiveConfig': '生效配置（JSON）',
  'view.livePendingDeps': '等待依赖',
  'view.liveConnecting': '连接中',
  'view.liveActive': '运行中',
  'view.liveFailed': '失败',
  'view.liveUnloading': '卸载中',

  'validate.serverName': 'serverName 需匹配 ^[A-Za-z0-9_-]{1,32}$，如 context7',
  'validate.duplicate': 'serverName「{name}」已存在',
  'validate.commandRequired': 'stdio 传输需要 command',
  'validate.urlRequired': 'streamable-http 传输需要 url',
  'validate.urlProtocol': 'url 协议必须是 http 或 https',
  'validate.urlInvalid': 'url 不是合法的 URL',
  'validate.timeoutPositive': '调用超时必须是正数（毫秒）',

  'import.problemLine': '{name}：{message}',
  'import.problemJoin': '；',
  'import.emptyInput': '请粘贴 MCP 服务器的 JSON 配置',
  'import.invalidJson': '不是合法的 JSON：{detail}',
  'import.rootNotObject': '顶层必须是 JSON 对象',
  'import.emptyServers': 'mcpServers 里没有服务器对象',
  'import.noServers': '没有发现服务器配置：需要 mcpServers 包装、{"名称": {...}} 映射或单个服务器对象',
  'import.namePattern': '名称「{name}」需匹配 ^[A-Za-z0-9_-]{1,32}$',
  'import.placeholder': '包含 ${PLUGIN_ROOT} 类占位符，DSH 没有插件根目录，无法解析',
  'import.transportUnknown': '无法判定传输形态：type 缺失且没有 command / url',
  'import.stdioCommandMissing': 'stdio 服务器缺少 command',
  'import.httpUrlMissing': 'HTTP 服务器缺少 url',
  'import.notServerObject': '不是服务器配置对象',
  'import.notServerObjectSparse': '不是服务器配置对象（缺 command / url / type）',
  'import.deriveFailed': '无法从配置推导 serverName：请改用 {"服务器名": {...}} 包装',

  'import.note.sseDeprecated': 'HTTP+SSE 传输已弃用，按 streamable-http 处理',
  'import.note.ignoredKeys': '已忽略 {side} 专属键：{keys}',
  'import.note.disabledConverted': 'disabled 已转换为行级停用（不写入配置）',
  'import.note.autoNamed': '已自动命名 {name}（如需自定义名称，请用 {"服务器名": {...}} 包装）',
  'import.note.preservedKeys': '以下键无标准对应，原样保留：{keys}',
} as const

export type McpKey = keyof typeof zh

export const en: { [Key in McpKey]: string } = {
  'section.label': 'MCP',
  'panel.subtitle':
    'Manage MCP servers: configure, enable or disable them; connections are checked before saving, with live status and tool counts.',

  'action.create': 'New server',
  'action.refresh': 'Refresh',
  'action.enable': 'Enable',
  'action.disable': 'Disable',
  'action.checking': 'Checking…',
  'action.saving': 'Saving…',

  'list.loading': 'Reading the MCP server catalog…',
  'list.empty':
    'No MCP servers yet. stdio (local command) and streamable-http (remote endpoint) are both supported; click "New server" to start.',

  'row.unnamed': '(unnamed)',
  'row.readOnly': 'Read-only',
  'row.toolsHint': 'Click to view the tool list',
  'row.endpointMissing': '(endpoint missing)',
  'row.disabled': 'Disabled',
  'row.pendingEffect': 'Pending',
  'row.connecting': 'Connecting…',
  'row.connectFailed': 'Connection failed',
  'row.unloaded': 'Unloaded',
  'row.absent': 'Declared, not mounted',
  'row.activeTools': 'Running · {count} tools',

  'delete.title': 'Delete server {name}',
  'delete.body':
    'This deletes the declaration (id {id}); HMR unloads its tools right away. Other servers are unaffected.',

  'notice.created': 'Created server {name} (written to the {scope} layer; waiting for HMR to apply)',
  'notice.saved': 'Saved server {name} (waiting for HMR to apply)',
  'notice.enabled': 'Enabled {name} (waiting for HMR to apply)',
  'notice.disabled': 'Disabled {name} (waiting for HMR to apply)',
  'notice.deleted': 'Deleted server {name} (waiting for HMR to unload)',

  'check.failed':
    'Connection check failed for server "{name}": {reason}. Fix it and retry, or click "Save" again to skip the check and write directly.',
  'check.unknownReason': 'unknown reason',
  'check.requestFailed': 'Connection check request failed: {detail}',

  'input.formTab': 'Form',
  'input.jsonTab': 'JSON',
  'input.jsonEditLabel': 'Configuration (the outer key is the serverName; the name follows the current row)',
  'input.jsonPasteLabel':
    'Paste JSON (supports the {"mcpServers": {...}} wrapper, a direct {"name": {...}} map, or a single server object)',
  'input.needSingleEntry':
    'Exactly one server object is required; to import several, use "New server" JSON paste',
  'input.duplicateInBatch': 'serverName "{name}" already exists (or duplicates one in this batch)',
  'input.scope': 'Target layer',
  'input.scopeProfile': 'Profile layer (current profile only)',
  'input.scopeHome': 'Global layer (~/.dsh, all profiles)',
  'input.transport': 'Transport',
  'input.transportStdio': 'stdio (local command subprocess)',
  'input.transportHttp': 'streamable-http (HTTP endpoint)',
  'input.serverName': 'serverName (tool name prefix)',
  'input.command': 'command (executable)',
  'input.url': 'url (MCP endpoint)',
  'input.args': 'args (one per line, no shell interpolation)',
  'input.env': 'env (KEY=VALUE per line)',
  'input.cwd': 'cwd (optional, subprocess working directory)',
  'input.headers': 'headers (KEY=VALUE per line, e.g. Authorization=Bearer …)',
  'input.timeout': 'Tool-call timeout ms (optional, default 60000)',
  'input.failOnStartup': 'Fail on startup error',
  'input.failOnStartupHint':
    'A failed initial connection fails the plugin row (blocking activation; off by default with automatic reconnect)',

  'view.transport': 'Transport',
  'view.endpoint': 'Endpoint',
  'view.live': 'Live state',
  'view.toolCount': 'Tools',
  'view.livePending': 'Pending (not mounted yet)',
  'view.tools': 'Registered tools',
  'view.toolsSearch': 'Search tools',
  'view.toolsTotal': '{count} tools in total',
  'view.toolsNoMatch': 'No matching tools',
  'view.effectiveConfig': 'Effective configuration (JSON)',
  'view.livePendingDeps': 'Waiting for dependencies',
  'view.liveConnecting': 'Connecting',
  'view.liveActive': 'Running',
  'view.liveFailed': 'Failed',
  'view.liveUnloading': 'Unloading',

  'validate.serverName': 'serverName must match ^[A-Za-z0-9_-]{1,32}$, e.g. context7',
  'validate.duplicate': 'serverName "{name}" already exists',
  'validate.commandRequired': 'stdio transport requires command',
  'validate.urlRequired': 'streamable-http transport requires url',
  'validate.urlProtocol': 'url protocol must be http or https',
  'validate.urlInvalid': 'url is not a valid URL',
  'validate.timeoutPositive': 'Tool-call timeout must be a positive number (milliseconds)',

  'import.problemLine': '{name}: {message}',
  'import.problemJoin': '; ',
  'import.emptyInput': 'Paste the JSON configuration of an MCP server',
  'import.invalidJson': 'Not valid JSON: {detail}',
  'import.rootNotObject': 'The top level must be a JSON object',
  'import.emptyServers': 'mcpServers contains no server objects',
  'import.noServers':
    'No server configuration found: use the mcpServers wrapper, a {"name": {...}} map, or a single server object',
  'import.namePattern': 'Name "{name}" must match ^[A-Za-z0-9_-]{1,32}$',
  'import.placeholder':
    'Contains ${PLUGIN_ROOT}-style placeholders; DSH has no plugin root directory and cannot resolve them',
  'import.transportUnknown': 'Cannot determine the transport: type is missing and there is no command / url',
  'import.stdioCommandMissing': 'stdio server is missing command',
  'import.httpUrlMissing': 'HTTP server is missing url',
  'import.notServerObject': 'Not a server configuration object',
  'import.notServerObjectSparse': 'Not a server configuration object (missing command / url / type)',
  'import.deriveFailed':
    'Cannot derive serverName from the configuration; wrap it as {"name": {...}} instead',

  'import.note.sseDeprecated': 'HTTP+SSE transport is deprecated; treating it as streamable-http',
  'import.note.ignoredKeys': 'Ignored {side}-only keys: {keys}',
  'import.note.disabledConverted': '"disabled" converted to row-level disable (not stored in the config)',
  'import.note.autoNamed': 'Auto-named {name} (to customize the name, wrap it as {"name": {...}})',
  'import.note.preservedKeys': 'No standard equivalent; kept as-is: {keys}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-mcp': McpKey
  }
}

/** 消息描述子 → 展示文本：key 走词典插值，text 是不翻译的事实原样。 */
export function messageText(message: PanelMessage, t: McpT): string {
  return 'key' in message ? t(message.key, message.params) : message.text
}

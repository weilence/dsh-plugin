import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 本插件的词典命名空间：经 `ctx.locale.register` 注册、`ctx.locale.bind` 取词，
 * 语言选择与回退由宿主 locale 服务统一裁决，插件不自建语言状态。
 */
export const NS = 'dsh-remote'

/**
 * 面板消息描述子：可翻译文案用词典 key + `{参数}` 插值参数表达；Host errMsg、
 * ssh 输出等外部事实用 text 原样展示，不猜不吞。
 */
export type PanelMessage = { key: RemoteKey; params?: Record<string, unknown> } | { text: string }

export type RemoteT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': '远程开发',

  'panel.title': '远程开发',
  'panel.subtitle': '连接远端机器上的完整 DSH 实例，并把技能、MCP、插件与系统提示词同步过去。',
  'panel.create': '新建',
  'panel.refresh': '刷新',
  'panel.loading': '正在读取连接库…',
  'panel.empty': '还没有远程开发连接。',

  'env.noSsh':
    '本机未找到 ssh 可执行文件：请安装 OpenSSH 客户端（Windows 的「可选功能 → OpenSSH 客户端」）；在此之前所有远端操作不可用。',
  'env.noTar': '本机未找到 tar：Skills 同步不可用（Windows 10+ 自带 bsdtar，请确认其在 PATH 上）。',

  'phase.idle': '空闲',
  'phase.probing': '探测中',
  'phase.deploying': '部署中',
  'phase.starting': '启动中',
  'phase.running': '运行中',
  'phase.error': '错误',

  'op.connect': '连接',
  'op.recover': '自动恢复',
  'op.sync-skills': '同步 Skills',
  'op.sync-mcp': '同步 MCP',
  'op.sync-plugins': '同步插件',
  'op.sync-prompts': '同步提示词',

  // 心跳对远端实例的结论（running 仍在，实例有状况——见 engine 的心跳段）
  'health.restarting': '实例重启中',
  'health.unresponsive': '实例无响应',
  'health.unknown': '实例状态未知',
  'health.lastAt': '最后一次心跳观测：{at}（systemd 状态与日志尾部见下）',

  'noun.skills': 'skills',
  'noun.mcp': 'MCP',
  'noun.plugins': '插件',
  'noun.prompts': '提示词',

  'action.open': '打开',

  'card.profile': '远端 profile {profile}（固定）',
  'card.forward': '端口 {local} → {remote}',
  'card.errorDetail.title': '完整错误详情',
  'card.errorDetail.expand': '查看完整',
  'card.opLog.title': '操作过程',
  'failed.connect': '连接失败',
  'failed.sync': '同步失败',
  'failed.recover': '自动恢复失败',
  'card.syncMenu': '同步 ▾',

  'lastSync.skills': '上次 Skills 同步：推送 {pushed}',
  'lastSync.mcp': '上次 MCP 同步：{count} 行',
  'lastSync.plugins': '上次插件同步：装 {count}',
  'lastSync.prompts': '上次提示词同步：{result}',
  'lastSync.prompts.pushed': '已推送',
  'lastSync.prompts.unchanged': '未勾选（未变更）',
  'lastSync.at': '（{at}）',

  'connect.title': '连接远端',
  'connect.description': '同步插件需要远端已连接。现在连接「{label}」（{target}）？',

  'delete.title': '删除连接',
  'delete.body':
    '确认删除「{label}」（{target}）？只清除本机记录、已保存的口令与端口转发；远端实例会继续在后台运行，已装插件与已下发配置保留。',

  'notice.connected': '已连接「{label}」——点卡片上的「打开」进入远端页面',
  'notice.recovered': '远端实例曾停止，已自动恢复「{label}」——点「打开」重新进入',
  'notice.created': '已创建连接',
  'notice.saved': '已保存连接',
  'notice.deleted': '已删除连接',
  // 同步完成 / 失败摘要是跨语言切换存活的 toast：模板整句入词典（不把可译
  // 片段当参数拼接）。引擎提交即执行、无跳过概念。
  'notice.syncFailed.skills': '同步skills失败：{detail}',
  'notice.syncFailed.mcp': '同步MCP失败：{detail}',
  'notice.syncFailed.plugins': '同步插件失败：{detail}',
  'notice.syncFailed.prompts': '同步提示词失败：{detail}',
  'notice.syncDone.skills': '同步 Skills 完成：推送 {pushed}',
  'notice.syncDone.mcp': '同步 MCP 完成：写入 {count} 行',
  'notice.syncDone.plugins': '同步插件完成：安装 {count}',
  'notice.syncDone.promptsPushed': '同步提示词完成：已推送',
  'notice.syncDoneGeneric.skills': '同步skills完成',
  'notice.syncDoneGeneric.mcp': '同步MCP完成',
  'notice.syncDoneGeneric.plugins': '同步插件完成',
  'notice.syncDoneGeneric.prompts': '同步提示词完成',
  // 表单测试的一次性结果（toast，事件时间取词即可）
  'notice.test.ok': '测试通过：node {node} · npm {npm} · dsh {dsh}',
  'notice.test.okNoDsh': '测试通过：node {node} · npm {npm} · 未安装 dsh',
  'notice.test.failed': '测试失败：{detail}',
  'notice.test.failedNoReason': '测试失败（没有输出）',

  'form.label': '显示名',
  'form.labelPlaceholder': '如：开发机 A',
  'form.login': '登录方式',
  'form.login.alias': 'SSH 别名',
  'form.login.password': '密码',
  'form.login.key': '密钥文件',
  'form.login.hint.alias': '认证完全交给 ~/.ssh/config；该别名需要已能免交互登录（密钥 / agent / 证书）',
  'form.login.hint.password': '用远端账号的登录密码认证；地址、端口、用户按需填写',
  'form.login.hint.key': '指定本地私钥文件；私钥设了口令时在下面填写',
  'form.alias': 'SSH 主机',
  'form.aliasPlaceholder': '~/.ssh/config 里的主机别名',
  'form.aliasRequired': 'SSH 别名不能为空（~/.ssh/config 里的主机别名）',
  'form.pickHost': '选择…',
  'form.host': '地址',
  'form.hostPlaceholder': 'IP 或域名',
  'form.port': '端口',
  'form.portPlaceholder': '22',
  'form.user': '用户',
  'form.userPlaceholder': '默认当前系统用户',
  'form.identityFile': '密钥文件',
  'form.identityFilePlaceholder': '~/.ssh/id_ed25519',
  'form.identityFileHint': '支持 ~/；私钥若设了口令，请填写「私钥口令」',
  'form.secretPassword': '密码',
  'form.secretPassphrase': '私钥口令',
  'form.secretHint': '勾选「记住」才会写入本机；否则只在本次运行内有效',
  'form.secretHintKeep': '留空表示继续使用已有口令',
  'form.secretSaved': '已保存到本机',
  'form.secretSession': '仅本次运行有效',
  'form.secretNone': '未提供',
  'form.rememberSecret': '记住口令（保存到本机）',
  'form.clearSecret': '清除已保存的口令',
  'form.test': '测试',
  'form.testing': '测试中…',
  'form.saving': '保存中…',
  'form.labelRequired': '显示名不能为空',
  'form.hostRequired': '地址不能为空',
  'form.hostInvalid': '地址不合法（只允许字母、数字、. _ - 与 IPv6 的冒号，且不能以 - 开头）',
  'form.portInvalid': '端口必须是 1–65535 的整数',
  'form.userInvalid': '用户名只能包含字母、数字、. _ -，且不能以 - 开头',
  'form.keyFileRequired': '密钥文件不能为空',
  'form.passwordRequired': '密码不能为空（没有可复用的已保存密码）',
  'form.configLoading': '正在读取 ~/.ssh/config…',
  'form.configMissing': '{path} 不存在；可直接输入别名',
  'form.configHint': '已从 {path} 读取 {count} 个主机；也可直接输入别名',
  'form.configError': '读取 {path} 失败：{detail}',

  'hostPicker.title': '选择 SSH 主机',
  'hostPicker.description': '来自 {path}；连接参数仍由 ssh 按配置解析',
  'hostPicker.search': '搜索主机别名',
  'hostPicker.loading': '正在读取 ssh config…',
  'hostPicker.empty': '没有可选的主机别名',
  'hostPicker.error': '读取 ssh config 失败：{detail}',
  'hostPicker.proxy': '跳板',
  'hostPicker.identity': '密钥',

  'secret.title': '需要登录密码',
  'secret.description': '连接「{label}」（{target}）没有可用的密码；输入后仅本次运行有效。',
  'secret.field': '密码',
  'secret.confirm': '使用此密码',
  'secret.busy': '提交中…',

  'kind.skills': 'Skills',
  'kind.mcp': 'MCP',
  'kind.plugins': '插件',
  'kind.prompts': '提示词',

  'sync.title': '同步到「{label}」：{kind}',
  'sync.desc.skills': '勾选项推送到远端；未勾选不动，不删除远端内容。',
  'sync.desc.mcp': '勾选项写入远端 patch；未勾选不动，不删除远端内容。',
  'sync.desc.plugins': '勾选项安装 / 升级到远端；未勾选不动，不删除远端内容。',
  'sync.desc.prompts': '勾选即推送到远端 system-prompt.md；未勾选不动，不删除远端文件。',
  'sync.busy': '同步中…',
  'sync.unavailable': '本机清单不可用（当前宿主未提供 profileContext），无法选择同步内容。',
  'sync.loadingInventory': '正在读取远端清单并与本机比对…',
  'sync.inventoryError':
    '远端清单读取失败（{reason}；宿主为旧版时重启宿主可解）：无法逐条比对，以下按「无法比对」展示；确认后将按勾选推送 / 覆盖（只新增 / 覆盖，不删除远端内容）。',
  'sync.unknownReason': '未知原因',
  'sync.registryInstallLabel': '非本地插件安装方式',
  'sync.registryInstall.remote': '远端 npm 下载',
  'sync.registryInstall.push': '本地打包传输',
  'sync.empty.skills': '本机两个用户级根（~/.dsh/skills、~/.agents/skills）没有可发现的技能。',
  'sync.empty.mcp': '本机没有可同步的 MCP 声明。',
  'sync.empty.plugins': '本机没有可同步的插件（两层 patch 行与 bundles 激活清单均为空）。',
  'sync.empty.prompts':
    '本机没有系统提示词文件（system-prompt.md），无可同步——在「系统提示词」面板创建后再来。',
  'sync.summaryCount': '{count} 项{label}',
  'sync.summarySame': '{count} 项已一致（{state}）',
  'sync.hidden': '已隐藏',
  'sync.forceHint': '勾选即强制重推',
  'sync.hideSame': '隐藏已一致条目（{count}）',
  'sync.selectAll': '全选',
  'sync.allHidden': '全部条目均已一致且被隐藏——关闭「隐藏已一致」可查看，勾选后提交即强制重推。',
  'sync.remoteMcp': '远端：{summary}',

  'status.same': '已一致',
  'status.skills.diff': '内容不同',
  'status.skills.absent': '远端没有',
  'status.skills.unknown': '无法比对',
  'status.mcp.diff': '配置不同',
  'status.mcp.absent': '远端没有',
  'status.mcp.unknown': '无法比对',
  'status.plugins.diff': '与远端版本不同',
  'status.plugins.absent': '远端未激活',
  'status.plugins.unknown': '无法比对',
  'status.prompts.diff': '内容不同',
  'status.prompts.absent': '远端没有',
  'status.prompts.unknown': '无法比对',

  'plugin.source.profile': 'profile 层',
  'plugin.source.home': 'home 层',
  'plugin.install.local': '本地',
  'plugin.install.registry': 'npm',
  'plugin.remoteActiveUnknown': '远端已激活（版本未知）',
  'plugin.remoteVersion': '远端 v{version}',
} as const

export type RemoteKey = keyof typeof zh

export const en: { [Key in RemoteKey]: string } = {
  'section.label': 'Remote',

  'panel.title': 'Remote development',
  'panel.subtitle':
    'Connect to a full DSH instance on a remote machine, and sync skills, MCP servers, plugins and the system prompt to it.',
  'panel.create': 'New',
  'panel.refresh': 'Refresh',
  'panel.loading': 'Reading the connection library…',
  'panel.empty': 'No remote development connections yet.',

  'env.noSsh':
    'No local ssh executable found: install the OpenSSH client (Windows: "Optional features → OpenSSH Client"); until then every remote operation is unavailable.',
  'env.noTar':
    'No local tar found: Skills sync is unavailable (Windows 10+ ships bsdtar; make sure it is on PATH).',

  'phase.idle': 'Idle',
  'phase.probing': 'Probing',
  'phase.deploying': 'Deploying',
  'phase.starting': 'Starting',
  'phase.running': 'Running',
  'phase.error': 'Error',

  'op.connect': 'Connect',
  'op.recover': 'Recovering',
  'op.sync-skills': 'Sync Skills',
  'op.sync-mcp': 'Sync MCP',
  'op.sync-plugins': 'Sync plugins',
  'op.sync-prompts': 'Sync prompts',

  'health.restarting': 'Restarting',
  'health.unresponsive': 'Unresponsive',
  'health.unknown': 'State unknown',
  'health.lastAt': 'Last heartbeat at {at} (systemd state and log tail below)',

  'noun.skills': 'skills',
  'noun.mcp': 'MCP',
  'noun.plugins': 'plugins',
  'noun.prompts': 'prompts',

  'action.open': 'Open',

  'card.profile': 'remote profile {profile} (fixed)',
  'card.forward': 'ports {local} → {remote}',
  'card.errorDetail.title': 'Full error detail',
  'card.errorDetail.expand': 'Show full',
  'card.opLog.title': 'Operation log',
  'failed.connect': 'Connection failed',
  'failed.sync': 'Sync failed',
  'failed.recover': 'Auto-recovery failed',
  'card.syncMenu': 'Sync ▾',

  'lastSync.skills': 'Last Skills sync: pushed {pushed}',
  'lastSync.mcp': 'Last MCP sync: {count} rows',
  'lastSync.plugins': 'Last plugin sync: installed {count}',
  'lastSync.prompts': 'Last prompt sync: {result}',
  'lastSync.prompts.pushed': 'pushed',
  'lastSync.prompts.unchanged': 'not picked (unchanged)',
  'lastSync.at': ' ({at})',

  'connect.title': 'Connect to remote',
  'connect.description': 'Plugin sync needs a connected remote. Connect to "{label}" ({target}) now?',

  'delete.title': 'Delete connection',
  'delete.body':
    'Delete "{label}" ({target})? Only the local record, the saved secret and port forwarding are removed; the remote instance keeps running in the background, with installed plugins and delivered configuration kept.',

  'notice.connected': 'Connected to "{label}" — click "Open" on the card to enter the remote page',
  'notice.recovered':
    'The remote instance had stopped and was recovered automatically — click "Open" to re-enter "{label}"',
  'notice.created': 'Connection created',
  'notice.saved': 'Connection saved',
  'notice.deleted': 'Connection deleted',
  'notice.syncFailed.skills': 'skills sync failed: {detail}',
  'notice.syncFailed.mcp': 'MCP sync failed: {detail}',
  'notice.syncFailed.plugins': 'Plugin sync failed: {detail}',
  'notice.syncFailed.prompts': 'Prompt sync failed: {detail}',
  'notice.syncDone.skills': 'Skills sync finished: pushed {pushed}',
  'notice.syncDone.mcp': 'MCP sync finished: wrote {count} rows',
  'notice.syncDone.plugins': 'Plugin sync finished: installed {count}',
  'notice.syncDone.promptsPushed': 'Prompt sync finished: pushed',
  'notice.syncDoneGeneric.skills': 'skills sync finished',
  'notice.syncDoneGeneric.mcp': 'MCP sync finished',
  'notice.syncDoneGeneric.plugins': 'Plugin sync finished',
  'notice.syncDoneGeneric.prompts': 'Prompt sync finished',
  'notice.test.ok': 'Test passed: node {node} · npm {npm} · dsh {dsh}',
  'notice.test.okNoDsh': 'Test passed: node {node} · npm {npm} · dsh not installed',
  'notice.test.failed': 'Test failed: {detail}',
  'notice.test.failedNoReason': 'Test failed (no output)',

  'form.label': 'Display name',
  'form.labelPlaceholder': 'e.g. Dev box A',
  'form.login': 'Login method',
  'form.login.alias': 'SSH alias',
  'form.login.password': 'Password',
  'form.login.key': 'Key file',
  'form.login.hint.alias':
    'Authentication is entirely delegated to ~/.ssh/config; that alias must already log in without interaction (key / agent / certificate)',
  'form.login.hint.password':
    'Authenticate with the remote account password; fill address, port and user as needed',
  'form.login.hint.key': 'Use a local private key file; fill in the passphrase below if the key has one',
  'form.alias': 'SSH host',
  'form.aliasPlaceholder': 'a host alias from ~/.ssh/config',
  'form.aliasRequired': 'SSH alias cannot be empty (a host alias from ~/.ssh/config)',
  'form.pickHost': 'Choose…',
  'form.host': 'Address',
  'form.hostPlaceholder': 'IP or domain name',
  'form.port': 'Port',
  'form.portPlaceholder': '22',
  'form.user': 'User',
  'form.userPlaceholder': 'defaults to the current OS user',
  'form.identityFile': 'Key file',
  'form.identityFilePlaceholder': '~/.ssh/id_ed25519',
  'form.identityFileHint': 'Accepts ~/; if the key has a passphrase, fill in "Key passphrase"',
  'form.secretPassword': 'Password',
  'form.secretPassphrase': 'Key passphrase',
  'form.secretHint':
    'Only written to this machine when "Remember" is checked; otherwise valid for this run only',
  'form.secretHintKeep': 'Leave blank to keep the existing secret',
  'form.secretSaved': 'saved on this machine',
  'form.secretSession': 'this run only',
  'form.secretNone': 'not provided',
  'form.rememberSecret': 'Remember the secret (save to this machine)',
  'form.clearSecret': 'Clear the saved secret',
  'form.test': 'Test',
  'form.testing': 'Testing…',
  'form.saving': 'Saving…',
  'form.labelRequired': 'Display name cannot be empty',
  'form.hostRequired': 'Address cannot be empty',
  'form.hostInvalid': 'Invalid address (letters, digits, . _ - and IPv6 colons only; must not start with -)',
  'form.portInvalid': 'Port must be an integer between 1 and 65535',
  'form.userInvalid': 'User may contain letters, digits, . _ - only, and must not start with -',
  'form.keyFileRequired': 'Key file cannot be empty',
  'form.passwordRequired': 'Password cannot be empty (no saved password to reuse)',
  'form.configLoading': 'Reading ~/.ssh/config…',
  'form.configMissing': '{path} does not exist; type an alias directly',
  'form.configHint': 'Read {count} hosts from {path}; you can also type an alias directly',
  'form.configError': 'Failed to read {path}: {detail}',

  'hostPicker.title': 'Choose an SSH host',
  'hostPicker.description': 'From {path}; connection parameters are still resolved by ssh',
  'hostPicker.search': 'Search host alias',
  'hostPicker.loading': 'Reading ssh config…',
  'hostPicker.empty': 'No selectable host aliases',
  'hostPicker.error': 'Failed to read ssh config: {detail}',
  'hostPicker.proxy': 'jump',
  'hostPicker.identity': 'key',

  'secret.title': 'Password required',
  'secret.description':
    'Connection "{label}" ({target}) has no usable password; it will be valid for this run only.',
  'secret.field': 'Password',
  'secret.confirm': 'Use this password',
  'secret.busy': 'Submitting…',

  'kind.skills': 'Skills',
  'kind.mcp': 'MCP',
  'kind.plugins': 'plugins',
  'kind.prompts': 'prompts',

  'sync.title': 'Sync to "{label}": {kind}',
  'sync.desc.skills':
    'Picked items are pushed to the remote; unpicked ones are untouched and nothing is deleted.',
  'sync.desc.mcp':
    'Picked items are written to the remote patch; unpicked ones are untouched and nothing is deleted.',
  'sync.desc.plugins':
    'Picked items are installed / upgraded on the remote; unpicked ones are untouched and nothing is deleted.',
  'sync.desc.prompts':
    'Picking pushes the remote system-prompt.md; unpicked means untouched and the file is never deleted.',
  'sync.busy': 'Syncing…',
  'sync.unavailable':
    'The local inventory is unavailable (this host provides no profileContext); sync contents cannot be selected.',
  'sync.loadingInventory': 'Reading the remote inventory and comparing with the local one…',
  'sync.inventoryError':
    'Reading the remote inventory failed ({reason}; restarting an older host may fix it): per-item comparison is unavailable, everything below is shown as "unverifiable"; confirming pushes / overwrites the picked items (add / overwrite only, nothing on the remote is deleted).',
  'sync.unknownReason': 'unknown reason',
  'sync.registryInstallLabel': 'Install method (non-local plugins)',
  'sync.registryInstall.remote': 'Remote npm download',
  'sync.registryInstall.push': 'Local pack & push',
  'sync.empty.skills':
    'No discoverable skills in the two user-level local roots (~/.dsh/skills, ~/.agents/skills).',
  'sync.empty.mcp': 'No local MCP declarations to sync.',
  'sync.empty.plugins':
    'No local plugins to sync (both patch layers and the bundles activation list are empty).',
  'sync.empty.prompts':
    'No local system prompt file (system-prompt.md); nothing to sync — create it in the "System prompt" panel first.',
  'sync.summaryCount': '{count} {label}',
  'sync.summarySame': '{count} already identical ({state})',
  'sync.hidden': 'hidden',
  'sync.forceHint': 'pick to force re-push',
  'sync.hideSame': 'Hide identical items ({count})',
  'sync.selectAll': 'Select all',
  'sync.allHidden':
    'Everything is already identical and hidden — turn off "Hide identical items" to view; picked items force re-push on submit.',
  'sync.remoteMcp': 'remote: {summary}',

  'status.same': 'identical',
  'status.skills.diff': 'content differs',
  'status.skills.absent': 'not on remote',
  'status.skills.unknown': 'unverifiable',
  'status.mcp.diff': 'configuration differs',
  'status.mcp.absent': 'not on remote',
  'status.mcp.unknown': 'unverifiable',
  'status.plugins.diff': 'differs from remote version',
  'status.plugins.absent': 'not activated on remote',
  'status.plugins.unknown': 'unverifiable',
  'status.prompts.diff': 'content differs',
  'status.prompts.absent': 'not on remote',
  'status.prompts.unknown': 'unverifiable',

  'plugin.source.profile': 'profile layer',
  'plugin.source.home': 'home layer',
  'plugin.install.local': 'local',
  'plugin.install.registry': 'npm',
  'plugin.remoteActiveUnknown': 'activated on remote (version unknown)',
  'plugin.remoteVersion': 'remote v{version}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-remote': RemoteKey
  }
}

/** 消息描述子 → 展示文本：key 走词典插值，text 是不翻译的事实原样。 */
export function messageText(message: PanelMessage, t: RemoteT): string {
  return 'key' in message ? t(message.key, message.params) : message.text
}

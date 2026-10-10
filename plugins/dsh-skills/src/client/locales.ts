import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RootId, RootInfo } from '../shared'

/**
 * 本插件的词典命名空间：经 `ctx.locale.register` 注册、`ctx.locale.bind` 取词，
 * 语言选择与回退由宿主 locale 服务统一裁决，插件不自建语言状态。
 */
export const NS = 'dsh-skills'

export type SkillsT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': 'Skills 管理',
  'panel.title': 'Skills 管理',
  'panel.subtitle': '管理标准技能根目录下的 Skills：新建、编辑与删除，支持从 Git 仓库安装和更新。',

  'scope.label': '管理范围',
  'scope.user': '全局',
  'scope.workspace': '工作区级',
  'scope.workspaceNamed': '工作区级（{name}）',
  'scope.noWorkspaceHint': '当前没有打开的工作区会话，先显示全局技能',

  'action.create': '新建',
  'action.installGit': '从 Git 安装',
  'action.checkUpdates': '检查更新',
  'action.checking': '检查中…',
  'action.checkUpdatesDisabled': '当前作用域没有从 Git 安装的技能',
  'action.refresh': '刷新',
  'action.update': '更新',

  'panel.loading': '正在读取技能目录…',
  'search.placeholder': '搜索过滤：名称 / 描述 / 适用场景',

  'pill.noDescription': '（无描述）',
  'pill.whenToUse': '适用：{text}',
  'pill.invalid': '无效：{reason}',
  'pill.shadowed': '被同名来源遮蔽',
  'pill.userInvocableFalse': '用户不可调用',

  'git.pillTitle': 'Git 安装：{url}（{dir}，安装于 {date}）',
  'update.available': '有更新',
  'update.upstreamNew': '上游有新版本',
  'update.upstreamDescription': '上游描述：{description}',
  'update.availableLocal': '有更新 · 本地已修改',
  'update.availableLocalTitle': '上游有新版本；本地内容也被修改过，更新将覆盖本地改动',
  'update.removed': '上游已移除',
  'update.removedTitle': '上游仓库里已发现不到该技能目录',

  'empty.filtered': '没有匹配「{keyword}」的技能',
  'empty.none':
    '当前作用域下没有发现技能。工作区级技能放在 {dsh} 或 {agents}，全局技能放在 {userDsh} 或 {userAgents}；点「新建技能」开始。',

  'confirm.deleteTitle': '删除技能 {name}',
  'confirm.deleteDirBody': '将删除整个技能目录（含其中的资源文件）：{path}',
  'confirm.deleteFileBody': '将删除技能文件：{path}',
  'confirm.updateTitle': '更新技能 {name}',
  'confirm.updateBody': '本地内容在安装后被修改过，更新将用上游版本覆盖本地改动（来源：{url}）。是否继续？',
  'confirm.updateConfirm': '覆盖更新',

  'form.targetRoot': '目标根',
  'form.rootOption': '{label}（{path}）',
  'form.format': '形态',
  'form.formatFlat': '单文件（<name>.md）',
  'form.formatBundle': '目录包（<name>/SKILL.md，可带资源）',
  'form.nameLabel': '名称（kebab-case）',
  'form.nameLocked': '名称（编辑时不可改）',
  'form.target': '目标',
  'form.descriptionLabel': '描述（必填，模型路由依据）',
  'form.descriptionPlaceholder': '一句话说明这个技能做什么、什么时候用',
  'form.whenToUseLabel': '适用时机（可选 whenToUse）',
  'form.whenToUsePlaceholder': '补充路由提示：什么情况下应该选用这个技能',
  'form.modelInvocable': '允许模型调用',
  'form.modelInvocableHint': '允许模型调用（进入 skill 工具目录）',
  'form.userInvocable': '允许用户调用',
  'form.userInvocableHint': '允许用户 /命令调用',
  'form.bodyLabel': '正文（Markdown 指令）',
  'form.bodyPlaceholderTitle': '# 指南标题（可选）',
  'form.bodyPlaceholderBody': '一步一步的操作说明……',
  'form.saving': '保存中…',

  'validate.nameKebabCase': '名称需为 kebab-case：小写字母 / 数字 / 连字符，如 commit-message-style',
  'validate.duplicateName': '目标根里已存在同名技能「{name}」',
  'validate.descriptionRequired': '描述不能为空',

  'view.name': '名称',
  'view.source': '来源',
  'view.gitRepo': 'Git 仓库',
  'view.gitRepoValue': '{url}（{dir}，安装于 {date}）',
  'view.description': '描述',
  'view.whenToUse': '适用时机',
  'view.invocation': '调用策略',
  'view.modelInvocable': '模型可调用',
  'view.modelNotInvocable': '模型不可调用',
  'view.userInvocable': '用户可调用',
  'view.userNotInvocable': '用户不可调用',
  'view.raw': '原文',

  'source.project-dsh': '工作区级 · .dsh/skills',
  'source.project-agents': '工作区级 · .agents/skills',
  'source.custom': '自定义目录',
  'source.user-dsh': '全局 · ~/.dsh/skills',
  'source.user-agents': '全局 · ~/.agents/skills',
  'source.bundled': '内置',
  'source.runtime': '运行时',

  'git.title': '从 Git 仓库安装技能',
  'git.description': '整目录复制 · 同名冲突不覆盖',
  'git.urlLabel': '仓库地址（https:// · ssh:// · git@host:owner/repo）',
  'git.scan': '扫描',
  'git.scanning': '克隆扫描中…',
  'git.installTo': '安装到（同名冲突不覆盖）',
  'git.scanEmpty':
    '仓库里没有发现技能。支持根 SKILL.md、skills/（含分类子目录）、.agents/skills/、.claude/skills/ 与 .claude-plugin/marketplace.json 声明的位置。',
  'git.installSelected': '安装选中（{count}）',
  'git.installing': '安装中…',
  'git.installedCount': '已安装 {count} 个',
  'git.conflict': '同名冲突（未覆盖）：{path}',
  'git.installFailed': '{name} 安装失败：{error}',
  'git.notInstallable': '不可安装：{reason}',
  'git.hint':
    'host 用部分克隆 + 稀疏检出只拉取技能相关目录（skills/、.agents/skills/、.claude-plugin/ 及清单声明的插件目录，docs 等其余内容不落盘；复用本机 git 凭据，私有仓库可用），扫描后整目录复制到目标根；临时目录随即删除。同名技能已存在时不覆盖，请先删除或换目标根。',

  'origin.marketplace': 'marketplace 声明',
  'origin.plugin': 'plugin.json 声明',
  'origin.root': '仓库根',

  'notice.created': '已创建技能 {name}（{path}）',
  'notice.saved': '已保存技能 {name}',
  'notice.deleted': '已删除技能 {name}',
  'notice.gitInstalled': '已从 Git 安装 {count} 个技能：{names}',
  'notice.updated': '已更新 {count} 个技能：{names}',
  'notice.check.done': '检查完成：{detail}',
  'notice.check.updatable': '{count} 个技能有更新',
  'notice.check.removed': '{count} 个上游已移除',
  'notice.check.repoErrors': '{count} 个仓库检查失败',
  'notice.check.allCurrent': '所有 Git 安装技能均为最新',
  'notice.updateFailed': '部分技能更新失败——{detail}',
  'notice.updateFailedItem': '{name}：{error}',
  'notice.updateFailedRepo': '{url}：{error}',

  'text.listSeparator': '，',
  'text.problemSeparator': '；',
  'text.nameSeparator': '、',
} as const

export type SkillsKey = keyof typeof zh

export const en: { [Key in SkillsKey]: string } = {
  'section.label': 'Skills',
  'panel.title': 'Skills',
  'panel.subtitle':
    'Manage skills in the standard skill roots: create, edit and delete, with installation and updates from Git repositories.',

  'scope.label': 'Scope',
  'scope.user': 'Global',
  'scope.workspace': 'Workspace',
  'scope.workspaceNamed': 'Workspace ({name})',
  'scope.noWorkspaceHint': 'No open workspace session; showing global skills for now',

  'action.create': 'New',
  'action.installGit': 'Install from Git',
  'action.checkUpdates': 'Check updates',
  'action.checking': 'Checking…',
  'action.checkUpdatesDisabled': 'No Git-installed skills in the current scope',
  'action.refresh': 'Refresh',
  'action.update': 'Update',

  'panel.loading': 'Reading the skills catalog…',
  'search.placeholder': 'Search: name / description / when to use',

  'pill.noDescription': '(no description)',
  'pill.whenToUse': 'When to use: {text}',
  'pill.invalid': 'Invalid: {reason}',
  'pill.shadowed': 'Shadowed by a same-name source',
  'pill.userInvocableFalse': 'Not user-invocable',

  'git.pillTitle': 'Git install: {url} ({dir}, installed {date})',
  'update.available': 'Update available',
  'update.upstreamNew': 'A newer version is available upstream',
  'update.upstreamDescription': 'Upstream description: {description}',
  'update.availableLocal': 'Update available · locally modified',
  'update.availableLocalTitle':
    'A newer version is available upstream and the local copy was also modified; updating overwrites the local changes',
  'update.removed': 'Removed upstream',
  'update.removedTitle': 'This skill directory is no longer found in the upstream repository',

  'empty.filtered': 'No skills match "{keyword}"',
  'empty.none':
    'No skills found in the current scope. Workspace skills live in {dsh} or {agents}; global skills live in {userDsh} or {userAgents}. Click "New skill" to start.',

  'confirm.deleteTitle': 'Delete skill {name}',
  'confirm.deleteDirBody': 'This deletes the whole skill directory (including its resource files): {path}',
  'confirm.deleteFileBody': 'This deletes the skill file: {path}',
  'confirm.updateTitle': 'Update skill {name}',
  'confirm.updateBody':
    'The local copy was modified after installation; updating overwrites it with the upstream version (source: {url}). Continue?',
  'confirm.updateConfirm': 'Overwrite and update',

  'form.targetRoot': 'Target root',
  'form.rootOption': '{label} ({path})',
  'form.format': 'Format',
  'form.formatFlat': 'Single file (<name>.md)',
  'form.formatBundle': 'Directory bundle (<name>/SKILL.md, resources allowed)',
  'form.nameLabel': 'Name (kebab-case)',
  'form.nameLocked': 'Name (locked while editing)',
  'form.target': 'Target',
  'form.descriptionLabel': 'Description (required; routes model selection)',
  'form.descriptionPlaceholder': 'One sentence on what this skill does and when to use it',
  'form.whenToUseLabel': 'When to use (optional whenToUse)',
  'form.whenToUsePlaceholder': 'Extra routing hint: when this skill should be picked',
  'form.modelInvocable': 'Allow model invocation',
  'form.modelInvocableHint': 'Allow model invocation (listed in the skill tool catalog)',
  'form.userInvocable': 'Allow user invocation',
  'form.userInvocableHint': 'Allow invocation via / commands',
  'form.bodyLabel': 'Body (Markdown instructions)',
  'form.bodyPlaceholderTitle': '# Guide title (optional)',
  'form.bodyPlaceholderBody': 'Step-by-step instructions…',
  'form.saving': 'Saving…',

  'validate.nameKebabCase':
    'The name must be kebab-case: lowercase letters, digits, and hyphens, e.g. commit-message-style',
  'validate.duplicateName': 'A skill named "{name}" already exists in the target root',
  'validate.descriptionRequired': 'The description cannot be empty',

  'view.name': 'Name',
  'view.source': 'Source',
  'view.gitRepo': 'Git repository',
  'view.gitRepoValue': '{url} ({dir}, installed {date})',
  'view.description': 'Description',
  'view.whenToUse': 'When to use',
  'view.invocation': 'Invocation policy',
  'view.modelInvocable': 'Model-invocable',
  'view.modelNotInvocable': 'Not model-invocable',
  'view.userInvocable': 'User-invocable',
  'view.userNotInvocable': 'Not user-invocable',
  'view.raw': 'Raw content',

  'source.project-dsh': 'Workspace · .dsh/skills',
  'source.project-agents': 'Workspace · .agents/skills',
  'source.custom': 'Custom directory',
  'source.user-dsh': 'Global · ~/.dsh/skills',
  'source.user-agents': 'Global · ~/.agents/skills',
  'source.bundled': 'Built-in',
  'source.runtime': 'Runtime',

  'git.title': 'Install skills from a Git repository',
  'git.description': 'Whole-directory copy · same-name conflicts are not overwritten',
  'git.urlLabel': 'Repository URL (https:// · ssh:// · git@host:owner/repo)',
  'git.scan': 'Scan',
  'git.scanning': 'Cloning and scanning…',
  'git.installTo': 'Install into (same-name conflicts are not overwritten)',
  'git.scanEmpty':
    'No skills found in the repository. Supported locations: root SKILL.md, skills/ (with category subdirectories), .agents/skills/, .claude/skills/, and locations declared by .claude-plugin/marketplace.json.',
  'git.installSelected': 'Install selected ({count})',
  'git.installing': 'Installing…',
  'git.installedCount': '{count} installed',
  'git.conflict': 'Same-name conflict (not overwritten): {path}',
  'git.installFailed': 'Installing {name} failed: {error}',
  'git.notInstallable': 'Not installable: {reason}',
  'git.hint':
    'The host clones with a partial clone + sparse checkout, fetching only skill-related directories (skills/, .agents/skills/, .claude-plugin/ and plugin directories declared in manifests; anything else such as docs is not written to disk; local git credentials are reused, so private repositories work). After scanning, whole directories are copied into the target root and the temporary directory is deleted immediately. Same-name skills are not overwritten; delete them first or pick another target root.',

  'origin.marketplace': 'marketplace declaration',
  'origin.plugin': 'plugin.json declaration',
  'origin.root': 'repository root',

  'notice.created': 'Created skill {name} ({path})',
  'notice.saved': 'Saved skill {name}',
  'notice.deleted': 'Deleted skill {name}',
  'notice.gitInstalled': 'Installed {count} skills from Git: {names}',
  'notice.updated': 'Updated {count} skills: {names}',
  'notice.check.done': 'Check complete: {detail}',
  'notice.check.updatable': '{count} skills have updates',
  'notice.check.removed': '{count} removed upstream',
  'notice.check.repoErrors': '{count} repositories failed to check',
  'notice.check.allCurrent': 'All Git-installed skills are up to date',
  'notice.updateFailed': 'Some skills failed to update — {detail}',
  'notice.updateFailedItem': '{name}: {error}',
  'notice.updateFailedRepo': '{url}: {error}',

  'text.listSeparator': ', ',
  'text.problemSeparator': '; ',
  'text.nameSeparator': ', ',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-skills': SkillsKey
  }
}

const ROOT_KEYS: Record<RootId, SkillsKey> = {
  'project-dsh': 'source.project-dsh',
  'project-agents': 'source.project-agents',
  'user-dsh': 'source.user-dsh',
  'user-agents': 'source.user-agents',
}

const SOURCE_KEYS: Record<string, SkillsKey> = {
  ...ROOT_KEYS,
  custom: 'source.custom',
  bundled: 'source.bundled',
  runtime: 'source.runtime',
}

/** 来源标签按 id 取词典词；未知来源回退原文（Host 的 source 事实原样展示）。 */
export function sourceLabelT(source: string, t: SkillsT): string {
  const key = SOURCE_KEYS[source]
  return key !== undefined ? t(key) : source
}

/** 可写根在下拉里的展示行：根标签 + 路径（括号形态随语言）。 */
export function rootOptionLabel(root: RootInfo, t: SkillsT): string {
  return t('form.rootOption', { label: t(ROOT_KEYS[root.id]), path: root.path })
}

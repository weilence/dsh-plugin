import type { SkillFormat } from './shared'

/** 已知 frontmatter 键的规范名（键名即官方 parser 逐字匹配的键）。 */
const KEY_NAME = 'name'
const KEY_DESCRIPTION = 'description'
const KEY_WHEN_TO_USE = 'whenToUse'
const KEY_DISABLE_MODEL = 'disable-model-invocation'
const KEY_USER_INVOCABLE = 'user-invocable'

const KNOWN_KEYS = new Set([
  KEY_NAME,
  KEY_DESCRIPTION,
  KEY_WHEN_TO_USE,
  KEY_DISABLE_MODEL,
  KEY_USER_INVOCABLE,
])

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/** 读取端解析出的已知字段（全部可选：文件可能缺任何键）。 */
export interface KnownFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

/** 写入端的结构化草稿（name/description 必填，两开关必填）。 */
export interface FrontmatterDraft {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
}

/**
 * 拆出 YAML frontmatter。与官方 parseFrontmatter 同规则：首行必须恰为
 * `---`，闭合 `---` 独占一行；返回 frontmatter 原文（不含围栏）与正文。
 * 不含合法 frontmatter 时返回 undefined。
 */
export function splitFrontmatter(raw: string): { fm: string; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        fm: raw.slice(start, lineStart),
        body: nextNewline < 0 ? '' : raw.slice(nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** 编辑器正文初值：去掉围栏后的首个空行，存回时由 renderFile 补回。 */
export function bodyForEditor(body: string): string {
  return body.replace(/^(\r?\n)/, '')
}

interface ScalarValue {
  /** 解析出的标量文本（布尔以原文形式保留在 raw，由调用方按键解释）。 */
  text: string
  /** 消耗的行数（含键行自身），供行级替换跳过续行。 */
  lines: number
}

/** 去掉未加引号值的行尾注释（` #...`）。 */
function stripComment(value: string): string {
  if (value.startsWith("'") || value.startsWith('"')) return value
  const index = value.indexOf(' #')
  return index < 0 ? value : value.slice(0, index)
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1)
    return inner
      .replaceAll(/\\"/g, '"')
      .replaceAll('\\\\', '\\')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
  }
  return value
}

const BLOCK_SCALAR = /^([>|])([+-]?)$/

/**
 * 解析 frontmatter 文本中的已知键。只匹配列 0 的键（嵌套在未知键下的
 * 同名子键——如 `metadata:` 块里的 `name:`——不会被误读），值支持引号
 * 标量与块标量（> 折叠 / | 字面）。
 */
export function parseKnown(fm: string): KnownFrontmatter {
  const result: KnownFrontmatter = {}
  const lines = fm.split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line)
    if (match === null || !KNOWN_KEYS.has(match[1])) {
      index += 1
      continue
    }
    const key = match[1]
    const rest = (match[2] ?? '').trim()
    const block = BLOCK_SCALAR.exec(rest)
    let scalar: ScalarValue
    if (block !== null) {
      scalar = readBlockScalar(lines, index + 1, block[1] as '>' | '|', block[2])
    } else {
      scalar = { text: unquote(stripComment(rest).trim()), lines: 1 }
    }
    assignKnown(result, key, scalar.text)
    index += scalar.lines
  }
  return result
}

/** 块标量：收集后续缩进行，按字面/折叠语义拼接。 */
function readBlockScalar(lines: string[], start: number, style: '>' | '|', chomp: string): ScalarValue {
  const collected: string[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      // 空行只有当后续仍是缩进行时才属于本块；否则结束。
      const next = lines[index + 1]
      if (next === undefined || !/^[ \t]+\S/.test(next)) break
      collected.push('')
      index += 1
      continue
    }
    if (!/^[ \t]+\S/.test(line)) break
    collected.push(line.replace(/^[ \t]+/, ''))
    index += 1
  }
  let text: string
  if (style === '|') {
    text = collected.join('\n')
  } else {
    // 折叠：单换行变空格，连续换行保留。
    text = collected.reduce((acc, line) => (acc === '' || line === '' ? acc + line : acc + ' ' + line), '')
  }
  if (chomp !== '-') text = text.replace(/\n+$/, '') + (collected.length > 0 ? '\n' : '')
  else text = text.replace(/\n+$/, '')
  text = text.replace(/^\n+/, '')
  return { text, lines: 1 + (index - start) }
}

function assignKnown(target: KnownFrontmatter, key: string, text: string): void {
  switch (key) {
    case KEY_NAME:
      if (text.length > 0) target.name = text
      break
    case KEY_DESCRIPTION:
      if (text.length > 0) target.description = text
      break
    case KEY_WHEN_TO_USE:
      if (text.length > 0) target.whenToUse = text
      break
    case KEY_DISABLE_MODEL:
      target.disableModelInvocation = booleanOf(text)
      break
    case KEY_USER_INVOCABLE:
      target.userInvocable = booleanOf(text)
      break
  }
}

/** 官方 frontmatterBoolean 的宽松子集；无法识别返回 undefined。 */
function booleanOf(text: string): boolean | undefined {
  const lowered = text.toLowerCase()
  if (TRUE_WORDS.has(lowered)) return true
  if (FALSE_WORDS.has(lowered)) return false
  return undefined
}

/**
 * 把结构化草稿写回 frontmatter 文本：已知键原位替换 / 按需增删，未知行
 * （其他键、注释、空行）逐行保留。name 与 description 恒存在；whenToUse
 * 缺失即删除该键；两开关只在「关闭」时落盘对应键（与官方省略 = true 的
 * 缺省一致，保持文件最小）。
 */
export function applyKnown(fm: string, draft: FrontmatterDraft): string {
  const lines = fm.split(/\r?\n/)
  const kept: string[] = []
  const seen = new Set<string>()
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line)
    const isKnownKey = match !== null && KNOWN_KEYS.has(match[1])
    if (isKnownKey) {
      const key = match[1]
      const block = BLOCK_SCALAR.exec((match[2] ?? '').trim())
      // 跳过该键的续行（块标量 / 缩进子结构），替换为单行新值。
      let cursor = index + 1
      if ((match[2] ?? '').trim() === '' || block !== null) {
        while (cursor < lines.length) {
          const next = lines[cursor] ?? ''
          if (next.trim() === '') {
            const after = lines[cursor + 1]
            if (after !== undefined && /^[ \t]+\S/.test(after)) {
              cursor += 1
              continue
            }
            break
          }
          if (!/^[ \t]+\S/.test(next)) break
          cursor += 1
        }
      }
      const rendered = renderKnownLine(key, draft)
      seen.add(key)
      if (rendered !== undefined) kept.push(rendered)
      index = cursor
      continue
    }
    kept.push(line)
    index += 1
  }
  // 空行收敛：行级删除后不留下连续空行堆叠，也不留首尾空行（否则追加的
  // 缺失键会隔着一个残留空行）。
  const compacted: string[] = []
  for (const line of kept) {
    if (line === '' && (compacted.length === 0 || compacted[compacted.length - 1] === '')) continue
    compacted.push(line)
  }
  while (compacted[compacted.length - 1] === '') compacted.pop()
  let out = compacted
  // 缺失的必写键补在末尾（编辑缺键的旧文件 / 全新创建两种来源）。
  for (const key of [KEY_NAME, KEY_DESCRIPTION, KEY_WHEN_TO_USE, KEY_DISABLE_MODEL, KEY_USER_INVOCABLE]) {
    if (seen.has(key)) continue
    const rendered = renderKnownLine(key, draft)
    if (rendered !== undefined) out = [...out, rendered]
  }
  return out.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

/** 单个已知键的落盘行；返回 undefined 表示该键不应出现。 */
function renderKnownLine(key: string, draft: FrontmatterDraft): string | undefined {
  switch (key) {
    case KEY_NAME:
      return `${KEY_NAME}: ${yamlScalar(draft.name)}`
    case KEY_DESCRIPTION:
      return `${KEY_DESCRIPTION}: ${yamlScalar(draft.description)}`
    case KEY_WHEN_TO_USE: {
      const text = draft.whenToUse?.trim()
      return text === undefined || text.length === 0 ? undefined : `${KEY_WHEN_TO_USE}: ${yamlScalar(text)}`
    }
    case KEY_DISABLE_MODEL:
      return draft.modelInvocable ? undefined : `${KEY_DISABLE_MODEL}: false`
    case KEY_USER_INVOCABLE:
      return draft.userInvocable ? undefined : `${KEY_USER_INVOCABLE}: false`
  }
  return undefined
}

/** 是否可以不加引号直接落盘（保守判定，存疑即加引号）。 */
function isPlainSafe(value: string): boolean {
  if (value.length === 0) return false
  if (value !== value.trim()) return false
  if (/[\n\r\t]/.test(value)) return false
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false
  if (/: |\t| #/.test(value)) return false
  if (value.endsWith(':')) return false
  const lowered = value.toLowerCase()
  if (['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~'].includes(lowered)) return false
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return false
  // 首尾的内联引号仅在成对包裹时安全，这里已被外层分支处理；散落引号引掉。
  if (/["']/.test(value)) return false
  return true
}

/** 标量序列化：安全值不加引号直写，否则 JSON 双引号（YAML 兼容）。 */
export function yamlScalar(value: string): string {
  if (isPlainSafe(value)) return value
  return JSON.stringify(value)
}

/** 组装完整技能文件：围栏 + frontmatter + 空行 + 正文，保证末尾换行。 */
export function renderFile(fm: string, body: string): string {
  const fenced = fm.replace(/\s+$/, '')
  const text =
    fenced.length > 0
      ? `---\n${fenced}\n---\n${body.startsWith('\n') || body.length === 0 ? body : '\n' + body}`
      : body
  return text.endsWith('\n') || text.length === 0 ? text : text + '\n'
}

/** 从文件路径推断技能形态：SKILL.md 结尾 = 目录包，否则按单文件。 */
export function formatOfPath(path: string): SkillFormat {
  const base = path.replaceAll('\\', '/').split('/').pop() ?? ''
  return base === 'SKILL.md' ? 'bundle' : 'flat'
}

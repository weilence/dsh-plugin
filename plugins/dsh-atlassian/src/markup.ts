/**
 * Atlassian 三种正文的 markdown 化与有界截取。复杂宏（表格嵌套、面板宏等）
 * 降级为纯文本提取：读取场景要的是可读正文，不是无损往返。
 */

export interface TruncatedText {
  text: string
  /** 本次截取的起始字符偏移（续取请求原样传回）。 */
  offset: number
  /** true = 后面还有内容，可增大 offset 续取。 */
  truncated: boolean
  totalChars: number
}

/** 字符级截取；offset 越界时返回空文本并保持 truncated=false。 */
export function truncateText(text: string, maxChars: number, offset = 0): TruncatedText {
  const totalChars = text.length
  const start = Math.max(0, Math.min(offset, totalChars))
  const slice = text.slice(start, start + maxChars)
  return {
    text: slice,
    offset: start,
    truncated: start + maxChars < totalChars,
    totalChars,
  }
}

// —— Jira Cloud：ADF（Atlas Document Format）→ markdown ——

interface AdfNode {
  type?: string
  text?: string
  marks?: { type?: string; attrs?: { href?: string } }[]
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

const MAX_ADF_DEPTH = 64

function adfAttrText(node: AdfNode, key: string): string {
  const value = node.attrs?.[key]
  return typeof value === 'string' ? value : ''
}

function wrapMarks(text: string, node: AdfNode): string {
  let result = text
  for (const mark of node.marks ?? []) {
    if (result === '') break
    if (mark.type === 'strong' || mark.type === 'underline') result = `**${result}**`
    else if (mark.type === 'em') result = `*${result}*`
    else if (mark.type === 'code') result = `\`${result}\``
    else if (mark.type === 'strike') result = `~~${result}~~`
    else if (mark.type === 'link') result = `[${result}](${mark.attrs?.href ?? ''})`
  }
  return result
}

function adfInline(node: AdfNode, depth: number): string {
  if (depth > MAX_ADF_DEPTH) return ''
  switch (node.type) {
    case 'text':
      return wrapMarks(node.text ?? '', node)
    case 'hardBreak':
      return '\n'
    case 'mention':
      return adfAttrText(node, 'text') || '@'
    case 'emoji':
      return adfAttrText(node, 'text') || `:${adfAttrText(node, 'shortName') || 'emoji'}:`
    case 'date': {
      const long = node.attrs?.['long']
      return typeof long === 'number' ? new Date(long).toISOString().slice(0, 10) : ''
    }
    case 'status':
      return `[${adfAttrText(node, 'text')}]`
    case 'inlineCard':
    case 'blockCard':
      return adfAttrText(node, 'url')
    default: {
      const inner = adfInlineChildren(node, depth)
      return inner
    }
  }
}

function adfInlineChildren(node: AdfNode, depth: number): string {
  return (node.content ?? []).map((child) => adfInline(child, depth + 1)).join('')
}

/** 列表与单元格里的块级内容压成一行（markdown 列表/表格不接受裸块）。 */
function adfFlat(node: AdfNode, depth: number): string {
  if (depth > MAX_ADF_DEPTH) return ''
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
    return adfBlock(node, depth).replace(/\n+/g, ' ').trim()
  }
  if (node.content !== undefined) {
    return (node.content ?? [])
      .map((child) => adfFlat(child, depth + 1))
      .filter(Boolean)
      .join(' ')
  }
  return adfInline(node, depth).trim()
}

function adfBlock(node: AdfNode, depth: number): string {
  if (depth > MAX_ADF_DEPTH) return ''
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.['level'] ?? 1) || 1))
      return `${'#'.repeat(level)} ${adfInlineChildren(node, depth).trim()}`
    }
    case 'codeBlock': {
      const language = adfAttrText(node, 'language')
      return `\`\`\`${language}\n${adfInlineChildren(node, depth)}\n\`\`\``
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => `- ${adfFlat(item, depth + 1)}`)
        .filter((line) => line !== '- ')
        .join('\n')
    case 'orderedList':
      return (node.content ?? []).map((item, index) => `${index + 1}. ${adfFlat(item, depth + 1)}`).join('\n')
    case 'blockQuote':
      return (node.content ?? [])
        .map((child) => adfBlock(child, depth + 1))
        .filter(Boolean)
        .map((block) =>
          block
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        )
        .join('\n>\n')
    case 'rule':
      return '---'
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? [])
        .map((media) => `[附件: ${adfAttrText(media, 'filename') || adfAttrText(media, 'id')}]`)
        .join(' ')
    case 'table':
      return adfTable(node, depth)
    default:
      return adfInlineChildren(node, depth).trim()
  }
}

function adfTable(node: AdfNode, depth: number): string {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow')
  const lines = rows.map((row) => {
    const cells = (row.content ?? [])
      .filter((cell) => cell.type === 'tableCell' || cell.type === 'tableHeader')
      .map((cell) => adfFlat(cell, depth + 1).replace(/\|/g, '\\|'))
    return `| ${cells.join(' | ')} |`
  })
  if (rows.length > 0 && rows[0].content?.some((cell) => cell.type === 'tableHeader') === true) {
    const columns = (rows[0].content ?? []).length
    lines.splice(1, 0, `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`)
  }
  return lines.join('\n')
}

/** ADF 文档 → markdown；非 doc 根或结构未知时尽力提取文本。 */
export function adfToMarkdown(value: unknown): string {
  const root = value as AdfNode | null
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return ''
  const blocks = (root.content ?? []).map((node) => adfBlock(node, 0)).filter(Boolean)
  return blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// —— Confluence：storage XHTML → markdown ——

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTags(html: string): string {
  // CDATA 先解包：其内容是正文文本，按标签剥离会连同正文一起丢失。
  return decodeEntities(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''))
}

/** 块级标签换行后做一次「每段前后空行」整理，供转换器末尾统一收敛。 */
function convertLists(html: string): string {
  const ordered = (match: string): string => {
    let index = 0
    const items = match
      .replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (_item, body: string) => `\n${++index}. ${stripTags(body).trim()}`,
      )
      .replace(/<[/]?ol[^>]*>/gi, '')
    return `\n${items}\n`
  }
  const unordered = (match: string): string => {
    const items = match
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_item, body: string) => `\n- ${stripTags(body).trim()}`)
      .replace(/<[/]?ul[^>]*>/gi, '')
    return `\n${items}\n`
  }
  // 内层优先（负向断言拒绝更深嵌套），反复套跑把嵌套列表摊平成同级列表项。
  let result = html
  for (let pass = 0; pass < 4; pass++) {
    result = result.replace(/<ol[^>]*>(?:(?!<ol[\s>])(?!<\/ol>)[\s\S])*<\/ol>/gi, ordered)
    result = result.replace(/<ul[^>]*>(?:(?!<ul[\s>])(?!<\/ul>)[\s\S])*<\/ul>/gi, unordered)
  }
  return result
}

function convertTables(html: string): string {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_table, inner: string) => {
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    const lines = rows.map((row) => {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        stripTags(cell[1]).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim(),
      )
      return `| ${cells.join(' | ')} |`
    })
    if (lines.length > 1)
      lines.splice(
        1,
        0,
        `| ${'--- | '.repeat(rows[0] ? [...rows[0][1].matchAll(/<t[dh]/gi)].length : 0).trimEnd()}`,
      )
    return `\n${lines.join('\n')}\n`
  })
}

/** storage 正文 → markdown；未识别的宏与内嵌对象降级为纯文本提取。 */
export function storageToMarkdown(html: string): string {
  let s = html
  // code 宏：正文在 plain-text-body 的 CDATA 里，先摘出防止二次转换。
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_macro, body: string) => {
      const language =
        /<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>/i.exec(body)?.[1]?.trim() ?? ''
      const code =
        /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/i.exec(body)?.[1] ?? ''
      return `\n\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\`\n`
    },
  )
  // noformat / panel 类宏降级为引用块。
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="(noformat|panel)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_macro, _name: string, body: string) => `\n> ${stripTags(body).trim().replace(/\n/g, '\n> ')}\n`,
  )
  s = s.replace(/<ac:image[^>]*>([\s\S]*?)<\/ac:image>|<img[^>]*>/gi, (_image, inner: string | undefined) => {
    // ac:alt 既有属性形态也有 plain-text-body 子节点形态，统一从文本里取。
    const alt = stripTags(inner ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return alt !== '' ? `\n[图片: ${decodeEntities(alt)}]\n` : '\n[图片]\n'
  })
  s = s.replace(
    /<ac:emoticon[^>]*ac:name="([^"]*)"[^>]*\/?>(?:<\/ac:emoticon>)?/gi,
    (_icon, name: string) => `:${name}:`,
  )
  s = s.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi, (_link, inner: string) => {
    const title = /ri:content-title="([^"]*)"/i.exec(inner)?.[1]
    const text = stripTags(inner).trim()
    return `[${decodeEntities(title ?? text)}]`
  })
  s = convertTables(s)
  s = convertLists(s)
  s = s.replace(/<h([1-6])[^>]*>/gi, (_tag, level: string) => `\n\n${'#'.repeat(Number(level))} `)
  s = s.replace(/<\/h[1-6]>/gi, '\n\n')
  s = s.replace(/<p[^>]*>/gi, '')
  s = s.replace(/<\/p>/gi, '\n\n')
  s = s.replace(/<br\s*\/?>|<hr\s*\/?>/gi, '\n')
  s = s.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_pre, code: string) => `\n\`\`\`\n${stripTags(code).replace(/\n$/, '')}\n\`\`\`\n`,
  )
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_quote, body: string) => {
    const text = stripTags(body).trim()
    return `\n> ${text.replace(/\n/g, '\n> ')}\n`
  })
  s = s.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi,
    (_tag, _open: string, body: string) => `**${body}**`,
  )
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_tag, _open: string, body: string) => `*${body}*`)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_tag, body: string) => `\`${stripTags(body)}\``)
  s = s.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_tag, href: string, text: string) => {
    const label = stripTags(text).trim()
    return `[${label || href}](${href})`
  })
  s = stripTags(s)
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

// —— Jira Server / DC：wiki markup → markdown（轻转换，未识别语法原样保留）——

export function wikiToMarkdown(text: string): string {
  let s = text
  s = s.replace(
    /(^|\n)h([1-6])\.\s*/g,
    (_match, lead: string, level: string) => `${lead}\n${'#'.repeat(Number(level))} `,
  )
  // 行内 {{mono}} 先于 {code} 块转换，否则块规则会把 {{code}} 误当块起始。
  s = s.replace(/\{\{([^}\n]+)\}\}/g, '`$1`')
  s = s.replace(
    /\{code(?::([a-z0-9]+))?\}([\s\S]*?)\{code\}/gi,
    (_code, language: string | undefined, body: string) =>
      `\n\`\`\`${language ?? ''}\n${body.replace(/^\n+/, '').replace(/\n+$/, '')}\n\`\`\`\n`,
  )
  s = s.replace(
    /\{noformat\}([\s\S]*?)\{noformat\}/gi,
    (_code, body: string) => `\n\`\`\`\n${body.replace(/^\n+/, '').replace(/\n+$/, '')}\n\`\`\`\n`,
  )
  s = s.replace(
    /\{quote\}([\s\S]*?)\{quote\}/gi,
    (_quote, body: string) => `\n> ${body.trim().replace(/\n/g, '\n> ')}\n`,
  )
  // 图片参数（width / height / alt）只属展示形态：占位符只留文件名，避免被后面的链接规则当 wiki 链接二次命中。
  s = s.replace(
    /!([^!\n]+)!/g,
    (_image, target: string) => `[图片: ${target.split('|')[0]?.trim() || target}]`,
  )
  s = s.replace(/\[([^|\]\n]+)\|([^\]\n]+)\]/g, '[$1]($2)')
  s = s.replace(/\[((?:https?:)?\/\/[^\]\n]+)\]/g, '$1')
  s = s.replace(/(^|\n)\*\s+/g, '$1- ')
  s = s.replace(/\*([^*\n]+)\*/g, '**$1**')
  s = s.replace(/(^|[^*])_([^_\n]+)_(?!\w)/g, '$1*$2*')
  s = s.replace(/(^|\n)----(\s*\n)/g, '$1---$2')
  return s.trim()
}

import { describe, expect, it } from 'vitest'
import { adfToMarkdown, storageToMarkdown, truncateText, wikiToMarkdown } from '../../src/markup'

describe('truncateText', () => {
  it('短文本不截断', () => {
    const result = truncateText('hello', 10)
    expect(result).toEqual({ text: 'hello', offset: 0, truncated: false, totalChars: 5 })
  })

  it('超长截断并支持续取', () => {
    const first = truncateText('abcdef', 4)
    expect(first).toEqual({ text: 'abcd', offset: 0, truncated: true, totalChars: 6 })
    const second = truncateText('abcdef', 4, 4)
    expect(second).toEqual({ text: 'ef', offset: 4, truncated: false, totalChars: 6 })
  })

  it('offset 越界返回空文本', () => {
    const result = truncateText('abc', 4, 99)
    expect(result).toEqual({ text: '', offset: 3, truncated: false, totalChars: 3 })
  })

  it('负 offset 收敛到 0', () => {
    expect(truncateText('abc', 2, -5).text).toBe('ab')
  })
})

describe('adfToMarkdown', () => {
  it('段落与加粗、链接标记', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '普通' },
            { type: 'text', text: '加粗', marks: [{ type: 'strong' }] },
            { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }] },
            { type: 'text', text: '代码', marks: [{ type: 'code' }] },
          ],
        },
      ],
    }
    expect(adfToMarkdown(doc)).toBe('普通**加粗**[链接](https://x.com)`代码`')
  })

  it('标题、列表与代码块', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '二' }] }] },
          ],
        },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }] }] },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
      ],
    }
    expect(adfToMarkdown(doc)).toBe(
      ['## 标题', '- 一\n- 二', '1. 甲', '```ts\nconst a = 1\n```'].join('\n\n'),
    )
  })

  it('mention / emoji / date / status / inlineCard / media', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { text: '@张三' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { text: '🙂', shortName: 'smile' } },
            { type: 'text', text: ' ' },
            { type: 'date', attrs: { long: 0 } },
            { type: 'text', text: ' ' },
            { type: 'status', attrs: { text: '进行中' } },
            { type: 'text', text: ' ' },
            { type: 'inlineCard', attrs: { url: 'https://x.com/1' } },
          ],
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', filename: 'a.png' } }] },
      ],
    }
    const output = adfToMarkdown(doc)
    expect(output).toContain('@张三')
    expect(output).toContain('🙂')
    expect(output).toContain('1970-01-01')
    expect(output).toContain('[进行中]')
    expect(output).toContain('https://x.com/1')
    expect(output).toContain('[附件: a.png]')
  })

  it('表格转 markdown 行', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '列A' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '列B' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a1' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b|1' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(adfToMarkdown(doc)).toBe(['| 列A | 列B |', '| --- | --- |', '| a1 | b\\|1 |'].join('\n'))
  })

  it('非 doc 根返回空串', () => {
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown('text')).toBe('')
  })
})

describe('storageToMarkdown', () => {
  it('code 宏与标题、段落', () => {
    const html = [
      '<h2>部署</h2>',
      '<p>第一步 <strong>准备</strong> 环境。</p>',
      '<ac:structured-macro ac:name="code" ac:schema-version="1">',
      '<ac:parameter ac:name="language">bash</ac:parameter>',
      '<ac:plain-text-body><![CDATA[echo hi\n]]></ac:plain-text-body>',
      '</ac:structured-macro>',
    ].join('')
    const output = storageToMarkdown(html)
    expect(output).toContain('## 部署')
    expect(output).toContain('第一步 **准备** 环境。')
    expect(output).toContain('```bash\necho hi\n```')
  })

  it('列表、链接、实体解码', () => {
    const html =
      '<ul><li>一 &amp; 二</li><li>三</li></ul><p>见 <a href="https://x.com/a">文档</a> 与 &lt;标记&gt;。</p>'
    const output = storageToMarkdown(html)
    expect(output).toContain('- 一 & 二')
    expect(output).toContain('- 三')
    expect(output).toContain('[文档](https://x.com/a)')
    expect(output).toContain('<标记>')
  })

  it('表格与图片、表情', () => {
    const html = [
      '<table><tr><th>列A</th><th>列B</th></tr><tr><td>a1</td><td>b1</td></tr></table>',
      '<ac:image><ac:alt><ac:plain-text-body><![CDATA[架构图]]></ac:plain-text-body></ac:alt></ac:image>',
      '<p>好的 <ac:emoticon ac:name="thumbs-up" /> </p>',
    ].join('')
    const output = storageToMarkdown(html)
    expect(output).toContain('| 列A | 列B |')
    expect(output).toContain('| a1 | b1 |')
    expect(output).toContain('[图片: 架构图]')
    expect(output).toContain(':thumbs-up:')
  })

  it('ac:link 降级为标题文本', () => {
    const html = '<p>参考 <ac:link><ri:page ri:content-title="手册" /></ac:link> 完成。</p>'
    expect(storageToMarkdown(html)).toContain('参考 [手册] 完成。')
  })
})

describe('wikiToMarkdown', () => {
  it('标题、加粗、代码与列表', () => {
    const text =
      'h2. 标题\n\n*加粗* 与 _斜体_ 与 {{code}}\n\n* 列表一\n* 列表二\n\n{code:js}\nlet a = 1\n{code}'
    const output = wikiToMarkdown(text)
    expect(output).toContain('## 标题')
    expect(output).toContain('**加粗**')
    expect(output).toContain('*斜体*')
    expect(output).toContain('`code`')
    expect(output).toContain('- 列表一')
    expect(output).toContain('```js\nlet a = 1\n```')
  })

  it('智能链接与图片占位', () => {
    const output = wikiToMarkdown(
      '[详情|https://x.com/d] 与 !a.png! 与 [https://x.com/raw] 与 !b.png|width=1030,height=340!',
    )
    expect(output).toContain('[详情](https://x.com/d)')
    expect(output).toContain('[图片: a.png]')
    expect(output).toContain('https://x.com/raw')
    // 带尺寸参数的图片只保留文件名，不被链接规则二次命中成假 markdown 链接。
    expect(output).toContain('[图片: b.png]')
    expect(output).not.toContain('width=1030')
  })

  it('quote 与分隔线', () => {
    const output = wikiToMarkdown('{quote}\n引用内容\n{quote}\n\n----\n\n后面')
    expect(output).toContain('> 引用内容')
    expect(output).toContain('---')
  })
})

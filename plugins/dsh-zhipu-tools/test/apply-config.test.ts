/** apply-config：patch 行级 upsert 的纯函数行为（真实 YAML 文本往返）。 */

import { describe, expect, it } from 'vitest'
import { upsertWebSearchConfig } from '../src/apply-config'

const BASE_URL = 'http://127.0.0.1:39617'

describe('upsertWebSearchConfig', () => {
  it('空文件：追加两行全新配置行', () => {
    const text = upsertWebSearchConfig(null, BASE_URL)
    expect(text).toContain('id: web-deepseek-api')
    expect(text).toContain('apiKeyEnv: ZAI_CODING_CN_API_KEY')
    expect(text).toContain(`baseURL: ${BASE_URL}`)
    expect(text).toContain('id: web')
    expect(text).toContain('searchProvider: deepseek-search-api')
    expect(text).toContain('fetchProvider: deepseek-fetch-api')
  })

  it('既有行只改自家键：用户注释、无关行与未知配置键原样保留，且幂等', () => {
    const before = [
      '# 我的 patch',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: zai-coding-cn',
      '- id: web-deepseek-api # 端点行',
      '  name: "@deepseek-ai/dsh-web-deepseek-api"',
      '  config:',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      '    baseURL: http://127.0.0.1:1',
      '    model: deepseek-v4-flash',
      '- id: web',
      '  name: "@deepseek-ai/dsh-web"',
      '  config:',
      '    searchProvider: deepseek-search-api',
    ].join('\n')
    const after = upsertWebSearchConfig(before, BASE_URL)
    expect(after).toContain('# 我的 patch')
    expect(after).toContain('provider: zai-coding-cn')
    expect(after).toContain('# 端点行')
    expect(after).toContain('model: deepseek-v4-flash')
    expect(after).toContain('apiKeyEnv: ZAI_CODING_CN_API_KEY')
    expect(after).toContain(`baseURL: ${BASE_URL}`)
    expect(after).toContain('fetchProvider: deepseek-fetch-api')
    expect(upsertWebSearchConfig(after, BASE_URL)).toBe(after)
  })

  it('disabled 行被启用：摘除标记让按钮语义成立', () => {
    const before = [
      '- id: web',
      '  name: "@deepseek-ai/dsh-web"',
      '  disabled: true',
      '  config:',
      '    searchProvider: deepseek-search-api',
    ].join('\n')
    const after = upsertWebSearchConfig(before, BASE_URL)
    expect(after).not.toContain('disabled')
    expect(after).toContain('fetchProvider: deepseek-fetch-api')
  })

  it('insert 形态的同名行明确报错，不接管', () => {
    const before = ['- insert:', '    - id: web', '      name: "@deepseek-ai/dsh-web"'].join('\n')
    expect(() => upsertWebSearchConfig(before, BASE_URL)).toThrow(/insert 形态/)
  })

  it('非序列顶层与语法错误原样抛出（fail loud）', () => {
    expect(() => upsertWebSearchConfig('just a string', BASE_URL)).toThrow(/顶层数组/)
    expect(() => upsertWebSearchConfig('- id: [unclosed', BASE_URL)).toThrow()
  })
})

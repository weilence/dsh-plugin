// 条目级一致性判定：canonicalJson 的规范化口径 + 三个 status 谓词的状态矩阵
// （same 跳过 / diff 覆盖 / absent 远端安装 / unknown 任侧指纹缺失按 diff 保守执行）。

import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  mcpSignature,
  mcpStatus,
  pluginStatus,
  skillStatus,
  type RemoteMcpFact,
  type RemotePluginFact,
  type RemoteSkillFact,
} from '../src/shared'

describe('canonicalJson', () => {
  it('对象键序不敏感、数组保序、undefined 归一为 null', () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }))
    expect(canonicalJson([{ x: 1 }, 2])).toBe('[{"x":1},2]')
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({ a: null }))
  })
})

describe('mcpSignature', () => {
  it('config 内容相同即相等（键序无关）；disabled 参与判定', () => {
    expect(mcpSignature({ command: 'npx', args: ['a'] }, false)).toBe(
      mcpSignature({ args: ['a'], command: 'npx' }, false),
    )
    expect(mcpSignature({ command: 'npx' }, true)).not.toBe(mcpSignature({ command: 'npx' }, false))
  })
})

describe('skillStatus', () => {
  it('四态：absent / same / diff / unknown（任侧指纹缺失）', () => {
    expect(skillStatus('d', undefined)).toBe('absent')
    expect(skillStatus('d', { name: 'x', digest: 'd' } satisfies RemoteSkillFact)).toBe('same')
    expect(skillStatus('d', { name: 'x', digest: 'e' } satisfies RemoteSkillFact)).toBe('diff')
    expect(skillStatus(null, { name: 'x', digest: 'd' } satisfies RemoteSkillFact)).toBe('unknown')
    expect(skillStatus('d', { name: 'x', digest: null } satisfies RemoteSkillFact)).toBe('unknown')
  })
})

describe('mcpStatus', () => {
  it('三态：absent / same / diff（签名恒可计算，无 unknown）', () => {
    const fact: RemoteMcpFact = { serverName: 's', signature: 'sig', summary: 'x' }
    expect(mcpStatus('sig', fact)).toBe('same')
    expect(mcpStatus('other', fact)).toBe('diff')
    expect(mcpStatus('sig', undefined)).toBe('absent')
  })
})

describe('pluginStatus', () => {
  it('四态：absent（未激活）/ same（激活且版本等）/ diff / unknown（任侧版本缺失）', () => {
    expect(pluginStatus('1.0.0', undefined)).toBe('absent')
    expect(pluginStatus('1.0.0', { name: 'p', version: '1.0.0' } satisfies RemotePluginFact)).toBe('same')
    expect(pluginStatus('1.0.0', { name: 'p', version: '2.0.0' } satisfies RemotePluginFact)).toBe('diff')
    expect(pluginStatus(null, { name: 'p', version: '1.0.0' } satisfies RemotePluginFact)).toBe('unknown')
    expect(pluginStatus('1.0.0', { name: 'p', version: null } satisfies RemotePluginFact)).toBe('unknown')
  })
})

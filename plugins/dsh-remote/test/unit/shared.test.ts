// 条目级一致性判定：canonicalJson 的规范化口径 + 三个 status 谓词的状态矩阵
// （same 跳过 / diff 覆盖 / absent 远端安装 / unknown 任侧指纹缺失按 diff 保守执行）。
// 插件谓词按传输形态选比对值（push 比内容指纹 / remote npm 比版本），谓词本身
// 只做字符串相等——字段选择是调用侧的事。

import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  compareDshVersion,
  dshDrift,
  LOCAL_TUNNEL_PORT_BASE,
  LOCAL_TUNNEL_PORT_SPAN,
  mcpSignature,
  mcpStatus,
  pluginStatus,
  preferredLocalTunnelPort,
  promptStatus,
  skillStatus,
  type RemoteMcpFact,
  type RemotePromptFact,
  type RemoteSkillFact,
} from '../../src/shared'

describe('canonicalJson', () => {
  it('对象键序不敏感、数组保序、undefined 归一为 null', () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }))
    expect(canonicalJson([{ x: 1 }, 2])).toBe('[{"x":1},2]')
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({ a: null }))
  })
})

describe('mcpSignature', () => {
  it('条目内容相同即相等（键序无关）；disabled 与未知键参与判定', () => {
    expect(mcpSignature({ command: 'npx', args: ['a'] })).toBe(mcpSignature({ args: ['a'], command: 'npx' }))
    expect(mcpSignature({ command: 'npx', disabled: true })).not.toBe(mcpSignature({ command: 'npx' }))
    expect(mcpSignature({ command: 'npx', reconnect: { enabled: false } })).not.toBe(
      mcpSignature({ command: 'npx' }),
    )
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
    const fact: RemoteMcpFact = { name: 's', signature: 'sig', summary: 'x' }
    expect(mcpStatus('sig', fact)).toBe('same')
    expect(mcpStatus('other', fact)).toBe('diff')
    expect(mcpStatus('sig', undefined)).toBe('absent')
  })
})

describe('pluginStatus', () => {
  it('四态：absent（未激活）/ same（比对值相等）/ diff / unknown（任侧值缺失）', () => {
    expect(pluginStatus('1.0.0', undefined)).toBe('absent')
    expect(pluginStatus('1.0.0', '1.0.0')).toBe('same')
    expect(pluginStatus('1.0.0', '2.0.0')).toBe('diff')
    expect(pluginStatus(null, '1.0.0')).toBe('unknown')
    expect(pluginStatus('1.0.0', null)).toBe('unknown')
  })
})

describe('promptStatus', () => {
  it('四态：absent（远端无文件）/ same / diff / unknown（事实或摘要读不到）', () => {
    expect(promptStatus('d', null)).toBe('unknown')
    expect(promptStatus('d', { exists: false, digest: null } satisfies RemotePromptFact)).toBe('absent')
    expect(promptStatus('d', { exists: true, digest: 'd' } satisfies RemotePromptFact)).toBe('same')
    expect(promptStatus('d', { exists: true, digest: 'e' } satisfies RemotePromptFact)).toBe('diff')
    expect(promptStatus('d', { exists: true, digest: null } satisfies RemotePromptFact)).toBe('unknown')
  })
})

describe('compareDshVersion', () => {
  it('核心段按数值比较，前导 v 与 build 元数据不参与', () => {
    expect(compareDshVersion('0.2.10', '0.2.9')).toBe(1)
    expect(compareDshVersion('v0.2.0', '0.2.0')).toBe(0)
    expect(compareDshVersion('0.2.0+build.7', '0.2.0')).toBe(0)
    expect(compareDshVersion('1.0.0', '0.9.9')).toBe(1)
  })

  it('prerelease 照 npm 语义：无 prerelease > 有；数字标识按数值、数字 < 字母数字、短的在前', () => {
    expect(compareDshVersion('0.2.1', '0.2.1-rc.2')).toBe(1)
    expect(compareDshVersion('0.2.1-rc.1', '0.2.1-rc.2')).toBe(-1)
    expect(compareDshVersion('0.2.1-rc.2', '0.2.1-rc.10')).toBe(-1)
    expect(compareDshVersion('0.2.1-1', '0.2.1-rc.1')).toBe(-1)
    expect(compareDshVersion('0.2.1-alpha', '0.2.1-beta')).toBe(-1)
    expect(compareDshVersion('0.2.1-rc.1', '0.2.1-rc.1.1')).toBe(-1)
    expect(compareDshVersion('0.1.7-rc.2', '0.1.7-rc.2')).toBe(0)
  })

  it('任一侧解析不了回 null——畸形输出不当成某个方向的版本', () => {
    expect(compareDshVersion('0.2.0', '')).toBeNull()
    expect(compareDshVersion('bash: dsh: command not found', '0.2.0')).toBeNull()
    expect(compareDshVersion('0.2', '0.2.0')).toBeNull()
  })
})

describe('dshDrift', () => {
  it('远端旧于本机 = remote-behind，远端新于本机 = local-behind', () => {
    expect(dshDrift('0.2.0', '0.1.7-rc.2')).toBe('remote-behind')
    expect(dshDrift('0.1.7-rc.2', '0.3.0')).toBe('local-behind')
  })

  it('相等或任一侧读不到 = null（无法判定不驱动动作）', () => {
    expect(dshDrift('0.2.0', '0.2.0')).toBeNull()
    expect(dshDrift('v0.2.0', '0.2.0')).toBeNull()
    expect(dshDrift(null, '0.2.0')).toBeNull()
    expect(dshDrift('0.2.0', null)).toBeNull()
    expect(dshDrift('garbage', '0.2.0')).toBeNull()
  })
})

describe('preferredLocalTunnelPort', () => {
  it('同 id 恒同口，落在首选段内', () => {
    expect(preferredLocalTunnelPort('dev-box')).toBe(preferredLocalTunnelPort('dev-box'))
    const port = preferredLocalTunnelPort('dev-box')
    expect(port).toBeGreaterThanOrEqual(LOCAL_TUNNEL_PORT_BASE)
    expect(port).toBeLessThan(LOCAL_TUNNEL_PORT_BASE + LOCAL_TUNNEL_PORT_SPAN)
  })

  it('已知向量钉死散列实现（FNV-1a 32 位取槽）', () => {
    expect(preferredLocalTunnelPort('dev-box')).toBe(13084)
    expect(preferredLocalTunnelPort('work-power')).toBe(13088)
    expect(preferredLocalTunnelPort('a')).toBe(13092)
  })

  it('不同 id 散布多个槽位（碰撞由被占回退兜住）', () => {
    const ports = new Set(Array.from({ length: 60 }, (_, i) => preferredLocalTunnelPort(`conn-${i}`)))
    expect(ports.size).toBeGreaterThan(20)
  })
})

import { describe, expect, it } from 'vitest'
import { HttpError } from '@dsh-plugins/shared/http'
import { chooseSite, normalizeSites, validateSiteDraft, workspaceMatches } from '../../src/sites'
import { hostOf, type SiteDraft } from '../../src/shared'

describe('validateSiteDraft', () => {
  it('最小合法站点：name + url，去尾斜杠', () => {
    const site = validateSiteDraft({ name: 'yamu', url: 'https://gitlab.yamu.com/' })
    expect(site).toEqual({ name: 'yamu', url: 'https://gitlab.yamu.com' })
  })

  it('非法对象 / 站点名 / 缺地址直接拒绝', () => {
    expect(() => validateSiteDraft('x')).toThrow(HttpError)
    expect(() => validateSiteDraft({ name: 'YAMU', url: 'https://a.com' })).toThrow(HttpError)
    expect(() => validateSiteDraft({ name: 'yamu' })).toThrow(HttpError)
  })

  it('url 协议必须是 http(s)', () => {
    expect(() => validateSiteDraft({ name: 'yamu', url: 'ftp://gitlab.yamu.com' })).toThrow(/协议/)
    expect(() => validateSiteDraft({ name: 'yamu', url: 'not-a-url' })).toThrow(HttpError)
  })

  it('workspaces 归一（正斜杠、去尾分隔符、去空去重），空数组视为未配置', () => {
    const site = validateSiteDraft({
      name: 'yamu',
      url: 'https://gitlab.yamu.com',
      workspaces: ['C:\\code\\yamu\\', '/home/me/yamu', '/home/me/yamu'],
    })
    expect(site.workspaces).toEqual(['C:/code/yamu', '/home/me/yamu'])
    expect(
      validateSiteDraft({ name: 'yamu', url: 'https://a.com', workspaces: [] }).workspaces,
    ).toBeUndefined()
  })

  it('workspaces 含空字符串条目直接拒绝（面板已过滤，patch 手写错误不静默吞）', () => {
    expect(() => validateSiteDraft({ name: 'yamu', url: 'https://a.com', workspaces: ['  '] })).toThrow(
      /非空字符串数组/,
    )
  })

  it('default 非布尔拒绝，true 保留', () => {
    expect(() => validateSiteDraft({ name: 'yamu', url: 'https://a.com', default: 'yes' })).toThrow(/default/)
    expect(validateSiteDraft({ name: 'yamu', url: 'https://a.com', default: true }).default).toBe(true)
    expect(validateSiteDraft({ name: 'yamu', url: 'https://a.com', default: false }).default).toBeUndefined()
  })
})

describe('normalizeSites', () => {
  it('缺省与非数组：空状态或 problems', () => {
    expect(normalizeSites(undefined)).toEqual({ sites: [], problems: [] })
    expect(normalizeSites('x').problems).toEqual(['sites 必须是数组'])
  })

  it('非法行降级为 problems，不炸整表', () => {
    const { sites, problems } = normalizeSites([
      { name: 'ok', url: 'https://a.com' },
      { name: 'bad' },
      { url: 'https://b.com' },
    ])
    expect(sites.map((site) => site.name)).toEqual(['ok'])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('bad')
    expect(problems[1]).toContain('第 3 行')
  })

  it('重名仅保留第一条；多个 default 仅保留第一个', () => {
    const { sites, problems } = normalizeSites([
      { name: 'a', url: 'https://a.com', default: true },
      { name: 'a', url: 'https://a2.com', default: true },
      { name: 'b', url: 'https://b.com', default: true },
    ])
    expect(sites).toEqual([
      { name: 'a', url: 'https://a.com', default: true },
      { name: 'b', url: 'https://b.com' },
    ])
    expect(problems).toHaveLength(2)
  })
})

describe('workspaceMatches', () => {
  it('相等或子目录命中，前缀子串不算', () => {
    expect(workspaceMatches('/home/me/yamu', '/home/me/yamu', false)).toBe(true)
    expect(workspaceMatches('/home/me/yamu', '/home/me/yamu/web', false)).toBe(true)
    expect(workspaceMatches('/home/me/yamu', '/home/me/yamu-web', false)).toBe(false)
    expect(workspaceMatches('/home/me/yamu', '/home/me/other', false)).toBe(false)
  })

  it('路径归一后比较；大小写敏感随平台开关', () => {
    expect(workspaceMatches('/home/me/yamu/', '/home/me/yamu/web', false)).toBe(true)
    expect(workspaceMatches('/Home/Me/Yamu', '/home/me/yamu', true)).toBe(true)
    expect(workspaceMatches('/Home/Me/Yamu', '/home/me/yamu', false)).toBe(false)
  })
})

describe('chooseSite', () => {
  const yamu: SiteDraft = { name: 'yamu', url: 'https://gitlab.yamu.com', workspaces: ['/code/yamu'] }
  const acme: SiteDraft = { name: 'acme', url: 'https://gitlab.acme.com', workspaces: ['/code/acme'] }
  const solo: SiteDraft[] = [{ name: 'yamu', url: 'https://gitlab.yamu.com' }]

  it('显式 site 优先；不存在报错列名', () => {
    expect(chooseSite([yamu, acme], { name: 'acme' }).name).toBe('acme')
    expect(() => chooseSite([yamu, acme], { name: 'nope' })).toThrow(/nope.*acme/s)
  })

  it('工作区唯一命中自动选站；歧义回落默认 / 报错', () => {
    expect(chooseSite([yamu, acme], { workspaceCwd: '/code/yamu/web' }).name).toBe('yamu')
    expect(() => chooseSite([yamu, acme], { workspaceCwd: '/code' })).toThrow(/site 参数/)
    const withDefault = [yamu, { ...acme, default: true }]
    expect(chooseSite(withDefault, { workspaceCwd: '/code' }).name).toBe('acme')
  })

  it('无工作区命中落默认站点；无默认落唯一站点；多站点无默认报错', () => {
    expect(chooseSite([yamu, { ...acme, default: true }], {}).name).toBe('acme')
    expect(chooseSite(solo, {}).name).toBe('yamu')
    expect(() => chooseSite([yamu, acme], {})).toThrow(/yamu、acme/)
  })

  it('多站点工作区命中依赖唯一性，大小写开关生效', () => {
    const upper: SiteDraft = { name: 'up', url: 'https://up.com', workspaces: ['/Code/Yamu'] }
    expect(chooseSite([upper, acme], { workspaceCwd: '/code/yamu' }, { caseInsensitive: true }).name).toBe(
      'up',
    )
    expect(() => chooseSite([upper, acme], { workspaceCwd: '/code/yamu' })).toThrow(/site 参数/)
  })
})

describe('hostOf', () => {
  it('取域名（保留非默认端口）', () => {
    expect(hostOf('https://gitlab.yamu.com')).toBe('gitlab.yamu.com')
    expect(hostOf('http://gitlab.local:8443/base')).toBe('gitlab.local:8443')
  })

  it('非 http(s) 协议拒绝', () => {
    expect(() => hostOf('ftp://gitlab.yamu.com')).toThrow(/协议/)
  })
})

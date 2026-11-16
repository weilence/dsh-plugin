import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  confluenceTokenRefOf,
  createSitesManager,
  chooseSite,
  jiraTokenRefOf,
  normalizeSites,
  normalizeWorkspacePath,
  validateSiteDraft,
  workspaceMatches,
} from '../../src/sites'
import { ROW_ID, type SiteDraft } from '../../src/shared'

const cloudSite = {
  name: 'acme',
  kind: 'cloud',
  atlassianUrl: 'https://acme.atlassian.net/',
  email: 'a@b.com',
}
const serverSite = {
  name: 'intra',
  kind: 'server',
  jiraUrl: 'http://jira.intra:8080',
  confluenceUrl: 'http://conf.intra:8090',
}

describe('凭据引用派生', () => {
  it('cloud 缺省 ATLASSIAN_<NAME>_TOKEN（两产品共用），可显式覆盖', () => {
    expect(jiraTokenRefOf({ name: 'acme', kind: 'cloud' })).toBe('ATLASSIAN_ACME_TOKEN')
    expect(confluenceTokenRefOf({ name: 'acme-dev', kind: 'cloud' })).toBe('ATLASSIAN_ACME_DEV_TOKEN')
    expect(jiraTokenRefOf({ name: 'acme', kind: 'cloud', atlassianTokenRef: 'MY_TOKEN' })).toBe('MY_TOKEN')
    expect(confluenceTokenRefOf({ name: 'acme', kind: 'cloud', atlassianTokenRef: 'MY_TOKEN' })).toBe(
      'MY_TOKEN',
    )
  })

  it('server 缺省 _JIRA_TOKEN / _CONFLUENCE_TOKEN 两份独立引用', () => {
    expect(jiraTokenRefOf({ name: 'acme', kind: 'server' })).toBe('ATLASSIAN_ACME_JIRA_TOKEN')
    expect(confluenceTokenRefOf({ name: 'acme', kind: 'server' })).toBe('ATLASSIAN_ACME_CONFLUENCE_TOKEN')
    expect(jiraTokenRefOf({ name: 'acme', kind: 'server', jiraTokenRef: 'JR' })).toBe('JR')
    expect(confluenceTokenRefOf({ name: 'acme', kind: 'server', confluenceTokenRef: 'CF' })).toBe('CF')
  })
})

describe('validateSiteDraft', () => {
  it('合法 cloud 草稿：URL 收敛尾部斜杠，default 归一', () => {
    const site = validateSiteDraft({ ...cloudSite, default: true })
    expect(site.atlassianUrl).toBe('https://acme.atlassian.net')
    expect(site.default).toBe(true)
  })

  it('合法 server 草稿：两处地址各自收敛', () => {
    const site = validateSiteDraft({
      ...serverSite,
      jiraUrl: 'http://jira.intra:8080/',
      confluenceUrl: 'http://conf.intra:8090/',
    })
    expect(site.jiraUrl).toBe('http://jira.intra:8080')
    expect(site.confluenceUrl).toBe('http://conf.intra:8090')
    expect(site.email).toBeUndefined()
  })

  it('default 非真不落字段', () => {
    expect(validateSiteDraft({ ...cloudSite, default: false }).default).toBeUndefined()
    expect(validateSiteDraft({ ...cloudSite }).default).toBeUndefined()
  })

  it('非法输入逐项拒绝（cloud）', () => {
    expect(() => validateSiteDraft(null)).toThrow(/对象/)
    expect(() => validateSiteDraft({ ...cloudSite, name: 'Acme' })).toThrow(/站点名/)
    expect(() => validateSiteDraft({ ...cloudSite, kind: 'other' })).toThrow(/kind/)
    expect(() => validateSiteDraft({ ...cloudSite, atlassianUrl: 'ftp://x' })).toThrow(/协议|URL/)
    expect(() => validateSiteDraft({ ...cloudSite, atlassianUrl: 'not a url' })).toThrow(/URL/)
    expect(() => validateSiteDraft({ ...cloudSite, atlassianUrl: '' })).toThrow(/atlassianUrl/)
    expect(() => validateSiteDraft({ name: 'acme', kind: 'cloud', atlassianUrl: 'https://x.com' })).toThrow(
      /email/,
    )
    expect(() => validateSiteDraft({ ...cloudSite, atlassianTokenRef: '' })).toThrow(/atlassianTokenRef/)
    expect(() => validateSiteDraft({ ...cloudSite, jiraUrl: 'http://x.com' })).toThrow(/jiraUrl/)
    expect(() => validateSiteDraft({ ...cloudSite, jiraTokenRef: 'JR' })).toThrow(/jiraTokenRef/)
    expect(() => validateSiteDraft({ ...cloudSite, confluenceUrl: 'http://conf.x.com' })).toThrow(
      /confluenceUrl/,
    )
    expect(() => validateSiteDraft({ ...cloudSite, default: 'yes' })).toThrow(/default/)
  })

  it('非法输入逐项拒绝（server）', () => {
    expect(() => validateSiteDraft({ name: 'intra', kind: 'server', confluenceUrl: 'http://c' })).toThrow(
      /jiraUrl/,
    )
    expect(() => validateSiteDraft({ name: 'intra', kind: 'server', jiraUrl: 'http://j' })).toThrow(
      /confluenceUrl/,
    )
    expect(() => validateSiteDraft({ ...serverSite, jiraUrl: 'not a url' })).toThrow(/jiraUrl/)
    expect(() => validateSiteDraft({ ...serverSite, confluenceUrl: 'ftp://c' })).toThrow(/协议|URL/)
    expect(() => validateSiteDraft({ ...serverSite, atlassianUrl: 'https://x.com' })).toThrow(/atlassianUrl/)
    expect(() => validateSiteDraft({ ...serverSite, atlassianTokenRef: 'A' })).toThrow(/atlassianTokenRef/)
    expect(() => validateSiteDraft({ ...serverSite, jiraTokenRef: '' })).toThrow(/jiraTokenRef/)
    expect(() => validateSiteDraft({ ...serverSite, confluenceTokenRef: '' })).toThrow(/confluenceTokenRef/)
  })

  it('server 凭据引用可显式覆盖', () => {
    const site = validateSiteDraft({ ...serverSite, jiraTokenRef: 'JR', confluenceTokenRef: 'CF' })
    expect(site.jiraTokenRef).toBe('JR')
    expect(site.confluenceTokenRef).toBe('CF')
  })

  it('projects 归一大写去重，空数组不落字段', () => {
    const site = validateSiteDraft({ ...cloudSite, projects: ['acme', 'ACME', ' dev '] })
    expect(site.projects).toEqual(['ACME', 'DEV'])
    expect(validateSiteDraft({ ...cloudSite, projects: [] }).projects).toBeUndefined()
  })

  it('projects 非法输入逐项拒绝', () => {
    expect(() => validateSiteDraft({ ...cloudSite, projects: 'ACME' })).toThrow(/projects/)
    expect(() => validateSiteDraft({ ...cloudSite, projects: [1] })).toThrow(/projects/)
    expect(() => validateSiteDraft({ ...cloudSite, projects: ['a'] })).toThrow(/项目键/)
    expect(() => validateSiteDraft({ ...cloudSite, projects: ['TOOLONGKEY1'] })).toThrow(/项目键/)
  })

  it('workspaces 归一正斜杠去重，空数组不落字段', () => {
    const site = validateSiteDraft({ ...cloudSite, workspaces: [' C:\\code\\acme\\ ', 'C:/code/acme'] })
    expect(site.workspaces).toEqual(['C:/code/acme'])
    expect(validateSiteDraft({ ...cloudSite, workspaces: [] }).workspaces).toBeUndefined()
    expect(() => validateSiteDraft({ ...cloudSite, workspaces: 'C:/code/acme' })).toThrow(/workspaces/)
    expect(() => validateSiteDraft({ ...cloudSite, workspaces: ['  '] })).toThrow(/workspaces/)
  })

  it('normalizeWorkspacePath 与 workspaceMatches 的路径边界', () => {
    expect(normalizeWorkspacePath(' C:\\code\\acme\\ ')).toBe('C:/code/acme')
    expect(workspaceMatches('C:/code/acme', 'C:/code/acme/packages/x', false)).toBe(true)
    expect(workspaceMatches('C:/code/acme', 'C:/code/acmeX', false)).toBe(false)
    expect(workspaceMatches('c:/code/acme', 'C:/CODE/ACME/x', true)).toBe(true)
    expect(workspaceMatches('c:/code/acme', 'C:/CODE/ACME/x', false)).toBe(false)
  })
})

describe('normalizeSites', () => {
  it('undefined / null → 空表无问题', () => {
    expect(normalizeSites(undefined)).toEqual({ sites: [], problems: [] })
    expect(normalizeSites(null)).toEqual({ sites: [], problems: [] })
  })

  it('非数组 → 单条问题', () => {
    const result = normalizeSites('nope')
    expect(result.sites).toEqual([])
    expect(result.problems).toHaveLength(1)
  })

  it('非法行降级为 problems，合法行保留', () => {
    const result = normalizeSites([
      { ...cloudSite },
      { name: '坏名', kind: 'cloud', atlassianUrl: 'https://x.com', email: 'a@b.com' },
    ])
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]?.name).toBe('acme')
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain('坏名')
  })

  it('重名保留第一条并报问题', () => {
    const result = normalizeSites([cloudSite, cloudSite])
    expect(result.sites).toHaveLength(1)
    expect(result.problems).toHaveLength(1)
  })

  it('多个 default 只保留第一个', () => {
    const result = normalizeSites([
      { ...cloudSite, default: true },
      { ...serverSite, name: 'other', default: true },
    ])
    expect(result.sites.filter((site) => site.default === true)).toHaveLength(1)
    expect(result.sites[0]?.name).toBe('acme')
    expect(result.problems.join('')).toContain('default')
  })
})

describe('chooseSite', () => {
  const a: SiteDraft = {
    name: 'a',
    kind: 'server',
    jiraUrl: 'http://a',
    confluenceUrl: 'http://ac',
    projects: ['ABC'],
  }
  const b: SiteDraft = {
    name: 'b',
    kind: 'server',
    jiraUrl: 'http://b',
    confluenceUrl: 'http://bc',
    projects: ['DEF'],
    default: true,
  }
  const c: SiteDraft = {
    name: 'c',
    kind: 'server',
    jiraUrl: 'http://c',
    confluenceUrl: 'http://cc',
    projects: ['GHI'],
  }

  it('显式站点名以其为准；不存在报错列名', () => {
    expect(chooseSite([a, b, c], { name: 'c' }).name).toBe('c')
    expect(() => chooseSite([a, b, c], { name: 'nope' })).toThrow(/nope.*a、b、c/s)
  })

  it('工作区 cwd 唯一命中 workspaces 自动选站（子目录也算、可忽略大小写）', () => {
    const w: SiteDraft = {
      name: 'w',
      kind: 'server',
      jiraUrl: 'http://w',
      confluenceUrl: 'http://wc',
      workspaces: ['C:/code/acme'],
    }
    expect(chooseSite([w, b, c], { workspaceCwd: 'C:/code/acme' }).name).toBe('w')
    expect(
      chooseSite([w, b, c], { workspaceCwd: 'C:/code/acme/packages/x' }, { caseInsensitive: true }).name,
    ).toBe('w')
    expect(chooseSite([w, b, c], { workspaceCwd: 'c:/CODE/acme' }, { caseInsensitive: true }).name).toBe('w')
    expect(chooseSite([w, b, c], { workspaceCwd: 'C:/code/acmeX' }, { caseInsensitive: true })).toMatchObject(
      {
        name: 'b',
      },
    )
  })

  it('工作区优先于项目键：cwd 命中一站时以其为准', () => {
    const w: SiteDraft = {
      name: 'w',
      kind: 'server',
      jiraUrl: 'http://w',
      confluenceUrl: 'http://wc',
      workspaces: ['C:/code/w'],
    }
    expect(chooseSite([w, a, c], { workspaceCwd: 'C:/code/w', hint: 'ABC-1' }).name).toBe('w')
  })

  it('hint 唯一命中 projects 键自动选站（工单号与 JQL 形态、大小写不敏感）', () => {
    expect(chooseSite([a, b, c], { hint: 'ABC-1 修复它' }).name).toBe('a')
    expect(chooseSite([a, b, c], { hint: 'project = ghi AND status = open' }).name).toBe('c')
  })

  it('词边界：XABC-1 不命中 ABC', () => {
    expect(chooseSite([a, b, c], { hint: 'XABC-1' }).name).toBe('b')
  })

  it('歧义命中或无命中回落默认站点', () => {
    expect(chooseSite([a, b, c], { hint: 'ABC-1 DEF-2' }).name).toBe('b')
    expect(chooseSite([a, b, c], { hint: '跟 Jira 无关的文本' }).name).toBe('b')
  })

  it('无默认时唯一站点兜底；多站无默认无命中报错列名', () => {
    expect(chooseSite([a], { hint: '随便' }).name).toBe('a')
    expect(() => chooseSite([a, c], {})).toThrow(/多站点.*a、c/s)
  })
})

describe('createSitesManager 工作区状态', () => {
  function fakeCtx(initialSites: unknown[]): Context {
    const rowConfig = { sites: initialSites }
    const entry = { options: { id: ROW_ID } }
    return {
      configEditor: {
        entries: () => [entry],
        configuration: () => [{ entry, inherited: rowConfig, override: {} }],
        edit: async () => {},
      },
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: false, writable: true }),
      },
    } as unknown as Context
  }

  it('cwd 上报后 requireSite 按 workspaces 自动选站', () => {
    const manager = createSitesManager(
      fakeCtx([
        {
          name: 'acme',
          kind: 'server',
          jiraUrl: 'http://a',
          confluenceUrl: 'http://ac',
          workspaces: ['C:/code/acme'],
        },
        { name: 'other', kind: 'server', jiraUrl: 'http://b', confluenceUrl: 'http://bc' },
      ]),
    )
    expect(manager.workspaceCwd()).toBeUndefined()
    expect(() => manager.requireSite(undefined)).toThrow(/多站点/)
    manager.setWorkspaceCwd('C:/code/acme/packages/x')
    expect(manager.workspaceCwd()).toBe('C:/code/acme/packages/x')
    expect(manager.requireSite(undefined).name).toBe('acme')
    manager.setWorkspaceCwd(undefined)
    expect(() => manager.requireSite(undefined)).toThrow(/多站点/)
  })
})

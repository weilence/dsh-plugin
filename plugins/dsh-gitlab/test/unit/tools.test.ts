import { describe, expect, it, vi } from 'vitest'
import { buildTools, type ToolDeps } from '../../src/tools'
import type { GlabRunRequest, GlabRunResult } from '../../src/glab'
import type { SiteDraft } from '../../src/shared'

type ToolExec = Parameters<ReturnType<typeof buildTools>[number]['execute']>[1]

/** 工具体只消费 signal：其余 ToolRunContext 成员对本实现不可达。 */
const fakeExec = (): ToolExec => ({ signal: new AbortController().signal }) as unknown as ToolExec

const site: SiteDraft = { name: 'yamu', url: 'https://gitlab.yamu.com' }

function fakeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps & { runCalls: GlabRunRequest[] } {
  const runCalls: GlabRunRequest[] = []
  return {
    runCalls,
    requireSite: (name) => {
      expect(name === undefined || typeof name === 'string').toBe(true)
      return site
    },
    glabPath: () => '/opt/homebrew/bin/glab',
    run: async (request: GlabRunRequest) => {
      runCalls.push(request)
      const result: GlabRunResult = {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 12,
      }
      return result
    },
    ...overrides,
  }
}

describe('buildTools', () => {
  it('单工具，名称固定', () => {
    const tools = buildTools(fakeDeps())
    expect(tools.map((tool) => tool.name)).toEqual(['glab'])
  })

  it('execute：argv 与 cwd 直传、GITLAB_HOST 注入、缺省超时 60s、产物 lossless', async () => {
    const deps = fakeDeps()
    const [tool] = buildTools(deps)
    const value = (await tool.execute({ args: ['mr', 'list', '-R', 'group/repo'] }, fakeExec())) as Record<
      string,
      unknown
    >
    expect(deps.runCalls).toHaveLength(1)
    const request = deps.runCalls[0]
    expect(request.args).toEqual(['mr', 'list', '-R', 'group/repo'])
    expect(request.glabPath).toBe('/opt/homebrew/bin/glab')
    expect(request.timeoutMs).toBe(60_000)
    expect(request.cwd).toBeUndefined()
    expect(request.env['GITLAB_HOST']).toBe('gitlab.yamu.com')
    expect(value).toEqual({
      site: 'yamu',
      command: 'mr list -R group/repo',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 12,
    })
    // lossless：无 undefined 字段（宿主管道 lossless JSON 要求）
    expect(Object.keys(value)).toEqual([
      'site',
      'command',
      'exitCode',
      'stdout',
      'stderr',
      'truncated',
      'timedOut',
      'durationMs',
    ])
  })

  it('timeoutSec 钳制（1-300）与 site / cwd 透传', async () => {
    const deps = fakeDeps()
    const [tool] = buildTools(deps)
    await tool.execute({ args: ['ci', 'status'], site: 'yamu', cwd: '/repo', timeoutSec: 0 }, fakeExec())
    expect(deps.runCalls[0]?.timeoutMs).toBe(1_000)
    expect(deps.runCalls[0]?.cwd).toBe('/repo')
    await tool.execute({ args: ['ci', 'status'], timeoutSec: 9999 }, fakeExec())
    expect(deps.runCalls[1]?.timeoutMs).toBe(300_000)
  })

  it('站点 url 非法在执行前显式失败', async () => {
    const deps = fakeDeps({ requireSite: () => ({ name: 'bad', url: 'ftp://x' }) })
    const [tool] = buildTools(deps)
    await expect(tool.execute({ args: ['mr', 'list'] }, fakeExec())).rejects.toThrow(/协议/)
    expect(deps.runCalls).toHaveLength(0)
  })

  it('render：状态、stderr 与提示语', () => {
    const [tool] = buildTools(fakeDeps())
    const text = (
      tool.output?.render?.({}, {
        site: 'yamu',
        command: 'mr list',
        exitCode: null,
        stdout: '',
        stderr: 'token 失效',
        truncated: true,
        timedOut: true,
        durationMs: 60_000,
      } as never)[0] as { text: string }
    ).text
    expect(text).toContain('mr list（站点 yamu · 超时终止 · 60.0s）')
    expect(text).toContain('stderr：token 失效')
    expect(text).toContain('超时上限')
    expect(text).toContain('头尾片段')
  })

  it('产物满足 output schema 形状（宿主管道强校验，本地护栏防漂移）', async () => {
    const deps = fakeDeps()
    const [tool] = buildTools(deps)
    const value = await tool.execute({ args: ['repo', 'view'] }, fakeExec())
    assertConforms(tool.output?.schema, value, 'glab')
  })
})

type SchemaNode = {
  type?: string
  /** defineTool 把 DSL 归一化为标准 JSON Schema：required 是对象节点上的键名数组。 */
  required?: string[]
  properties?: Record<string, unknown>
  items?: unknown
  oneOf?: unknown[]
  additionalProperties?: boolean
}

/** 按宿主统一 schema DSL 递归核对产物：required 缺席与 additionalProperties 之外的键都是宿主管道会拒绝的漂移。 */
function assertConforms(schema: unknown, value: unknown, path: string): void {
  const node = schema as SchemaNode
  if (node.oneOf !== undefined) {
    const misses: string[] = []
    for (const branch of node.oneOf) {
      try {
        assertConforms(branch, value, path)
        return
      } catch (error) {
        misses.push(String(error))
      }
    }
    throw new Error(`${path} 不满足任何 oneOf 分支：${misses.join('；')}`)
  }
  switch (node.type) {
    case 'string':
      expect(value, path).toBeTypeOf('string')
      return
    case 'number':
    case 'integer':
      expect(value, path).toBeTypeOf('number')
      return
    case 'boolean':
      expect(value, path).toBeTypeOf('boolean')
      return
    case 'null':
      expect(value, path).toBeNull()
      return
    case 'array': {
      expect(Array.isArray(value), path).toBe(true)
      const list = value as unknown[]
      for (const [index, item] of list.entries()) assertConforms(node.items, item, `${path}[${index}]`)
      return
    }
    case 'object': {
      const record = value as Record<string, unknown> | null
      expect(record !== null && typeof record === 'object' && !Array.isArray(record), path).toBe(true)
      const present = record ?? {}
      const props = node.properties ?? {}
      for (const [key, prop] of Object.entries(props)) {
        if (present[key] !== undefined) assertConforms(prop, present[key], `${path}.${key}`)
      }
      for (const key of node.required ?? []) {
        expect(present[key] !== undefined, `${path}.${key} 必填缺失`).toBe(true)
      }
      if (node.additionalProperties === false) {
        const extra = Object.keys(present).filter((key) => !(key in props))
        expect(extra, `${path} 多出的键`).toEqual([])
      }
      return
    }
    default:
      return
  }
}

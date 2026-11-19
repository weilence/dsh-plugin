import { defineTool } from '@deepseek-ai/dsh-tools'
import { displayCommand, runGlab } from './glab'
import { hostOf, TOOL_GLAB, type SiteDraft } from './shared'

export interface ToolDeps {
  requireSite(name: string | undefined): SiteDraft
  /** 解析好的 glab 可执行文件路径；when 门控保证非空，运行期缺失显式报错。 */
  glabPath(): string
  /** 测试注入替身；缺省真 spawn。 */
  run?: typeof runGlab
}

const TIMEOUT_SEC_MIN = 1
const TIMEOUT_SEC_MAX = 300
const TIMEOUT_SEC_DEFAULT = 60

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function buildTools(deps: ToolDeps) {
  const glab = defineTool({
    name: TOOL_GLAB,
    description:
      '执行 GitLab CLI（glab）命令并返回 stdout、stderr 与退出码：站点由宿主解析并以 GITLAB_HOST 环境变量注入，认证使用你自己的 glab 登录态；args 是逐项传递的 argv 数组，不经 shell 解析。常用：api 走任意 REST / GraphQL 端点（"graphql" 端点、--output json、-F 传参可拿结构化数据）；mr list / view / diff / create / merge，issue list / view / create，ci list / view，repo view / clone，release、label、variable 等。不确定用法时先传 ["<命令>", "--help"] 查看帮助。',
    parameters: {
      args: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          'glab 命令行参数（argv 逐项传递，不经 shell），如 ["mr","list","-R","group/repo"] 或 ["api","projects/:id"]',
      },
      site: {
        type: 'string',
        description:
          '站点名（插件详情页配置的站点名）；缺省按当前工作区唯一命中自动选站，再落默认站点或唯一站点',
      },
      cwd: {
        type: 'string',
        description: '命令工作目录（git remote / repo 上下文类命令需要仓库目录）；缺省不设置',
      },
      timeoutSec: {
        type: 'integer',
        description: `超时秒数（${TIMEOUT_SEC_MIN}-${TIMEOUT_SEC_MAX}，缺省 ${TIMEOUT_SEC_DEFAULT}）；到点终止进程并返回已捕获输出`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string', required: true },
          command: { type: 'string', required: true },
          exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlab(value) }],
    },
    isConcurrencySafe: () => true,
    // 覆盖最大 timeoutSec 的进程超时，外层留 10s 收尾余量。
    timeoutMs: (TIMEOUT_SEC_MAX + 10) * 1000,
    async execute(args, exec) {
      const site = deps.requireSite(args.site)
      const host = hostOf(site.url)
      const timeoutSec = clamp(args.timeoutSec ?? TIMEOUT_SEC_DEFAULT, TIMEOUT_SEC_MIN, TIMEOUT_SEC_MAX)
      const run = deps.run ?? runGlab
      const result = await run(
        {
          glabPath: deps.glabPath(),
          args: args.args,
          cwd: args.cwd,
          timeoutMs: timeoutSec * 1000,
          env: { ...process.env, GITLAB_HOST: host },
        },
        exec.signal,
      )
      // 产物经一次 JSON 往返剔除 undefined（lossless JSON 要求）；JSON.parse 的
      // any 恰好同时满足 schema 推断产物与 JsonValue。
      return JSON.parse(JSON.stringify({ site: site.name, command: displayCommand(args.args), ...result }))
    },
  })
  return [glab]
}

// —— 产物消费视图：字段与上方 schema 一致（推断值结构对齐 client 的返回类型）——

interface GlabValue {
  site: string
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

function renderGlab(value: GlabValue): string {
  const status =
    value.exitCode === null ? (value.timedOut ? '超时终止' : '信号终止') : `退出码 ${value.exitCode}`
  const sections = [
    `${value.command}（站点 ${value.site} · ${status} · ${(value.durationMs / 1000).toFixed(1)}s）`,
  ]
  if (value.stdout !== '') sections.push(value.stdout)
  if (value.stderr !== '') sections.push(`stderr：${value.stderr}`)
  if (value.timedOut) sections.push('（达到超时上限，进程已终止；可加大 timeoutSec 重试）')
  if (value.truncated) sections.push('（输出超长，仅保留头尾片段）')
  return sections.join('\n')
}

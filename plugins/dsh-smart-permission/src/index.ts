import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export const inject: string[] = ['permissionPresets']

// 审批应答者靠它识别本插件发出的 ask，其他来源的审批请求照常委托给后续应答者
const ASK_REASON_PREFIX = 'smart-permission:'

/** 预设键，与 cordis.patch.yml 写入 permission 行的 presets 表键一致 */
export const DEFAULT_PRESET = 'guarded-full-access'

export interface SmartPermissionConfig {
  preset?: string
  whitelist?: string[]
  rememberApprovedForSession?: boolean
}

/** 默认白名单：只读观察与元信息类工具；写侧与执行类工具（bash、write、run_code 等）不在其中 */
const DEFAULT_WHITELIST: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
  'skill',
  'ask_user_question',
  'present',
  'exit_plan_mode',
  'get_goal',
  'create_goal',
  'update_goal',
  'list_agents',
  'wait_agent',
  'list_subagent_models',
  'job_list',
  'job_output',
  'session_search',
  'session_trace',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'load_workspace_dependencies',
  'lsp',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
]

// PTC 内层调用以 `tools.` 前缀命名，剥掉后与原生工具共用一张白名单
function normalizeToolName(name: string): string {
  return name.startsWith('tools.') ? name.slice('tools.'.length) : name
}

function toolNameFromReason(reason: string): string | undefined {
  return /tool "([^"]+)"/.exec(reason)?.[1]
}

export function apply(ctx: Context, config?: SmartPermissionConfig): void {
  const presetKey = config?.preset ?? DEFAULT_PRESET
  const whitelist = new Set(config?.whitelist ?? DEFAULT_WHITELIST)
  const rememberApproved = config?.rememberApprovedForSession !== false
  const grants = new Map<string, Set<string>>()
  const grantsOf = (sessionId: string): Set<string> => {
    const existing = grants.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    grants.set(sessionId, created)
    return created
  }

  ctx.effect(() => {
    const stopListener = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const agent = exec.agent
      if (agent === undefined || ctx.permissionPresets.current(agent.session) !== presetKey) return next()
      const name = normalizeToolName(exec.name)
      if (whitelist.has(name) || grantsOf(agent.session.id).has(name)) return next()
      return {
        kind: 'ask',
        reason: `${ASK_REASON_PREFIX} tool "${name}" is not whitelisted under the "${presetKey}" preset`,
        displayReason: {
          en: `Allow "${name}" to run with FULL ACCESS? One approval also trusts it for the rest of this session.`,
          zh: `允许「${name}」以完全权限执行吗？批准一次后，本会话内该工具不再询问。`,
        },
      }
    })

    const stopAnswerer = ctx.on(
      'approval/request',
      async (req, next): Promise<ApprovalOutcome> => {
        const agent = req.agent
        if (agent === undefined || ctx.permissionPresets.current(agent.session) !== presetKey) return next()
        if (!req.reason?.startsWith(ASK_REASON_PREFIX)) return next()
        const name = toolNameFromReason(req.reason)
        if (name !== undefined && grantsOf(agent.session.id).has(name)) return 'allowed-once'
        const outcome = await next()
        if (outcome === 'allowed-once' && rememberApproved && name !== undefined) {
          grantsOf(agent.session.id).add(name)
        }
        return outcome
      },
      { prepend: true },
    )

    return () => {
      stopListener()
      stopAnswerer()
      grants.clear()
    }
  }, 'dsh-smart-permission: guarded preset listeners')
}

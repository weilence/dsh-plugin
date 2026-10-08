# @weilence/dsh-smart-permission

「白名单完全权限」权限预设：白名单工具直接以完全权限执行，其余工具逐次询问；同一工具批准一次后，本会话内不再询问。

## 功能

安装后会在权限选择器新增预设 **白名单完全权限**（键 `guarded-full-access`）：

| 旋钮     | 值                   | 含义                                     |
| -------- | -------------------- | ---------------------------------------- |
| 沙箱模式 | `danger-full-access` | 文件沙箱不设限，放行的调用以完全权限执行 |
| 审批策略 | `ask`                | 需要审批的操作询问用户                   |

与内置「完全权限」（`danger-full-access` + `never`）的区别是补上了逐调用闸门；与「工作区内修改」的区别是放行的调用不受工作区边界约束。

## 原理

形态与官方实验性 auto-review 插件相同，把 LLM 审查者换成了确定性工具名比对：

1. **`tools/pre-execute` 监听**：每个原生调用与 PTC `tools.*` 内层调用在 body 执行前判定一次——工具名在白名单（或本会话已批准）→ 放行；否则返回 `ask` 决定，由 tools 流水线走内置审批（标准审批卡，`allowed-once` 才执行）。
2. **置前审批应答者**（`approval/request`，prepend）：识别本插件发出的 ask——已记忆的工具直接 `allowed-once`；人工批准一次后把该工具记入本会话动态白名单；其余审批请求原样委托。

## 安装

```bash
pnpm add @weilence/dsh-smart-permission   # 在 dsh 宿主 profile 目录内，或用 dsh plugin 命令安装
```

安装后在 GUI 权限选择器选择「白名单完全权限」，或执行 `/permission guarded-full-access`。

## 配置

默认白名单（只读观察与元信息类工具）：`read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch`、`todo_write`、`skill`、`ask_user_question`、`present`、`exit_plan_mode`、`get_goal`、`create_goal`、`update_goal`、`list_agents`、`wait_agent`、`list_subagent_models`、`job_list`、`job_output`、`session_search`、`session_trace`、`session_event_read`、`session_event_search`、`session_event_trace`、`load_workspace_dependencies`、`lsp`、`cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`。

覆盖配置写在用户 patch 层（整体替换行 config，需带全字段）：

```yaml
- id: dsh-smart-permission
  config:
    preset: guarded-full-access
    rememberApprovedForSession: true
    whitelist: [read, glob, grep, bash, write]
```

| 字段                         | 默认                  | 说明                                                           |
| ---------------------------- | --------------------- | -------------------------------------------------------------- |
| `preset`                     | `guarded-full-access` | 生效的预设键，须与 patch 中的 presets 表键一致                 |
| `whitelist`                  | 见上                  | 直接放行的工具名；PTC 内层调用按剥掉 `tools.` 前缀后的名字判定 |
| `rememberApprovedForSession` | `true`                | 人工批准一次后，本会话内同名工具不再询问                       |

## 已知限制

- **批准是工具粒度**：批准一次 `bash` 后，本会话内所有 `bash` 调用都不再询问，无法按参数细分。
- **批准记忆是内存态**：宿主重启后丢失，恢复的会话对同一工具会再问一次。
- **`ask_user_question` 必须留在白名单**：否则「提问」本身要先过审批，交互互相卡死。
- **子 agent**：进程内子 agent 继承预设身份时同样被闸门覆盖；其 ask 可能没有归属的应答者而按 `unavailable` 拒绝（fail-closed）。
- **放行即全权**：本预设下任何放行的调用都是完全权限执行，没有文件沙箱兜底；白名单应保持最小。

## 开发

```bash
pnpm --filter @weilence/dsh-smart-permission test
```

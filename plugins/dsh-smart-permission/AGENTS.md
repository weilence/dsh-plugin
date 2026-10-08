# @weilence/dsh-smart-permission

「白名单完全权限」权限预设插件：新增 `guarded-full-access` 预设（`danger-full-access` 沙箱 + `ask` 审批），host half 在 `tools/pre-execute` 按工具名白名单放行或转内置审批，并用置前审批应答者实现「批准一次、本会话内不再问」。无 client half。

## 结构

- `src/index.ts`：全部逻辑——`tools/pre-execute` 监听（白名单/批准记忆命中即放行，否则返回 `ask` 决定）+ `approval/request` 置前应答者（按 ask 理由前缀识别本插件的请求，人工 `allowed-once` 后记忆工具名）。行 config（`preset` / `whitelist` / `rememberApprovedForSession`）经 `apply(ctx, config)` 传入，无 schemastery Config 导出。
- `cordis.patch.yml`：两件事——整体替换基础层 `permission` 行的 presets 表（追加 `guarded-full-access`，必须完整复刻三个内置预设，patch 的 config 是整体替换）；插入本插件行。

## 改动约定

- 白名单默认值只在 `src/index.ts`（`DEFAULT_WHITELIST`）；patch 行 config 故意不带 whitelist，用户覆盖走用户 patch 层整体替换。
- 提问理由前缀 `smart-permission:` 与理由中的 `tool "名称"` 格式是监听器和应答者之间的内部契约，两端必须同步修改。

## 陷阱

- `ask_user_question` 不能移出白名单：提问本身被闸门拦下会形成「先审批才能提问」的死锁。
- patch 的 presets 表是整体替换，DSH 基础层新增内置预设时须同步本包 patch，否则选择器会丢预设。
- 插件行被单独禁用后预设仍在选择器中但闸门消失，此时该预设退化为「每个非白名单工具都询问、执行无沙箱」——卸载请用 remove 整层移除。
- 放行的调用以完全权限执行且无文件沙箱，扩白名单前先确认工具的最坏副作用。

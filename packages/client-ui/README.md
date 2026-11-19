# @dsh-plugins/client-ui

DSH 插件共享的 client UI 组件。

## 定位

官方 `@deepseek-ai/dsh-client-ui-primitives` 之上的薄封装：只组合官方控件与布局类，不新增样式概念——官方 token 升级或暗色适配时自动跟随，不产生第二套视觉体系。

## 包模型

本包是 workspace 源码包（`exports` 直指 `src`），构建期由各插件 client bundle 内联（tsdown alwaysBundle），无独立产物、无运行时依赖。

## 子路径导出

- `.` 组件（表单 Field 套件 / Dialog 与 ConfirmDialog / MenuButton / PickList / ExpandableCard / CardList / MetaItem / ModelTable / Panel / Pill / ToneChip / 通知套件）
- `./styles` 共享基础样式表的类名映射（领域组件按 `{...shared, ...local}` 合并后使用）
- `./tone` 语气色调色板（toneStyles + ToneChip）
- `./notice-relay` 一次性通知通道（零依赖，store half 直接引用）

## 常驻通知

凡 Toast 提示（无论成功失败）显示点必须常驻——挂宿主壳层 `shell.overlay` 槽位，不随面板 / 弹窗卸载；面板 / 弹窗内一律不渲染 Toast（通道划分见根 docs/panel.md）：

- store 持 `NoticeRelay<M>` 保留通知事实，emit 时按事件时间取词（或传消息描述子由显示点渲染期取词）；
- 常驻显示点二选一：`ResidentNoticeToast`（自定文本解析，描述子型通道配插件窄 t 类型）或现成条目 `ResidentNoticeSlotEntry`（纯文本通道，注入面提供 `relay` 即可，无需 locale seat）；
- 横幅 `holdMs` 统一 5000、nonce 作 key 重开计时，`onDone` 清空——无残留无重放。

## 设置弹窗加宽

宿主将设置弹窗固定在 800×800 且无尺寸 API；`useWideSettingsDialog()` 供 `settings.section` 分区根组件挂载一次——本分区激活期间为弹窗面板（`[data-shortcut-modal="settings"]`，宿主快捷键系统的稳定钩子）添加加宽类，卸载时移除，其他分区不受影响。多个插件同时接入互不冲突：同一时刻只有一个分区挂载。

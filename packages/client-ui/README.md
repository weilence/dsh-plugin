# @dsh-plugins/client-ui

DSH 插件共享的 client UI 组件。

## 定位

官方 `@deepseek-ai/dsh-client-ui-primitives` 之上的薄封装：只组合官方控件与布局类，不新增样式概念——官方 token 升级或暗色适配时自动跟随，不产生第二套视觉体系。

## 包模型

本包是 workspace 源码包（`exports` 直指 `src`），构建期由各插件 client bundle 内联（tsdown alwaysBundle），无独立产物、无运行时依赖。

## 子路径导出

- `.` 组件（表单 Field 套件 / Dialog 与 ConfirmDialog / MenuButton / PickList / ExpandableCard / CardList / MetaItem / ModelTable / Panel / Pill / ToneChip）
- `./styles` 共享基础样式表的类名映射（领域组件按 `{...shared, ...local}` 合并后使用）
- `./tone` 语气色调色板（toneStyles + ToneChip）

## 设置弹窗加宽

宿主将设置弹窗固定在 800×800 且无尺寸 API；`useWideSettingsDialog()` 供 `settings.section` 分区根组件挂载一次——本分区激活期间为弹窗面板（`[data-shortcut-modal="settings"]`，宿主快捷键系统的稳定钩子）添加加宽类，卸载时移除，其他分区不受影响。多个插件同时接入互不冲突：同一时刻只有一个分区挂载。

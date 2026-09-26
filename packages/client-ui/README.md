# @dsh-plugins/client-ui

DSH 插件共享的 client UI 组件。

## 定位

官方 `@deepseek-ai/dsh-client-ui-primitives` 之上的薄封装：只组合官方控件与
布局类，不新增样式概念——官方升级令牌 / 暗色适配时自动跟随，不产生第二套
视觉体系。

## 包模型

本包是 workspace 源码包（`exports` 直指 `src`），构建期由各插件 client bundle
内联（tsdown alwaysBundle），无独立产物、无运行时依赖。

## 子路径导出

- `.` 组件（Field 套件 / ConfirmDialog / ToneChip）
- `./styles` 共享基础样式表的类名映射（领域组件按 `{...shared, ...local}` 合并消费）
- `./tone` 语气色调色板（toneStyles + ToneChip）

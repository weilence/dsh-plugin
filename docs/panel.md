# 面板交互约定

本文件承载设置面板交互约定；强制约定（写用户数据双保险、破坏性操作基于事实、入口常驻）见根 AGENTS.md「强制约定」。

- **控件优先用官方原语**（`@deepseek-ai/dsh-client-ui-primitives`，样式随宿主主题）：按钮 `Button`、单行文本 `Input`（带前导图标槽）、勾选 `Checkbox`（纯文案标签）、开关 `Switch`、徽标 `Tag` / `Pill`、状态点 `StateDot`、菜单 `Menu`、弹层 `Modal` / `MenuSurface`、提示 `Tooltip` / `Toast`、折叠 `DisclosureRow`、分段 `SegmentedControl`、设置字段 `SettingsValueField` / `SettingsSecretField`（字段标题 + 输入 + 说明/错误单槽 + 「已覆盖」徽标与「恢复默认」）。官方原语满足不了（如需要富内容标签、列表行组合、官方未导出的控件）才自绘，并在样式注释说明缘由；官方**没有**对应组件的既定自绘件：`select` 下拉、`textarea` 多行、文件选择 `input[type=file]`、清单页同款 `SearchBox`（官方清单页自身也是手绘）、富标签勾选行（`PickList`）、文字链按钮（错误详情入口等）。整卡设置表单 `SettingsForm` 需要文档模型状态（available / writable / dirty / revision…），简单插件 store 用不上时按官方页脚样式自绘保存按钮（`ConfigSection` 先例）。
- **字段交互统一为官方 SettingsValueField 契约**（共享 kit `TextField` / `SelectField` / `TextAreaField` 一处实现）：`error` 非空即非法态——控件 `aria-invalid` 红边、说明槽**原位**显示红字错误（与 `hint` 互斥，不再用带底色的错误块）；`hint` 是字段说明行；`override`（`FieldOverride`：徽标文案 + 重置文案 + `onReset`）在标题行右侧渲染「已覆盖」徽标（官方 `Tag neutral`）+「恢复默认」文字按钮——**重置只把字段清回继承态，提交仍由表单保存完成**；字段没有继承语义就不传 `override`，整组不出现。dsh-git 插件详情页直接用官方 `SettingsValueField`（同一契约的原语形态）。
- 设置分区统一三段式：`Panel` 标题 → 一两句简短描述（`subtitle`，zh / en 同步入词典）→ 设置内容；描述缺失或过长的分区以官方设置页 Agent presets 为参照对齐。例外：插件详情页（`plugins.bundle.config` 槽位）的页面头部已是插件名与描述，`Panel` 可整体无头部，避免标题逐字重复。
- 列表过滤搜索统一用 `@dsh-plugins/client-ui` 的 `SearchBox`（样式对齐官方插件清单页搜索：放大镜前导 + `type="search"`，占位 / aria-label / 隐藏标签共用一词）；不自绘其他搜索框样式。
- 用户可能引用的可见文本（URL、端点、id、路径、错误详情）一律可选中复制；与整行点击展开 / 拖拽排序的冲突用手势仲裁解决（按按下点判定归属），不得靠禁用文本选择迁就。
- 弹窗取数（如远端清单）先与本地对比，再一次性渲染出列表，不先短暂显示旧默认值再跳变。
- 破坏性操作必须基于已确认的事实：依赖的状态读不到就禁用操作并给出原因，绝不假设执行。
- 写用户数据一律双保险：携带读取时的版本做乐观并发（如 `settings.mutate` 带 revision、全局提示词带内容版本），冲突后不得盲目覆盖；文件落盘一律 tmp+mv 原子替换。
- 操作入口一律常驻：前置条件不满足时禁用并给出原因，或点击后提示所缺的前提（如插件同步需先连接远端）；随阶段切换的只是可用动作，不是入口的有无。
- 提交 / 保存类校验与失败反馈渲染在动作按钮旁（底部动作区上方），不放表单顶部——长表单时顶部的提示区在视口外，用户点了保存看不见被拦的原因。
- 操作结果的成功提示一律走官方 `Toast` 弹出横幅（`holdMs` 统一 5000、文本或 nonce 作 key 重开计时），不放表单内行内常驻；错误与校验反馈仍行内常驻，失败原因不随弹窗消失。一次性反馈分两类通道：**操作反馈**（保存 / 删除 / 表单测试等用户在场触发的动作）走 `@dsh-plugins/client-ui` 的通知套件——store 持 `NoticeRelay`（无订阅者即分区未挂载时 emit 直接丢弃），面板经 `useNotice` + `NoticeToast` 显示，组件态随分区卸载消亡，重开设置页不重放旧 toast；**后台事件**（连接 / 同步等完成时面板可能没开）挂宿主壳层 `shell.overlay` 槽位（ui-layout 声明、root 作用域常驻，官方 plugin-manager 的 PluginRefreshToast 先例）——notice 留 store、显示点永不卸载，`onDone` 可靠清空。跨面板生命周期发生的状态变化由常驻状态控件（pill / spinner）呈现。
- 设置分区需要更宽弹窗时用 `@dsh-plugins/client-ui` 的 `useWideSettingsDialog()`——官方设置弹窗固定 800×800 且无尺寸 API；分区挂载期间生效、卸载即还原。

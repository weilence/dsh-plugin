# 面板交互约定

本文件承载设置面板交互约定；强制约定（写用户数据双保险、破坏性操作基于事实、入口常驻）见根 AGENTS.md「强制约定」。

- **控件优先用官方原语**（`@deepseek-ai/dsh-client-ui-primitives`，样式随宿主主题）：按钮 `Button`、单行文本 `Input`（带前导图标槽）、勾选 `Checkbox`（纯文案标签）、开关 `Switch`、徽标 `Tag` / `Pill`、状态点 `StateDot`、菜单 `Menu`、弹层 `Modal` / `MenuSurface`、提示 `Tooltip` / `Toast`、折叠 `DisclosureRow`、分段 `SegmentedControl`、设置字段 `SettingsValueField` / `SettingsSecretField`（字段标题 + 输入 + 说明/错误单槽 + 「已覆盖」徽标与「恢复默认」）。官方原语满足不了（如需要富内容标签、列表行组合、官方未导出的控件）才自绘，并在样式注释说明缘由；官方**没有**对应组件的既定自绘件：`select` 下拉、`textarea` 多行、文件选择 `input[type=file]`、清单页同款 `SearchBox`（官方清单页自身也是手绘）、富标签勾选行（`PickList`）、文字链按钮（错误详情入口等）。整卡设置表单 `SettingsForm` 需要文档模型状态（available / writable / dirty / revision…），简单插件 store 用不上时按官方页脚样式自绘保存按钮（`ConfigSection` 先例）。
- **字段交互统一为官方 SettingsValueField 契约**（共享 kit `TextField` / `SelectField` / `TextAreaField` 一处实现）：`error` 非空即非法态——控件 `aria-invalid` 红边、说明槽**原位**显示红字错误（与 `hint` 互斥，不再用带底色的错误块）；`hint` 是字段说明行；`override`（`FieldOverride`：徽标文案 + 重置文案 + `onReset`）在标题行右侧渲染「已覆盖」徽标（官方 `Tag neutral`）+「恢复默认」文字按钮——**重置只把字段清回继承态，提交仍由表单保存完成**；字段没有继承语义就不传 `override`，整组不出现。dsh-git 插件详情页直接用官方 `SettingsValueField`（同一契约的原语形态）。
- 设置分区统一三段式：`Panel` 标题 → 一两句简短描述（`subtitle`，zh / en 同步入词典）→ 设置内容；描述缺失或过长的分区以官方设置页 Agent presets 为参照对齐。例外：插件详情页（`plugins.bundle.config` 槽位）的页面头部已是插件名与描述，`Panel` 可整体无头部，避免标题逐字重复。
- 列表过滤搜索统一用 `@dsh-plugins/client-ui` 的 `SearchBox`（样式对齐官方插件清单页搜索：放大镜前导 + `type="search"`，占位 / aria-label / 隐藏标签共用一词）；不自绘其他搜索框样式。
- 用户可能引用的可见文本（URL、端点、id、路径、错误详情）一律可选中复制；与整行点击展开 / 拖拽排序的冲突用手势仲裁解决（按按下点判定归属），不得靠禁用文本选择迁就。
- 弹窗取数（如远端清单）先与本地对比，再一次性渲染出列表，不先短暂显示旧默认值再跳变。
- 依赖的状态读不到就禁用操作并给出原因，绝不假设执行。
- 提交 / 保存类校验与失败反馈渲染在动作按钮旁（底部动作区上方），不放表单顶部——长表单时顶部的提示区在视口外，用户点了保存看不见被拦的原因。
- 前置条件不满足除禁用并给出原因外，也可点击后提示所缺的前提（如插件同步需先连接远端）；随阶段切换的只是可用动作，不是入口的有无。
- Toast 弹出横幅（`holdMs` 统一 5000、nonce 作 key 重开计时）不放表单内行内常驻；是否给成功提示由各插件按场景决定，可以没有提示。**凡 Toast 提示——无论成功失败——显示点一律常驻**：store 持 `NoticeRelay`（或等价 store 态）保留通知事实，注册在宿主壳层 `shell.overlay` 槽位（ui-layout 声明、root 作用域常驻，官方 plugin-manager 的 PluginRefreshToast 先例）的常驻显示点订阅渲染并经 `onDone` 可靠清空——显示点永不卸载，触发面（面板 / 弹窗）关闭前后完成的反馈都能播完，无残留无重放；面板 / 弹窗内一律不渲染 Toast（含 `useNotice` + `NoticeToast` 的分区态组合）。共享套件二选一：纯文本通道直接用现成条目 `ResidentNoticeSlotEntry`；描述子型通道用 `ResidentNoticeToast` 配插件窄 t 解析（各自 wrapper 是窄类型边界）。错误与校验反馈默认行内常驻（失败原因不随触发面消失）；以 Toast 呈现的失败同样走常驻显示点。跨面板生命周期发生的状态变化由常驻状态控件（pill / spinner）呈现。
- 设置分区需要更宽弹窗时用 `@dsh-plugins/client-ui` 的 `useWideSettingsDialog()`——官方设置弹窗固定 800×800 且无尺寸 API；分区挂载期间生效、卸载即还原。
- 成规模的清单 / 管理页做成全局面板：root 作用域 `main` keyed 槽位注册页面 + `sidebar.panellist` 注册同 id 侧栏入口（点击由侧栏外壳调 `layout.selectPanel` 打开，插件不自管导航），页面版式统一用 `@dsh-plugins/client-ui` 的 `PanelPage`（官方 Plugins / 自动化任务页同款：整页滚动 + 960px 居中列 + 一级标题行），入口图标用官方 `Icon*OutlineRegular` 原语（`size` 与选中态由侧栏传入）。

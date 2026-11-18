# dsh-remote 面板交互

本文件承载连接卡片的展示与动作、徽标、通知两层通道、迁移观察窗口、连接 / 编辑表单与口令补录、国际化插件特有约定；同步弹窗的交互见 [sync.md](sync.md)，部署与版本治理见 [deploy.md](deploy.md)，连接与隧道见 [connection.md](connection.md)。控件原语与通知通道的通用约定见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」，本文件只留插件特有事实。

## 连接卡片

- 连接为可展开卡片：op 进行中是 spinner（官方 StateDot ongoing，占按钮区最左位与动作按钮中心对齐，文字进度 pill 让位），hover 经 OpHoverCard 浮层展示 progress 步骤时间线——官方 MenuSurface 材质 + CSS anchor positioning（锚名经内联 style 下发，`position-anchor` + safe 对齐回退）+ body portal，z-index 1100 高于设置弹窗的 1000（官方 HoverCard 的卡片 z-100 在弹窗下不可见故弃用），移出后 250ms grace 供指针移入面板。
- error 阶段是「连接失败」入口（按 progress.kind 取词：连接 / 同步 / 自动恢复 / 自动重连 / 升级失败），点击开 Dialog：错误摘要 + 步骤时间线 + detail 全文。
- 其余阶段显示阶段 pill；running 且 `running.health` 非空时由心跳结论徽标**替代**阶段 pill（实例重启中 / 无响应 / 状态未知，拍板理由见「已确认决策」），hover 带 systemd 详情、展开区显示观测时间与日志尾部；`running.drift` 非空时再叠加版本漂移徽标（远端可升级 / 本机版本落后，hover 带两侧版本号说明）。
- info 事实行：node / npm / dsh / 插件版本（`running.machine` 定格 + `running.instance` 心跳实时）；**不展示打开用的 token URL**（拍板理由见「已确认决策」）。
- 动作按钮按阶段渲染：运行中只有「打开」（连接成功不自动开页，经卡片「打开」按钮进入 `http://127.0.0.1:<local>/?token=…`，鉴权与 loopback 校验对转发端口照常工作）；`running.health` 非空时出现「重新连接」（复用 `POST /connect` 全流程：幂等、实例已停即被拉起，口令缺失走既有补录弹窗）；drift=remote-behind 时出现「升级远端」（ConfirmDialog 明示两侧版本与「远端实例会重启、进行中的会话会中断」，确认后随即关窗、进度走卡片 spinner）；非运行中只有「连接」；「删除」运行中也可用（本地全清，远端实例保留）；行上带同步下拉（hover 展开四项菜单，见 sync.md）。
- store 的阶段 / op 迁移检测发 toast：连接成功（prevOp 为 `recover` 时改发「已自动恢复」、`reconnect` 时发「已自动重连」、`upgrade` 时发「远端 dsh 已升级到 {version}」，与用户点连接区分）。
- 一次性通知分两层（通道约定见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」）：操作反馈（保存 / 删除 / 表单测试）走 store 的 `actionNotices` 通道（`NoticeRelay`，无订阅者即分区未挂载时 emit 直接丢弃）与面板内 `NoticeToast`；事件类通知（连接成功 / 自动恢复 / 自动重连 / 升级完成 / 同步完成与失败）留 store（`notice` + `noticeSeq`），由注册在宿主壳层 `shell.overlay` 槽位的常驻显示点 `RemoteEventToast` 渲染并经 `dismissNotice` 清空——显示点永不卸载，无残留无重放。
- 迁移记忆只在面板观察窗口内存活：stopPolling（分区卸载）清 `prevPhase` / `prevOps` 并关 observing，`refresh` 的迁移检测与 `schedulePoll` 同被该窗口守卫（关闭后在途的 refresh 不记录迁移、不补发事件 toast、不再起定时器）——拍板理由见「已确认决策」。
- 测试按钮在新增 / 编辑表单里（卡片上没有）：不保存、不要求名称、只校验目标字段，结果只走一次性 toast（`noticeSeq` 作 Toast 的 key，同文案也重新计时）；失败摘要需全文时看「连接」的失败详情弹窗。
- 新增 / 编辑表单：三段登录方式（`SegmentedControl`：SSH 别名 / 密码 / 密钥文件）+ 按段显示的地址 / 端口 / 用户 / 密钥路径 / 口令（官方 `SettingsSecretField` 写-only：已配置状态 + 留空不改 + 「清除已保存的口令」）+ 「记住口令」勾选（默认不勾）+ 别名选择弹窗（`SearchBox` 过滤，行内别名可点、元信息与路径保持文本可选）。
- 口令补录弹窗：密码登录的连接没有可用口令时（典型：没勾「记住」而宿主重启过），点「连接」「升级远端」或同步菜单先弹 Dialog 现场补录（`POST /secret` 只进内存，补完继续原动作）。
- client 侧 HTTP 封装自定义头 `x-dsh-remote`（请求校验与封装的通用约定见[根 docs/architecture.md](../../../docs/architecture.md)「双 half 架构」/「共享代码与内联机制」）。

## 国际化（插件特有）

- 词典通用约定（命名空间 `dsh-remote`、zh 键集事实源、注册与 seat 合成）见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」。
- `PanelMessage`（`{key, params}` 或 `{text}`）是 store / 弹窗投影的消息描述子：跨语言切换存活的 toast（连接成功、同步摘要等）整句入词典、不把可译片段当参数拼接，渲染期经 `messageText` 取词；Host errMsg / ssh 输出 / 条目名等外部事实用 text 原样展示、不翻译不吞。
- 取消 / 关闭 / 删除 / 保存用 common 词条；`ConfirmDialog` / `Dialog` 的 `cancelLabel` / `closeLabel` 由调用方传入，不内嵌文案；单测取词用 `test/i18n.ts` 的 `makeT`（见 [tests.md](tests.md)）。

## 已确认决策（面板）

以下为已拍板的行为决策及理由。

- 心跳结论异常时徽标替代「运行中」阶段 pill：「运行中」与异常结论并列是自相矛盾的两个状态；健康时 health 为 null 不显示。
- 面板的迁移记忆只在观察窗口内存活（分区卸载即清）：跨关闭窗口完成的迁移是旧闻，不补发事件 toast，事实由卡片状态 pill 呈现。
- 连接行不展示打开用的 token URL：启动 token 是凭据，「打开」按钮直接消费它；连接成功也不自动开页，以 toast 提示。

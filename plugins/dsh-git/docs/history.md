# dsh-git 提交历史

本文件承载 dsh-git 提交历史的规格与陷阱、取舍：提交图与文件变更链路、泳道渲染、提交行与悬停卡片、悬停延时配置面板；仓库发现见 [docs/discovery.md](discovery.md)。

## 定位

- 提交图与文件变更链路由 host half spawn 只读 git 命令（依赖 PATH 中的 git，仓库发现链路不需要）；提交图只读：不含分支过滤、搜索与 diff 内容查看（文件变更仅清单与行数统计）。

## 结构导览

- `src/log.ts`：提交图与文件变更链路（spawn 只读 git）。
- `src/client/graph.ts`：泳道布局与悬停定位纯函数（`placeCard`）。
- `src/client/CommitGraph.tsx`：提交图渲染（每行 SVG strip、展开详情区）。
- `src/client/CommitGraph.module.css`：提交图样式，`.card` 注释含 z-index 层表。
- `src/client/ConfigSection.tsx`：插件详情页的悬停延时配置面板。
- `src/client/ConfigSection.module.css`：配置面板样式。
- `src/client/hoverDelay.ts`：悬停延时的模块级 store（localStorage 持久化）。
- `src/client/locales.ts`：词典，命名空间 `dsh-git`，zh 是键集事实源、en 逐键补全（机制见根 docs/i18n.md）。
- `src/client/GuideArtworkGit.tsx`：指南入口的图标组件。
- `src/css-modules.d.ts`：`*.module.css` 的类型声明。

## 提交图链路（src/log.ts）

- 只读命令 `git log --topo-order --all` 与 `git for-each-ref`；execFile 无 shell、args 数组直传、10s 超时、`GIT_OPTIONAL_LOCKS=0`。
- 字段分隔 `\x1f`、记录分隔 `\x1e`（subject 与多行正文 `%b` 都不会与之冲突，正文是末位字段）。
- refs 分类走 for-each-ref 的命名空间前缀（`REF_NAMESPACES`：branch→heads / remote→remotes / tag→tags），不解析 `%D`（原因见下方「陷阱」）。
- 空仓库（stderr `does not have any commits yet`）是空列表不是错误；git 缺失（ENOENT）给明确中文错误。
- limit 默认 500、上限 1000，取 limit+1 条探测截断。

## 文件变更链路（src/log.ts 的 readCommitFiles）

- `git show --numstat -z` 给行数、`git show --raw -z` 给状态字母，按新路径合并；`-z` 下路径无引号无花括号压缩。
- 重命名记录两个字段 old 在前 new 在后（实证事实，解析须按此序，背景见下方「陷阱」）；numstat 重命名的路径字段为空、后跟 old/new 两个 NUL 字段；二进制行数是 `-`（置 undefined）。
- 状态折并：T→modified、C→renamed；重命名展示 `旧 → 新`。
- `--first-parent` 让合并提交展示相对第一父提交的变更（即合入内容），对普通提交无影响。
- client 侧展开时按需拉取并缓存：`requested` ref 防缓存写入重触发；失败不驻留缓存，重开即重试；切换仓库清空；文件清单拉取由「展开 ∪ 悬停」合成的 `activeHash` 共用同一份缓存（悬停半秒即拉取，点击展开时多半已就绪）。

## 泳道布局与提交图渲染（graph.ts、CommitGraph.tsx）

- 泳道布局纯函数吃拓扑序（子先于父）输入：每泳道记「期待的下一个提交」；命中归 lane、多命中合并、首父直行或并入既有 lane、次父开新 lane。
- 输出每行 `incoming`（行顶入点）/ `outgoing`（行底出边）/ `through`（穿越竖线）；渲染端每行一段 SVG strip（`CommitGraph.tsx`），无需全局协调。
- strip 高度跟随内容列实测高度（取 max(常规行高)）：展开详情等把行撑高时穿越线与出边的竖直延伸段到达行底，否则与相邻行断线；高度更新在 `useLayoutEffect([expanded, filesView?.phase])` 里同步测量落屏，`ResizeObserver` 只兜底文本换行类被动变化（RO 的 setState 会闪帧，见下方「陷阱」）。
- 出边曲线固定在常规行高内完成转向、展开区只延伸竖直直线；提交点恒锚在常规行高中点。

## 提交行交互

- 收起行默认只显示主题（弹性截断）；「显示作者 / 时间」勾选（`options.authorTime`）控制行内是否追加作者（40% 宽截断）与时间。
- 展开详情只渲染 refs 芯片（无 refs 不渲染）与文件变更清单（状态字母 / 路径 / 增删行数，超长内部滚动）；提交号、作者邮箱与变更计数只在悬停卡片，不在详情。
- 行内文本不可选（`.commit` 上 `user-select: none`）；交互只保留点击与悬停：onClick 先以 `event.target.closest('[data-detail]')` 判分区，详情区点击不参与切换；紧凑行 `li` 上 `role="button"` + Enter / Space 键盘切换，行高 `ROW_HEIGHT = 28`，点击即切换、无划选仲裁。
- 行底色只覆盖紧凑行部分：`.commit::before` 高亮层（absolute、高 28px = `ROW_HEIGHT`、`z-index: -1` 沉到内容之下，行自身 `position: relative; z-index: 0` 建立层叠上下文）；悬停 `--dsw-alias-interactive-bg-hover`，展开行 `--dsw-alias-interactive-bg-active`（规则排在 `:hover` 之后）；展开详情区完全透明不参与底色（`.main` gap 5px 让详情内容起点落在高亮带底缘 28px 处）。
- 点击切换、列表滚动（`onScroll`）取消悬停；行内主题 / 作者不挂原生 `title`（与卡片重复）。

## 悬停提交卡片

- 紧凑行与展开行悬停弹出；延时默认 500ms，0–5000ms 可编辑，入口在插件详情页（见下节）；头部不再有延时输入。
- 卡片紧贴行缘显示在行之外：行缘只取紧凑行部分（顶部 28px = `ROW_HEIGHT`，经 `rowAnchorSpan` 折算，展开详情不算行缘——卡片贴紧凑行底而非整行底）；纵向——默认顶缘贴行底，下方放不下翻到行上方（底缘贴行顶），上下都放不下贴视口收拢；横向对齐指针 x——右侧放得下卡片左缘对齐指针（右下 / 右上），放不下右缘对齐（左下 / 左上），两侧都放不下贴视口左缘收拢。
- 行 `onMouseMove` 持续跟踪指针 x 与行缘，弹出前移动即更新锚点；驻留进行中的移动只跟踪锚点、不重置计时；驻留取消后（无卡片无计时）行内移动即重新驻留。
- 离开立即隐藏：行 `onMouseLeave` 与卡片 `onMouseLeave` 以 `relatedTarget` 判向——落在 `[data-hover-card]`（行上移向卡片）或落在本行 `[data-hash=…]`（卡片上移回本行）时不隐藏，其余去向（换行 / 离窗）立即 `cancelHover`（同时中止未触发的弹出）；行 `onMouseEnter` 对同一提交原样保留（不重置计时、不挪锚点）。
- 指针换到另一行立即收起旧卡片、清空定时重新驻留——卡片只属于一次驻留，扫过列表不触发；展开详情区不属于行驻留（移入详情等同离开、立即收起，从相邻行直接进详情不驻留，移回紧凑行重新驻留）。
- `position: fixed` + `createPortal` 挂 `document.body`（视觉与命中 / 层叠两半要求，见下方「陷阱」）；自身 z-index 50——高于把手 11 / frame overlays 20 / 右栏全屏 40，低于 dockkit 浮动面板 60 与官方弹窗 1000+（层表见 `CommitGraph.module.css` 的 `.card` 注释）；无 DOM 环境（node 单测）降级原位渲染（`portalTarget` 模块常量）。
- 渲染后 layout effect 量实测尺寸，经 `placeCard` 纯函数（`graph.ts`，含单测）定位，绘制前完成无闪动；卡片 CSS `max-width / max-height: 视口 − 16px`，超限内部滚动。
- 可移入交互：`pointer-events: auto` + `user-select: text`，内容可选中复制（行内不可选、卡片可选，两者不冲突）。
- 内容：作者、相对时间 + 绝对时间（事件时间取词）、主题、提交正文（`GitCommitInfo.body`，host 以 `%b` 读取）、文件变更统计（`log.summary`，行数由缓存清单累加、二进制不计）与短提交号。

## 悬停延时配置面板（插件详情页）

- 入口在插件详情页——设置 → 插件 → 点开「Git 仓库」卡片后的页面：`plugins.bundle.config` 槽位 keyed 包名，`ConfigSection` 面板整体无头部（插件详情页例外，见根 docs/panel.md）。
- 值存 `client/hoverDelay.ts` 模块级 store：localStorage `dsh-git.hoverDelayMs` 持久化、读写 try/catch 容忍存储不可用；`useSyncExternalStore` 让配置面板与提交图面板（可同时挂载）实时一致，保存即时生效。
- 字段用官方 `SettingsValueField` 原语（字段标题 → 通宽输入框 → 辅助说明 / 错误单槽互斥、非法时输入框 `aria-invalid` 红边）；草稿与默认值（500）不同时标题行右侧出现「已覆盖」徽标 + 「恢复默认」入口（词典对齐官方译法）。
- 「恢复默认」只把默认值暂存进草稿，写入仍由保存完成（官方口径：控件不落库，保存是唯一写入点）；草稿未变更或非法（越界 / 非整数）时保存禁用，保存把数值写入 store（越界不落库），保存按钮样式对齐官方 SettingsForm 页脚实心反色。

## 陷阱

- `git show -z` 的重命名记录两个字段 **old 在前 new 在后**——mock 替身测不出字段序，只有 spawn 真 git 才暴露；解析按实证顺序，不按直觉。
- numstat 对重命名的路径字段为空，后跟 old / new 两个 NUL 字段；二进制行数是 `-`（置 undefined）。
- 这类事实必须靠 spawn 真 git 的集成测试实证（`test/integration/log.test.ts`），mock 替身只会退化成「测我们对外部工具的假设」——单测 / 集成的划分标准见根 docs/testing.md。
- refs 分类不可解析 `%D` 装饰串：本地分支可含 `/`，装饰串无法与远端区分——必须走 for-each-ref 的命名空间前缀（`REF_NAMESPACES`）。
- 提交图 strip 的高度来源禁止改为观察行本身：strip 高度会反过来撑住行高，收起时行尺寸不变、高度回不去——必须跟随内容列实测高度（取 max(常规行高)）。
- 展开与收起、文件清单异步到达的高度更新必须在 `useLayoutEffect([expanded, filesView?.phase])` 里同步测量落屏：`ResizeObserver` 回调的 setState 走并发调度、晚于当帧绘制，会闪一帧旧高度；RO 只兜底文本换行类被动变化。
- 行底色不可用 `bg-layer-1/2/3`：浅色主题三层同值，区分不出悬停 / 展开；展开行 `--dsw-alias-interactive-bg-active` 的规则必须排在 `:hover` 之后（比悬停深一档）。
- 悬停卡片 `position: fixed` 只解决**视觉**溢出（宿主契约：无 transform 祖先时 `overflow` 不裁 fixed 子元素），**命中与层叠**必须 `createPortal` 挂 `document.body`；`relatedTarget` 判向不受 portal 影响（`data-hover-card` 在卡片根上，`closest` 走真实 DOM）。
- 事故：悬停卡片不挂 portal——dock 泳道单元建立 z-10 层叠上下文（dockkit `--dsh-dockkit-dock-layer`），面板树内写多高的 z-index 都被封顶，而宿主在侧栏左缘放了隐形拖拽把手（8px 全高命中条、z-11，刻意压在右栏之上「panel hangs over the centre 时仍可抓握」），不 portal 的卡片跨过侧栏边界即被把手截走命中、触发自身 mouseleave 整卡收起（实际发生过）；故必须挂 `document.body`，挂 body 后以自身 z-index 50 参与顶层层序。
- 不得重新引入（用户已确认放弃的方案）：提交行划选复制与选区判定 / 按下-松开位移仲裁；悬停卡片借道宽限、轨迹 / 几何仲裁、隐藏宽限定时；行内挂原生 `title`；头部延时输入（已移到插件详情页）。

## 取舍（用户已确认）

- 提交图链路 spawn git：host spawn 只读 git 命令，仓库先例 dsh-mcp；扫描发现链路维持纯读文件、不依赖 git 二进制。
- 泳道 strip：出边曲线固定在常规行高内完成转向、展开区只延伸竖直直线，不得拉伸到整个展开高度——参照 JetBrains 展开形态。
- 提交行信息分区：收起行只显示主题，「显示作者 / 时间」默认不勾选；展开详情只含 refs 芯片与文件变更清单，提交号、作者邮箱与变更计数只在悬停卡片。
- 行内不可选：`.commit` 上 `user-select: none`，放弃划选复制，交互只保留点击与悬停（悬停卡片内容仍可选中复制，两者不冲突）。
- 行底色：只覆盖紧凑行部分（高亮层 28px），展开详情区完全透明不参与；用官方交互色而非 `bg-layer`。
- 悬停卡片对照 GitHub hovercard：紧凑行与展开行悬停弹出，延时默认 500ms、0–5000ms 可编辑。
- 卡片定位：紧贴行缘显示在行之外，替代早先的指针斜向偏移；行缘只取紧凑行部分（展开详情不算行缘，卡片贴紧凑行底而非整行底）。
- 展开详情区不属于行驻留：移入详情等同离开、立即收起，从相邻行直接进详情不驻留，移回紧凑行重新驻留。
- 离开语义：离开立即隐藏，无宽限定时；卡片只属于一次驻留，扫过列表不触发。
- 配置面板布局对齐官方插件配置页：官方 `SettingsValueField`、「已覆盖」徽标 + 「恢复默认」、控件不落库 / 保存是唯一写入点（官方口径）。

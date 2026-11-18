# dsh-git

DSH web 插件：右侧栏「Git 仓库」标签——递归发现会话目录下的 Git 仓库并浏览 GitLens 风格的泳道式提交历史；本文件只留链路分界、实现约束与文档索引，细节按索引读 docs/。

## 数据链路分界

插件的数据分两条链路，这条分界决定每处改动落在哪个文件、能依赖什么：仓库发现与定位（`scan.ts`）**全部读文件、不 spawn git**——不依赖 git 二进制，分支远端读 `.git/HEAD` / `.git/config` 静态内容；提交图与文件变更（`log.ts`）**spawn 只读 git**——依赖 PATH 中的 git CLI，只读命令经 execFile 调用。

## 实现约束

- `relPath` 统一 `/` 分隔：`split(sep).join('/')`，**不可替换字面反斜杠**（POSIX 上它是合法文件名字符）。
- `git show -z` 重命名记录 **old 在前 new 在后**（实证，mock 测不出）；numstat 重命名路径字段为空、后跟 old/new 两个 NUL 字段。
- 提交图每行 SVG strip 高度**跟随内容列实测高度**，禁止观察行本身（strip 会反过来撑住行高，收起后回不去）；高度更新在 `useLayoutEffect` 同步测量落屏，不用 `ResizeObserver` 的 setState（并发调度晚于当帧绘制，闪帧）；出边曲线固定常规行高内转向，不拉伸进展开区。
- 悬停卡片必须 `createPortal` 挂 `document.body`（自身 z-index 50）——不 portal 会被侧栏隐形拖拽把手（z-11）截走命中、整卡收起（实际发生过）。
- 行内不可选、无划选 / 位移仲裁；悬停卡片离开**立即隐藏**，不得引入借道宽限、轨迹 / 几何仲裁、隐藏宽限定时（用户已确认）。

## 文档

- [docs/discovery.md](docs/discovery.md)：仓库发现——判定与扫描、定位、路由 wire 契约、目录右键菜单、仓库面板，附陷阱与取舍。
- [docs/history.md](docs/history.md)：提交历史——提交图与文件变更链路、泳道渲染、提交行与悬停卡片、配置面板，附陷阱与取舍。
- [docs/tests.md](docs/tests.md)：测试地图——各测试文件覆盖什么、单测 / 集成如何运行。
- [README.md](README.md)：面向用户的功能、安装与使用。

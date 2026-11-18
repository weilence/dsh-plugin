# dsh-git 测试地图

本文件承载 dsh-git 的测试覆盖与运行方式；单测 / 集成的划分标准与命令的完整约定见根 docs/testing.md。

## 运行

- 单测：`pnpm --filter @weilence/dsh-git test`（即 `vitest run test/unit`，CI 四项检查只覆盖单测）。
- 集成（spawn 真 git）：`pnpm --filter @weilence/dsh-git test:integration`，手动执行，重要改动与发版前应跑一遍。

## test/unit/（单测：纯函数与假桩）

- `scan.test.ts`：仓库扫描与定位——三类判定与分支 / 远端读取、发现后继续下探（嵌套仓库与子模块）、剪枝与 `.git` / 裸仓库内部不进入、深度不算截断而目录 / 仓库上限触发截断、符号链接不跟随、relPath 排序与扫描根异常，以及定位的祖先链命中与越界返回 null（tmp 目录文件 IO 假桩）。
- `graph.test.ts`：泳道布局纯函数（线性直行、分叉次父开新泳道、独立头部成泳道、合并并入与释放）、悬停锚点行缘（只取紧凑行、与展开高度无关）、`placeCard` 落点（右下 / 左下 / 右上 / 左上翻转与极小视口收拢）。
- `client.test.tsx`：标签体交互——默认选中仓库、行内信息分区（勾选显隐作者与时间）、切换仓库下拉改读提交、会话无 cwd 不发请求、扫描与读提交失败行内常驻、整行点击展开与缓存（重开不再请求）、悬停卡片驻留 / 离开立即隐藏 / 移向卡片不隐藏 / 换行只驻留一次 / 展开详情不属驻留、延时配置即时生效、配置面板保存与非法禁用、截断与空态提示。
- `host.test.ts`：宿主路由——四条路由注册、定位返回最近仓库根或 null、扫描透传、log 与 files 的目录 / limit / hash 校验、guard 拒绝跨站 / 错协议标记 / 错方法、缺 cwd 与无效 JSON 返回 400（假 `ctx` / `webServer` + fake req/res 桩，全仓范本见根 docs/testing.md）。
- `contextOpen.test.ts`：右键菜单待应用选择 store——写入递增版本并通知订阅者、消费方按版本一次性应用。
- `import.test.ts`：client 请求封装——POST 扫描路由携带协议头 / cwd / 中止信号、HTTP 失败保留服务端原因。
- `i18n.ts`：非测试文件，`makeT` 取词工具（与宿主同插值语义，见根 docs/i18n.md）。

## test/integration/（集成：spawn 真 git）

- `log.test.ts`：提交图与文件变更链路实证——拓扑序返回提交与父链接（合并 HEAD 分支 / 远端 / 标签）、limit 截断与空仓库空列表、非 git 目录报错保留 git 原因、单提交文件变更（状态 / 行数 / 重命名 / 二进制）、合并提交按第一父提交展示合入内容。

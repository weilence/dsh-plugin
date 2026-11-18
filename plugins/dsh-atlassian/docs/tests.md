# docs/tests.md — 测试地图

本文件承载测试覆盖与运行方式。单测 / 集成测试的划分标准与运行约定见仓库根 [docs/testing.md](../../../docs/testing.md)；本插件的测试注入点见 [spec.md](spec.md)「结构导览」（`fetchImpl` 参数、`options.attachmentsRoot`）。

## 运行方式

- 单测：`pnpm --filter @weilence/dsh-atlassian test`（126 例）。
- 集成测试手动执行：`pnpm --filter @weilence/dsh-atlassian test:integration`。

## 单测覆盖

- markup：转换与截断。
- commands：命令语法与 steer 文本。
- sites：凭据引用派生（cloud / server 两套）。
- 草稿校验：按 kind 分形（交叉字段拒绝、评论过滤名单归一）；`chooseSite` 选站顺序（工作区 / 项目键 / 默认）与 manager 的 cwd 状态。
- rest：认证头与错误映射（ProductSite 入参）。
- attachments：附件缓存层——文件名消毒 / id 前缀路径 / tmp+rename 落盘。
- jira / confluence client：假 fetch 捕获 URL / init / 响应；jira 评论用分页感知假 fetch 模拟 `orderBy` / `startAt` 语义；附件元数据与二进制下载断言认证头。
- tools execute：假 deps + stubGlobal fetch——产物 lossless、meta 形状、产物对 output schema 的形状走查与 hint 传参、过滤名单合并、附件下载落盘到注入根目录与超限拒绝。
- store：mock api 模块，含 workspaceCwd 随附。
- host 六路由：假 ctx / credentials / configEditor 全链路 + 信任边界 + cwd 桥 + server 双凭据写入与按产品清除 + 过滤名单落盘。

## 集成测试

- 本地 HTTP 服务器模拟 Atlassian 端点走真 socket：Basic 头服务端核验、搜索 → 详情 → 评论 → 附件清单 → 附件字节链路、401 映射。

## 禁止

- 用户凭据不进任何测试。

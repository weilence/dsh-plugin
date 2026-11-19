# docs/tests.md — 测试地图

本文件承载测试覆盖：每个测试文件测什么、如何运行。单测 / 集成划分标准与 host 假桩范式见[根 docs/testing.md](../../../docs/testing.md)「测试约定」。

## 运行

- `pnpm --filter @weilence/dsh-zhipu-tools test` 即全量：测试全在扁平 `test/`（无集成测试层，本包不 spawn 真外部进程 / 真socket）。

## 覆盖地图

- `test/host.test.ts`：宿主装配——provider 注册与 dispose 注销（含下拉显示名与选中说明的声明）；凭据缺席启动报错且快照不可用；显示名按 locale 偏好解析（显式 `zh*` 中文、其余含缺席用英文）；`credentials/reference-updated` 点名本插件引用即重查快照（可用翻转、解析故障原文进日志），无关引用不触发重查。
- `test/providers.test.ts`：provider 适配——搜索直通 query/signal 与结果、available 跟随快照、fetch 的 200+text 映射与失败上抛。
- `test/search.test.ts`：搜索核心严格解析——嵌套与摊平形状、空白正文与未知形状报错、工具发现与取消。
- `test/reader.test.ts`：阅读核心严格解析（镜像 search 的形状与报错语义）。
- `test/redirect.test.ts`：重定向拒绝——请求禁止跟随携带 Bearer 的重定向。

## 约束

- 用户凭据不用于自动化真实搜索。
- 智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认（详见 docs/spec.md「合规风险」）。

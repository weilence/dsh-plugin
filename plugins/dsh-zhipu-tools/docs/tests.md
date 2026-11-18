# docs/tests.md — 测试地图

本文件承载测试覆盖：每个测试文件测什么、如何运行。单测 / 集成划分标准与 host 路由假桩范式见[根 docs/testing.md](../../../docs/testing.md)「测试约定」。

## 运行

- `pnpm --filter @weilence/dsh-zhipu-tools test` 即全量：测试全在扁平 `test/`（无集成测试层，本包不 spawn 真外部进程 / 真socket）。
- `test/i18n.ts` 是单测取词助手 `makeT`（非测试文件）。

## 覆盖地图

- `test/providers.test.ts`：provider 适配——搜索直通 query/signal 与结果、available 跟随快照、fetch 的 200+text 映射与失败上抛。
- `test/search.test.ts`：搜索核心严格解析——嵌套与摊平形状、空白正文与未知形状报错、工具发现与取消。
- `test/reader.test.ts`：阅读核心严格解析（镜像 search 的形状与报错语义）。
- `test/redirect.test.ts`：重定向拒绝——请求禁止跟随携带 Bearer 的重定向。
- `test/status.test.ts`：面板路由集成——provider 注册与 dispose 注销；状态凭据三态与 enabled 三态（两键点名 / 官方值 / 混合态）；403；开关双向——开启次序（先清旧行再写 web 行）与凭据缺席 409、关闭触发整行清除并回退部署默认且不需要凭据、body 非布尔 400、web 行缺席 409、configEditor 拒绝时原文透传且 web 行不被触碰；信任边界 403/405。
- `test/config-store.test.ts`：store / 投影——刷新、toggle 成功以响应视图为准且不弹提示、失败原文留开关旁且视图不变、pending 防抖、凭据徽标三态与故障透传。

## 约束

- 用户凭据不用于自动化真实搜索。
- 智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认（详见 docs/spec.md「合规风险」）。

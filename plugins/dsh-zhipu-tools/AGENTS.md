# @weilence/dsh-zhipu-tools

智谱 Web 搜索 provider：host half 把智谱联网搜索与网页阅读注册为 `ctx.web` 的两个 provider（`zhipu-search-api` / `zhipu-fetch-api`），官方「网页搜索与获取」设置页点名即用；host-only 形状（无 client half），用量展示归 `dsh-models`。

## 心智模型

注册与选择是两件事：注册只让 provider 可被点名，不改任何配置；选择完全归官方设置页，插件不自建任何写入入口。凭据在场性用同步快照表达（`available()` 不发网络），刷新点只有两个——apply 时与 `credentials/reference-updated` 事件点名本插件引用名时，补配后无需重启；滞后两种方向都以清晰失败兜底。下拉显示名是启动快照：按宿主 locale 偏好取一（显式 zh* 中文、其余英文）。

## 实现约束

- 禁止给本插件重新引入 provider 配置 / 写入入口（面板、路由、配置写入皆否）：官方页面已是唯一选择入口，自建入口只会留下两套状态语义。`configEditor` 仅允许只读（启动时读 locale 偏好定下拉显示名），禁止任何写入。
- 智谱凭据是真实秘密：不入日志、不入版本库、不在任何界面展示明文。
- 智谱未公布稳定的搜索输出结构：解析失败必须明确报错，不能当成零结果。

## 文档

- docs/spec.md：行为规格与陷阱——provider 注册与凭据、显示名解析与快照刷新、源码结构与依赖、合规风险。
- docs/decisions.md：已确认决策——行为取舍与理由。
- docs/tests.md：测试地图——每个测试文件覆盖什么、如何运行。
- README.md：面向用户的功能、安装与配置（只读参考）。
- 全仓约定（双 half 架构、catalog、测试划分）见根 AGENTS.md 的文档索引。

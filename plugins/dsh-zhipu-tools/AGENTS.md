# @weilence/dsh-zhipu-tools

智谱 Web 搜索 provider + 开关接入：host half 把智谱联网搜索与网页阅读注册为 `ctx.web` 的两个 provider（`zhipu-search-api` / `zhipu-fetch-api`），面板单开关经官方 `configEditor` 成对读写 `web` 行的两个 provider 键；用量展示归 `dsh-models`。

## 心智模型

provider 注册与配置选择是两件事：注册只让 provider 可用，不改变用户的选择；面板开关是唯一改写 `web` 行的入口，状态判定与写入都按成对语义——`searchProvider` / `fetchProvider` 两键都点名本插件才算开，只动一键会留下混合态。开关状态只认服务端事实：客户端不本地乐观翻转，以写入响应的完整状态视图与 `settings/document-updated` 订阅刷新为准。

## 实现约束

- 写入必须走 `ctx.configEditor`，禁止手写 patch 文件；change 禁止整份展开 `inherited` 进 next（会把部署默认值固化进用户层）；开启只叠加本插件的两个点名键，关闭走 next=inherited 整行清除、回退部署默认——不把官方 provider id 写死进 patch。
- 智谱凭据是真实秘密：不入日志、不入版本库、不在面板展示明文。
- 智谱未公布稳定的搜索输出结构：解析失败必须明确报错，不能当成零结果。

## 文档

- docs/spec.md：行为规格与陷阱——provider 注册与凭据、开关写入链路（路由与 wire 契约）、面板交互与实时同步、源码结构与依赖、合规风险。
- docs/decisions.md：已确认决策——行为取舍与理由。
- docs/tests.md：测试地图——每个测试文件覆盖什么、如何运行。
- README.md：面向用户的功能、安装与配置（只读参考，接入路径完整说明在此）。
- 全仓约定（双 half 架构、多语言词典、面板原语、两层用户 patch、catalog、测试划分）见根 AGENTS.md 的文档索引。

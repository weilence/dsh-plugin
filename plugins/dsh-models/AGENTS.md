# dsh-models

设置页「模型目录」插件：浏览 models.dev、把 Provider / 模型写入宿主 `llm-pi-ai` 用户层；host 侧带 ETag 感知的目录镜像与只读生效能力桥。

## 结构

- `src/index.ts`：host half——`GET /dsh-models/catalog`（ETag 镜像）与 `GET /dsh-models/effective-models`（可选面，`ctx.inject(['llm'])`：llm 服务缺席时不注册，目录桥照常）。
- `src/mirror.ts`：models.dev 目录镜像（GET + If-None-Match、6 小时周期、退避重试、快照持久化到 `$DSH_HOME/cache/dsh-models/`）。
- `src/effective.ts`：只读能力桥（`ctx.llm.resolveModelInfo` 的面板投影，与会话模型选择器同一份事实）。
- `src/catalog/`：models.dev wire 解析与映射（parse / map / matching / types）。
- `src/pi-ai/`：纯逻辑层——route 状态判定与写入候选（profile / ops）、官方格式归一化与校验（normalize / validate）、schema 内省（choices / view）、类型（types）。
- `src/client/`：面板——`index.ts` 接线、store / operations 状态层、列表页（ModelCatalogSection）与编辑器（RouteEditor / ModelForm / ModelTable / CreateProviderDialog / ModelsDevImport）、`drag.ts` 拖拽排序。

## 改动约定

- Host 不解释 models.dev 业务字段：解析、筛选、协议映射、能力编辑、写入全在 client half。
- 写入策略：一次改动 = 一个 `settings.mutate`，只 set / unset 目标 route 的子树并携带读取时 revision；`settings/conflict` 自动刷新后重试一次。只作用 `llm-pi-ai` 用户层，不重建组合 base、不碰 `llm-deepseek`。
- 单模型编辑写 `modelOverrides.<id>`（定向重塑，与 `models` 互斥）；新增目录未描述的模型触发整份 `models` 物化（UI 先警告）；编辑结果与目录默认等价时删除该 override。
- 字段映射（models.dev → llm-pi-ai）：`limit.context`→`contextWindow`、`limit.output`→`maxTokens`、`modalities.input` 的 text/image→`input`、`reasoning_options[effort].values`→`reasoningEfforts`（`none`/`off`→`off: null`）；价格 / 日期 / benchmark 只浏览不写入。导入合并语义：已有用户字段优先，导入只补缺失。
- `reasoningEfforts` 的六条官方规则在 client 保存前逐条前置校验，与 Host 的 `resolveModelReasoning()` 一一对应——改一侧必须同步另一侧。
- 协议、推理等级、`thinkingFormat` 与模态选项从 `llm-pi-ai` namespace 的 schema envelope 内省，schema 不可读时回退内置常量（FALLBACK_CHOICES）。

## 陷阱

- 官方 `llm-pi-ai` 会把全部内置 provider 声明进可配置目录，但真正注册的 route 只有配置里存在的：面板行列表 = 已配置 route；未配置的内置 provider 只进「新建 Provider」下拉。
- 本插件的 `cordis.patch.yml` 同时禁用官方 `ui-settings-models` 行（name 守卫：id 不再指向官方包时跳过并告警，不误伤其他行）。
- API Key 经 `credentials.set` 只写存储，`settings.yaml` 只记引用（`apiKeyEnv` 或派生 `<ROUTE>_API_KEY`）；面板不读取、不缓存、不回显。

## 测试

`pnpm --filter dsh-models test`：mirror（退避 / ETag / 持久化）、catalog 与 pi-ai 纯函数、effective / host 桥桩测试、store / operations / panel / view。

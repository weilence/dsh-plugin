# dsh-models

DeepSeek Harness Web 插件：在 Settings 里新增独立的 **模型目录** 菜单，浏览 [models.dev](https://models.dev)
并把 Provider / 模型写入宿主的 `llm-pi-ai`，在面板上为每个模型设置**能力**（输入模态、上下文、输出上限）
与**推理强度**（`reasoningEfforts`）。生成内容严格遵循官方 `@deepseek-ai/dsh-llm-pi-ai` 配置格式。

## 功能

**设置菜单「模型目录」（`settings.section` id `dsh-models`）**

- **Provider 列表（只读）**：只展示**已经配置过**的 route（组合配置或用户层写过 `providers.<route>`）：
  行头显示显示名、route id 与协议 / Endpoint；展开后模型清单**直接按行显示**——每行是
  「显示名 + 模型 ID（同一行）/ 生效能力（容量与模态）/ 思考档位」（来自 Host 只读桥
  `GET /dsh-models/effective-models`，即 `ctx.llm.resolveModelInfo`，与会话模型选择器同一份事实）。
  列表页唯一的动作是「编辑」，点击弹出该 Provider 的大编辑弹窗。
- **编辑弹窗（左编辑 · 右预览）**：左列编辑连接字段（`displayName` / `api` / `baseURL` / API Key）与模型清单（新增 / 编辑 / 删除 / 拖拽排序 / 恢复目录继承，
  模型字段含 `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / 模型级 `compat`，
  全部有「继承」态）；右列把当前草稿对应的**整个 `providers.<route>` 子树**（连接 + 模型）
  实时渲染成与 `settings.yaml` 同风格的 YAML——所见即最终一次性整值写入的用户层配置。
- 官方 `llm-pi-ai` 会把 pi-ai 内置的 **40 个 provider 全部**声明进「可配置目录」，以便配置界面在任何
  路由存在之前就能提供完整目录（`directoryEntries()`: `for (const provider of catalog) declare(...)`）；
  而真正注册的 route 只有配置里存在的那些（`const routes = [...profiles().keys()]`）。面板按官方
  Models 页同一规则区分两者：**行列表 = 已配置；未配置的内置 provider 只出现在「新建 Provider」
  的内置下拉里**，不会被当成账号列表平铺出来。
- **新建 Provider（统一入口，两种方式）**：
  「使用内置 Provider」从尚未配置的内置目录里选一个，只写 `displayName`（可选 API Key），协议、
  Endpoint 与模型目录全部继承安装目录；
  「自定义 Provider」填 Provider ID / 显示名 / API Key，Endpoint 可从 models.dev 的 Provider 里选择
  （自动带上协议），也可手动填写自定义地址（协议留到编辑页补全）；「获取模型」用 API Key 询问
  Endpoint 的模型清单，并按 models.dev 元数据补全每个模型的能力（上下文 / 输出 / 输入模态 /
  `reasoningEfforts`）。模型清单默认为空，不获取也可以直接创建。
  只能新建 Provider，唯一校验是 Provider ID 不与已配置 route 重复。

**API Key**

面板内可直接设置：密钥经 `credentials.set` **只写**存储，`settings.yaml` 里只记录引用
（沿用 profile 已有的 `apiKeyEnv`，没有则派生 `<ROUTE>_API_KEY`）。面板不读取、缓存或回显密钥。

**Host 侧**

- `GET /dsh-models/catalog`：models.dev 原始 JSON 的固定来源镜像（ETag 感知）。
- `GET /dsh-models/effective-models?provider=<route>`：某 route 当前生效的模型能力，只读。

## 数据同步架构

Host half 固定同步 `https://models.dev/api.json`：

- 启动后立即 revalidate，之后每 6 小时检查一次；
- 使用 `GET + If-None-Match`，无更新时上游返回 `304`，不会下载完整目录；
- 失败后按 1 分钟、5 分钟、15 分钟、1 小时退避，并继续提供最后成功快照；
- 原始目录与 ETag 持久化到 `$DSH_HOME/cache/dsh-models/`；
- 通过同源 `/dsh-models/catalog` 向 Client 提供原始 JSON，并支持 Client ETag/304。

Host 不解释 models.dev 的业务字段；解析、筛选、协议映射、能力编辑、Settings 写入全在 Client half 完成。
`llm` 服务缺席时只读能力桥不注册，其余功能照常可用（生效能力显示为未知）。

## 写入策略（官方格式）

一次改动 = 一个 `settings.mutate`，只 `set` / `unset` 目标 route 的子树，并携带读取时的 revision；
`settings/conflict` 自动刷新后重试一次。所有写入都作用于 `llm-pi-ai` 的**用户层**，不重建组合 base，
也不触碰 `llm-deepseek`。

| route 状态 | 判定                                            | 单模型编辑写到        |
| ---------- | ----------------------------------------------- | --------------------- |
| 目录继承   | 目录 route 且用户层无 `models`/`modelOverrides` | `modelOverrides.<id>` |
| 目录覆盖   | 目录 route，用户层有 `modelOverrides`           | `modelOverrides.<id>` |
| 显式清单   | 用户层有非空 `models`                           | `models` 数组条目     |
| 手写 route | `pi-ai` 不内置该 route                          | `models` 数组条目     |

官方语义要点：

- `models` 是**整体替换**安装目录；每个条目未设置的字段从同 id 安装目录模型取默认值。
- `modelOverrides` 是**定向重塑**（「修正一个模型，保留其余三十七个」），与 `models` 互斥，
  不能用在手写 route 上，也不能点名目录未描述的模型。
- 因此编辑单个已描述模型只写 `modelOverrides`；**新增目录未描述的模型**（或 models.dev 导入选中的模型不在目录中）
  会触发整份 `models` 物化，UI 会先给出明确警告（以后 pi-ai 升级新增的目录模型不会自动出现）。
- 条目缺席的字段等于继承；若编辑结果与目录默认等价，面板会删除该 override。

## 能力与推理强度

| 官方字段                | 面板控件                        | 语义                                                                |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `contextWindow`         | 数字框（留空继承）              | 输入 + 输出上下文总容量，正整数                                     |
| `maxTokens`             | 数字框（留空继承）              | 输出能力；**显式配置后同时成为该模型每次请求的默认输出上限**        |
| `input`                 | text / image 勾选 + 继承态      | 缺省或空数组都表示「继承下一层」，没有「不接受任何输入」的写法      |
| `reasoningEfforts`      | 继承 / `false` / 逐档自定义     | 键 = 模型提供的等级，值 = 该等级过线的拼写                          |
| `compat.thinkingFormat` | 模型级 compat（高级折叠，JSON） | 推理参数**怎么过线**；自定义网关若不设置，pi-ai 只能按 baseURL 猜测 |

`reasoningEfforts` 的官方规则（面板在保存前逐条前置校验，与 Host 的
`resolveModelReasoning()` 一一对应）：

1. 省略 = 继承安装目录能力（手写模型则等于无推理）；
2. `false` = 显式声明非推理模型；
3. 非空字典，空对象非法；
4. 键只能取 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；
5. 只有 `off` 可以留空（表示「支持该等级但不发送参数」），其余等级必须给出非空 wire 值；
6. 除 `off` 外必须至少声明一个等级。

面板的协议、推理等级、`thinkingFormat` 与模态选项全部从 `llm-pi-ai` namespace 的 schema envelope
内省（与 Host 校验用的是同一份 schema），schema 不可读时逐项回退到内置常量。

## 字段映射（models.dev → llm-pi-ai）

| models.dev                                            | `llm-pi-ai`                                      |
| ----------------------------------------------------- | ------------------------------------------------ |
| 模型 `id`                                             | `models[].id` / `modelOverrides` 键              |
| `name`                                                | `name`                                           |
| `limit.context`                                       | `contextWindow`                                  |
| `limit.output`                                        | `maxTokens`                                      |
| `modalities.input` 中的 text / image                  | `input`                                          |
| `reasoning` + `reasoning_options[type=effort].values` | `reasoningEfforts`（`none`/`off` → `off: null`） |

价格、发布日期、知识截止、Benchmark 等仅用于浏览，不写入 DSH；`toggle` 与 `budget_tokens` 没有
通用安全的映射，不自动生成推理配置。导入合并语义：**已有用户字段优先，导入只补缺失字段**。

## 安装

宿主 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均加入 `dsh-models`。Profile boot 会合并
包内 `cordis.patch.yml` 挂载 Host half；Web Client 根据包清单加载 Client half。

宿主还需要挂载标准的：

- `@deepseek-ai/dsh-llm-pi-ai`（本插件配置的 namespace 提供方）
- `@deepseek-ai/dsh-client-ui-settings`（settings section 底座）
- `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-slots`

标准 DSH Web profile 已包含这些组件。本插件不再依赖 `dsh-client-ui-settings-models`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm format        # prettier
```

构建产物：

- `lib/index.js`：Node/Host half
- `lib/client.js`：浏览器 ModuleLoader factory
- `lib/client.js.map`：Client sourcemap

工程结构：`src/pi-ai/` 是纯逻辑层（状态判定、有效值合成、官方格式归一化、写入候选、schema 内省、
校验），`src/client/` 是面板（`index.ts` 入口接线、store/operations 状态层、列表页与三个编辑器
组件、`drag.ts`/`ui.tsx` 共用控件），`src/catalog/` 是 models.dev 解析与映射。

## 许可证

MIT

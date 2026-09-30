# @weilence/dsh-models

DSH web 插件：在设置页新增「模型」菜单（面板标题「模型目录」），浏览 [models.dev](https://models.dev) 并把 Provider / 模型写入宿主的 `llm-pi-ai`，在面板上为每个模型设置**能力**（输入模态、上下文、输出上限）与**推理强度**（`reasoningEfforts`）。生成内容严格遵循官方 `@deepseek-ai/dsh-llm-pi-ai` 配置格式。

## 功能

**设置菜单「模型」（`settings.section` id `dsh-models`，面板标题「模型目录」）**

- **Provider 列表（行内编辑）**：只展示**已经配置过**的 route（组合配置或用户层写过 `providers.<route>`）：卡片头部展示显示名、route id 与协议 / 端点；点击卡片展开连接字段和模型清单，切换卡片或收起时会确认放弃未保存的修改。内置 Provider（协议、端点继承安装目录）的模型清单同样可增删改：编辑目录模型写单点覆盖（`modelOverrides`），删除目录模型或新增目录外模型会把该 route 固定为一份显式 `models` 清单（面板会提示此后果）。「获取模型」对内置 Provider 从 models.dev 拉取该 Provider 的最新清单（pi-ai 安装目录随包发布、更新滞后），补上面板还没有的模型；对自定义 Provider 则向 Endpoint 询问。少数混协议网关（GitHub Copilot、OpenRouter、OpenCode 等）的目录外模型无法保存——官方配置不能为它们指定协议，保存时会明确列出并要求删除，等 pi-ai 目录收录后再获取。
- **卡片编辑区**：编辑 Provider 字段（`displayName` / `api` / `baseURL` / API Key / 下拉选择 `reasoning` 默认推理强度）与模型清单（新增 / 编辑 / 删除 / 拖拽排序，模型字段含 `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / 模型级 `compat`，全部有「继承」态）；保存即一次性整体写入用户层的**整个 `providers.<route>` 子树**。Endpoint / 协议字段只在用户层自定义过连接时显示，内置连接不暴露空表单。新增模型时输入 id 停顿即按 models.dev 自动填充空白字段（优先当前 Provider 的目录条目，含订阅计划的专属清单），手动改过的字段不会被覆盖。
- **新建 Provider（列表顶部行内卡片，两种方式）**：点「新建 Provider」在列表首行展开表单，失败时保留填写内容；「使用内置 Provider」从尚未配置的内置目录里选一个，只写 `displayName`（可选 API Key），协议、端点与模型目录全部继承安装目录；「自定义 Provider」填 Provider ID / 显示名 / API Key，端点可从 models.dev 的 Provider 里选择（自动带上协议），也可手动填写自定义地址；「获取模型」用 API Key 向端点请求模型清单，并按 models.dev 元数据补全每个模型的能力。模型清单默认为空，不获取也可以直接创建。
- **订阅账号登录（如 OpenAI Codex / ChatGPT Plus/Pro）**：带 OAuth 登录的内置 Provider（`openai-codex` 等）在新建与编辑表单里显示「账号登录」卡——发起登录后按事件流完成浏览器 / 设备码授权（授权链接与设备码可选中复制），令牌由宿主凭据层持久化并自动刷新；`credentials/record-updated` 后「已授权」状态即时更新。已授权后主操作变为「退出登录」（删除宿主侧凭据记录，回到未登录态；换账号先退出再登录）。纯订阅型（无 API Key 形态）登录卡替换 API Key 字段；双形态 Provider（如 `openrouter`）登录卡与 API Key 字段并排。普通 API Key 型 Provider（`openai` / `anthropic` 等）不受影响，仍走 Key 表单。
- **按 Provider 展示用量**：会话选择智谱 `zai-coding-cn` 时显示 5 小时 / 每周 / 工具调用剩余额度；选择 `openai-codex` 时显示 ChatGPT 订阅限额窗口；选择 `github-copilot` 时显示 GitHub Copilot 套餐的高级请求剩余额度（非账单计费量）。仅向 Host 查询，浏览器不接触凭据；查询失败在详情中展示实际原因。
- **宽版弹窗**：进入本分区时自动加宽宿主设置弹窗（官方将面板固定为 800×800 且无尺寸 API），切到其他分区即还原，不影响其余设置页。

### API Key 存储

面板内可直接设置：密钥经 `credentials.set` **只写**存储，`settings.yaml` 里只记录引用（沿用 profile 已有的 `apiKeyEnv`，没有则派生 `<ROUTE>_API_KEY`）。面板不读取、缓存或回显密钥。

### 订阅登录的宿主接口

官方 GUI 没有任何触发 `ctx.authorization` 登录流（`dsh-llm-pi-ai` 已为 `openai-codex` 等订阅型 Provider 注册）的入口；本插件的 host half 把该登录能力暴露为同源 HTTP 接口（目录 / 发起 / 事件轮询 / 应答 / 取消），client half 用登录卡驱动。凭据形态与 API Key 不同：订阅授权是凭据记录（`kind: 'grant'`），route 不写 `apiKeyEnv`，请求时由宿主凭存储的授权签发令牌。

## 用量查询与凭据

- **智谱**：读取 Host 凭据 `ZAI_CODING_CN_API_KEY`；未配置时尝试 `ZAI_API_KEY`。用量查询独立于 `dsh-zhipu-tools` 的 MCP 挂载。
- **Codex**：复用模型面板中 `openai-codex` 的 ChatGPT 订阅登录；Host 使用同一份 OAuth 凭据及对应账户 ID，直接查询 Codex 的用量窗口，**不需要安装或登录 Codex CLI**。该查询地址来自 [Codex 开源实现](../../docs/research/codex-direct-usage.md)，并非 OpenAI 对第三方承诺兼容的公开 REST 接口；后端地址或响应格式变化时，面板将明确报告错误。当前实现还依赖 `llm-pi-ai` 的凭据记录格式及 pi-ai 的刷新契约，升级宿主时须复核。
- **Copilot**：先在模型面板登录 `github-copilot`，Host 复用 `llm-pi-ai` 保存的 GitHub OAuth 凭据，直接请求 `GET https://api.github.com/copilot_internal/user`，读取 `quota_snapshots.premium_interactions` 的剩余比例、额度和重置时间。**无需配置 `COPILOT_BILLING_TOKEN`，也无需安装 Copilot CLI 或 SDK。**该接口未公开，字段、授权策略可能变化；失败时展示原因，不退回历史账单或猜测额度。当前仅支持 `github.com` 登录，不支持 GitHub Enterprise 域名。Host 不向浏览器下发令牌。此额度不是会话／每周限额，也不得视为可计费余额。

三种用量仅在当前会话选择对应 Provider 时轮询；Host 缓存正常结果约 4 分钟，短暂缓存失败结果，详情面板可手动刷新。参考[Copilot 套餐额度接口调研](../../docs/research/copilot-quota-implementations.md)和[Codex 用量接口调研](../../docs/research/codex-direct-usage.md)。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-models
```

（或手动把 `@weilence/dsh-models` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`，Profile boot 会合并包内 `cordis.patch.yml` 挂载 host half，Web client 根据包清单加载 client half。）安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可。

宿主还需要挂载以下标准组件：

- `@deepseek-ai/dsh-llm-pi-ai`（本插件配置的 namespace 提供方）
- `@deepseek-ai/dsh-authorization`、`@deepseek-ai/dsh-credentials`（订阅登录依赖，不可用时登录入口不显示）
- `@deepseek-ai/dsh-client-ui-settings`（提供 settings section 基础设施）
- `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-slots`

标准 DSH web profile 已包含这些组件。安装后本插件的 patch 会禁用官方内置的模型设置面板（`dsh-client-ui-settings-models`），由本插件的「模型目录」面板替代。

## 开发

```bash
pnpm --filter @weilence/dsh-models typecheck
pnpm --filter @weilence/dsh-models build
pnpm --filter @weilence/dsh-models test
```

数据同步架构、写入策略与字段映射等机制细节见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT

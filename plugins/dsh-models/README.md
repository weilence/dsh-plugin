# @weilence/dsh-models

DSH web 插件：在设置页新增「模型」菜单（面板标题「模型目录」），浏览 [models.dev](https://models.dev) 并把 Provider / 模型写入宿主的 `llm-pi-ai`，在面板上为每个模型设置**能力**（输入模态、上下文、输出上限）与**推理强度**（`reasoningEfforts`）。生成内容严格遵循官方 `@deepseek-ai/dsh-llm-pi-ai` 配置格式。

## 功能

**设置菜单「模型」（`settings.section` id `dsh-models`，面板标题「模型目录」）**

- **Provider 列表（行内编辑）**：只展示**已经配置过**的 route（组合配置或用户层写过 `providers.<route>`）：卡片头部展示显示名、route id 与协议 / 端点；点击卡片展开连接字段和模型清单，切换卡片或收起时会确认放弃未保存的修改。内置 Provider 的模型清单以「显示名 + 模型 ID / 生效能力 / 推理强度」展示，不修改目录事实。
- **卡片编辑区**：编辑 Provider 字段（`displayName` / `api` / `baseURL` / API Key / 下拉选择 `reasoning` 默认推理强度）与模型清单（新增 / 编辑 / 删除 / 拖拽排序，模型字段含 `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / 模型级 `compat`，全部有「继承」态）；保存即一次性整体写入用户层的**整个 `providers.<route>` 子树**。
- **新建 Provider（列表顶部行内卡片，两种方式）**：点「新建 Provider」在列表首行展开表单，失败时保留填写内容；「使用内置 Provider」从尚未配置的内置目录里选一个，只写 `displayName`（可选 API Key），协议、端点与模型目录全部继承安装目录；「自定义 Provider」填 Provider ID / 显示名 / API Key，端点可从 models.dev 的 Provider 里选择（自动带上协议），也可手动填写自定义地址；「获取模型」用 API Key 向端点请求模型清单，并按 models.dev 元数据补全每个模型的能力。模型清单默认为空，不获取也可以直接创建。
- **订阅账号登录（如 OpenAI Codex / ChatGPT Plus/Pro）**：带 OAuth 登录的内置 Provider（`openai-codex` 等）在新建与编辑表单里显示「账号登录」卡——发起登录后按事件流完成浏览器 / 设备码授权（授权链接与设备码可选中复制），令牌由宿主凭据层持久化并自动刷新；`credentials/record-updated` 后「已授权」状态即时更新。纯订阅型（无 API Key 形态）登录卡替换 API Key 字段；双形态 Provider（如 `openrouter`）登录卡与 API Key 字段并排。普通 API Key 型 Provider（`openai` / `anthropic` 等）不受影响，仍走 Key 表单。
- **宽版弹窗**：进入本分区时自动加宽宿主设置弹窗（官方将面板固定为 800×800 且无尺寸 API），切到其他分区即还原，不影响其余设置页。

### API Key 存储

面板内可直接设置：密钥经 `credentials.set` **只写**存储，`settings.yaml` 里只记录引用（沿用 profile 已有的 `apiKeyEnv`，没有则派生 `<ROUTE>_API_KEY`）。面板不读取、缓存或回显密钥。

### 订阅登录的宿主接口

官方 GUI 没有任何触发 `ctx.authorization` 登录流（`dsh-llm-pi-ai` 已为 `openai-codex` 等订阅型 Provider 注册）的入口；本插件的 host half 把该登录能力暴露为同源 HTTP 接口（目录 / 发起 / 事件轮询 / 应答 / 取消），client half 用登录卡驱动。凭据形态与 API Key 不同：订阅授权是凭据记录（`kind: 'grant'`），route 不写 `apiKeyEnv`，请求时由宿主凭存储的授权签发令牌。

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

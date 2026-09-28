# dsh-models

DeepSeek Harness Web 插件：在 Settings 里新增独立的 **模型目录** 菜单，浏览 [models.dev](https://models.dev)
并把 Provider / 模型写入宿主的 `llm-pi-ai`，在面板上为每个模型设置**能力**（输入模态、上下文、输出上限）
与**推理强度**（`reasoningEfforts`）。生成内容严格遵循官方 `@deepseek-ai/dsh-llm-pi-ai` 配置格式。

## 功能

**设置菜单「模型目录」（`settings.section` id `dsh-models`）**

- **Provider 列表（行内编辑）**：只展示**已经配置过**的 route（组合配置或用户层写过 `providers.<route>`）：
  行头显示显示名、route id 与协议 / Endpoint；点击卡片展开连接字段和模型清单，切换卡片或收起时会确认放弃未保存的修改。
  内置 Provider 的模型清单以「显示名 + 模型 ID / 生效能力 / 思考档位」展示，不修改目录事实。
- **卡片编辑区**：编辑 Provider 字段（`displayName` / `api` / `baseURL` / API Key / 下拉选择可选的 `reasoning` 默认推理等级）与模型清单（新增 / 编辑 / 删除 / 拖拽排序，
  模型字段含 `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / 模型级 `compat`，
  全部有「继承」态）；保存即一次性整值写入用户层的**整个 `providers.<route>` 子树**。
- **新建 Provider（列表顶部行内卡片，两种方式）**：点「新建 Provider」在列表首行展开表单，失败时保留填写内容；
  「使用内置 Provider」从尚未配置的内置目录里选一个，只写 `displayName`（可选 API Key），协议、
  Endpoint 与模型目录全部继承安装目录；
  「自定义 Provider」填 Provider ID / 显示名 / API Key，Endpoint 可从 models.dev 的 Provider 里选择
  （自动带上协议），也可手动填写自定义地址；「获取模型」用 API Key 询问 Endpoint 的模型清单，
  并按 models.dev 元数据补全每个模型的能力。模型清单默认为空，不获取也可以直接创建。

**API Key**

面板内可直接设置：密钥经 `credentials.set` **只写**存储，`settings.yaml` 里只记录引用
（沿用 profile 已有的 `apiKeyEnv`，没有则派生 `<ROUTE>_API_KEY`）。面板不读取、缓存或回显密钥。

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
pnpm --filter dsh-models typecheck
pnpm --filter dsh-models build
pnpm --filter dsh-models test
```

数据同步架构、写入策略与字段映射等机制细节见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT

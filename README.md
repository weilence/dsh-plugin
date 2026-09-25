# dsh-plugins

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) web 插件集。
单仓多插件：一个 git 仓库、pnpm workspace 管理，各插件独立版本、独立发布到 npm。

## 插件

| 插件 | 功能 |
| --- | --- |
| [dsh-models](plugins/dsh-models) | 设置页「模型目录」：浏览 [models.dev](https://models.dev)、把 Provider / 模型导入 `llm-pi-ai`，编辑能力与推理强度；host 侧带 ETag 感知的目录镜像与只读生效能力桥 |
| [dsh-notify](plugins/dsh-notify) | 回合完成 / 提问 / 审批等待时弹系统桌面通知，前台浏览静默；desktop 窗口恢复桥 |
| [dsh-zhipu-tools](plugins/dsh-zhipu-tools) | 智谱 Coding Plan 工具集：挂载官方 MCP 搜索 / 读页工具；输入框状态栏展示 5 小时 / 7 天用量配额与重置倒计时 |

各插件的功能、安装与配置说明见其目录内 README。

## 仓库结构

```
├── plugins/            # 可发布插件（npm 包）
│   ├── dsh-models/
│   ├── dsh-notify/
│   └── dsh-zhipu-tools/
├── packages/
│   └── tsdown-config/  # @dsh-plugins/tsdown-config（私有）：DSH 插件共享构建工厂
├── pnpm-workspace.yaml # workspace + catalog（共享版本表）
└── tsconfig.base.json  # 各插件 tsconfig 的公共基座
```

- **版本集中**：`@deepseek-ai/*` 平台包与工具链版本集中在 `pnpm-workspace.yaml`
  的 catalog，各包以 `"catalog:"` 引用——升级 DSH 平台只改一处。
- **构建工厂**：各插件 `tsdown.config.ts` 只声明差异点（入口、externals、
  打包白名单），node / browser 双 half 产物与 CSS Modules 内联的公共逻辑在
  `@dsh-plugins/tsdown-config`。
- **产物约定**：每个插件构建出 `lib/index.js`（node half，ESM）与
  `lib/client.js`（browser half，宿主 ModuleLoader factory），`lib/` 不入库。

## 开发

```bash
pnpm install          # 安装依赖（workspace 全部包）
pnpm -r build         # 构建全部插件（或 pnpm --filter dsh-notify build）
pnpm -r typecheck     # 类型检查
pnpm -r test          # 运行测试
pnpm watch            # 并行 watch 全部插件（配合宿主热载入）
pnpm format           # prettier 格式化
```

Node >= 20；包管理器固定为 pnpm（`packageManager` 字段 + corepack）。

## 发布

一仓多包，标签带插件名前缀（见 `.github/workflows/publish.yml`）：

```bash
# 1. 改 plugins/<name>/package.json 的 version 并提交
# 2. 打标签：git tag <name>/vX.Y.Z   （如 dsh-zhipu-tools/v0.1.1）
git push origin develop --tags
# 3. CI 暂存发布（staged）→ npm stage list 查看
# 4. npm stage approve <stage-id> --otp 上线
```

## 从三个独立仓库迁移

本仓库由 `dsh-models`、`dsh-notify`、`dsh-zhipu-tools` 三个独立仓库经
`git subtree add` 合并而成（各插件完整提交历史保留在 `plugins/<name>/` 路径下，
`git log -- plugins/<name>` 可查）。

# dsh-plugins

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) web 插件集。
单仓多插件：一个 git 仓库、pnpm workspace 管理，各插件独立版本、独立发布到 npm。

包名统一 `@weilence/*` scoped（weilence.com 域名空间）；仓库目录保持无 scope 短名。

## 插件

| 插件                                       | 包名                        | 功能                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [dsh-mcp](plugins/dsh-mcp)                 | `@weilence/dsh-mcp`         | 设置页「MCP 管理」：浏览 profile / 全局两层 patch 声明的 MCP 服务器与运行态（工具清单、连接失败摘要），新建、编辑、启停、删除（注释保留的 YAML 往返，HMR 在线生效）                                   |
| [dsh-models](plugins/dsh-models)           | `@weilence/dsh-models`      | 设置页「模型目录」：浏览 [models.dev](https://models.dev)、把 Provider / 模型导入 `llm-pi-ai`，编辑能力与推理强度；host 侧带 ETag 感知的目录镜像与只读生效能力桥                                      |
| [dsh-notify](plugins/dsh-notify)           | `@weilence/dsh-notify`      | 回合完成 / 提问 / 审批等待时弹系统桌面通知，前台浏览静默；desktop 窗口恢复桥                                                                                                                          |
| [dsh-remote](plugins/dsh-remote)           | `@weilence/dsh-remote`      | 设置页「远程开发」：经 SSH 别名管理远端机上的完整 dsh web 实例——一键部署（tgz 推送安装，远端默认只装本插件）、连接（端口转发 + token URL 直开）、用户级 skills 同步、MCP 配置下发、本地插件同步到远端 |
| [dsh-skills](plugins/dsh-skills)           | `@weilence/dsh-skills`      | 设置页「Skills 管理」：浏览官方注册表合并的技能目录，对项目 / 用户的四个标准技能根新建、编辑、删除技能文件（frontmatter 行级往返，未知字段保留）                                                      |
| [dsh-zhipu-tools](plugins/dsh-zhipu-tools) | `@weilence/dsh-zhipu-tools` | 智谱 Coding Plan 工具集：挂载官方 MCP 搜索 / 读页工具；输入框状态栏展示 5 小时 / 7 天用量配额与重置倒计时                                                                                             |

各插件的功能、安装与配置说明见其目录内 README。

## 开发

```bash
pnpm install          # 安装依赖（workspace 全部包）
pnpm -r build         # 构建全部插件（或 pnpm --filter @weilence/dsh-notify build）
pnpm -r typecheck     # 类型检查
pnpm -r test          # 运行测试
pnpm watch            # 并行 watch 全部插件（配合宿主热载入）
pnpm format           # prettier 格式化
```

Node >= 20；包管理器固定为 pnpm（`packageManager` 字段 + corepack）。

仓库结构、双 half 架构与工程约定见 [AGENTS.md](AGENTS.md)。

## 发布

一仓多包，标签带 scoped 包名前缀（见 `.github/workflows/publish.yml`）：

```bash
# 1. 改 plugins/<目录>/package.json 的 version 并提交
# 2. 打标签：git tag @weilence/<目录>/vX.Y.Z   （如 @weilence/dsh-zhipu-tools/v0.2.0）
git push origin develop --tags
# 3. CI 暂存发布（staged）→ npm stage list 查看
# 4. npm stage approve <stage-id> --otp 上线
```

新 scope 各包 v0.1.0 首发需手动 `npm publish` 一次（见 workflow 注释）；旧裸名包保留在 registry，不再更新。

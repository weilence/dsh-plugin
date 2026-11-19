# 版本与发布陷阱

本文件承载版本协同与发布流程；强制约定（平台包 `catalog:` 一处升级、`engines.dsh` 字面 range、不声明 peers）见根 AGENTS.md「强制约定」。

- 宿主 0.2.1 起 app-boot 兼容性预检只认 `engines.dsh`（声明即忽略 peers，未声明才回退 peers 判定），无效 range 会被判为不兼容——字面 range、不声明 peers 的规则即源于此。平台包运行期由宿主解析供给，link 开发安装的解析正确性靠 catalog 与宿主版本对齐。
- 平台包必须同版本协同——升级 DSH 平台只改 `pnpm-workspace.yaml` 的 catalog 一处（`catalog:` 引用规则见根「强制约定」）；第三方库不进 catalog，由使用的插件自行声明。
- 发布：改插件 version → `git tag @weilence/<目录>/vX.Y.Z` → push；CI 暂存发布后 `npm stage approve` 上线（`.github/workflows/publish.yml`）。新 scope 各包首发需手动 `npm publish` 一次。

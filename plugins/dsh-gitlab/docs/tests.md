# dsh-gitlab 测试地图

本文件承载测试覆盖与运行方式；全仓测试分层约定见根 `docs/testing.md`。用户凭据不进任何测试。

## 运行

```sh
pnpm --filter @weilence/dsh-gitlab test                # 单测（CI 四项检查覆盖）
pnpm --filter @weilence/dsh-gitlab test:integration    # 集成测试（手动，真 spawn glab stub）
```

## 单测（test/unit/）

- `glab.test.ts`：`glabCandidates` 候选顺序与去重（显式配置 / 惯例位置 / PATH / 裸名兜底）、`BoundedCapture` 头尾 / 截断边界（恰好填满不标截断）、`displayCommand` 引号化。
- `sites.test.ts`：站点草稿校验与 `normalizeSites` 降级（非法行不炸整表、重名 / 多 default 处理）、`chooseSite` 选站顺序、`workspaceMatches` 路径边界与大小写、`hostOf`。
- `tools.test.ts`：tools execute（假 run 替身断言 env 注入 / argv / cwd / 超时钳制）与产物 schema 形状走查器（宿主管道强校验）。
- `host.test.ts`：五路由假 ctx 全链路（sites / cwd / save / delete / test）+ 信任边界（跨站 / 非期望 Host 拒绝）+ 注入 seam 生效（runGlab / glab 替身）。
- `store.test.ts`：面板 store 状态机（mock api）——refresh / save / remove / test 的成功与失败分支、`NoticeRelay` 通道（有订阅者投递、无订阅者丢弃）、workspaceCwd 去重。

## 集成测试（test/integration/）

`glab.integration.test.ts`：临时目录写可执行 stub 脚本真 spawn——env 注入（脚本回显 GITLAB_HOST）、argv 透传、cwd 生效、超时终止、超长输出截断、ENOENT 报错；`testSite` 全链路（成功解析 username / 非 0 退出码原样回传）。

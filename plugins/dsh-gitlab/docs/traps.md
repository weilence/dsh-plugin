# dsh-gitlab 陷阱与易错点

本文件承载实证事实、易错点与禁止事项；行为规格见 [docs/spec.md](spec.md)，取舍理由见 [docs/decisions.md](decisions.md)。

## spawn 与输出捕获

- **超时与取消语义分离**：`timeoutSec` 到点返回已捕获产物（`timedOut: true`，模型可重试）；调用方 `exec.signal` 取消必须原样抛 `signal.reason`——包成普通 Error 会破坏宿主管道的 ABORTED 语义。
- `BoundedCapture` 的 head 填满后同 chunk 余量必须进 tail（实现里先切片再判空）；truncated 判定是 `total > head + tail`，恰好填满不标截断。
- chunk 边界可能切开多字节字符：StringDecoder 跨 chunk 拼接（残留 ≤3 字节）；产物收尾要拼 `decoder.end()` 的残留。
- shell 型命令会留下继承管道写端的孤儿子进程（如 `sh -c 'sleep …'`）：只 kill 主进程不够，close 要等 stdio 全关——超时 / 取消路径在 SIGKILL 后主动销毁 stdout / stderr 流让 close 立即可达。
- spawn ENOENT 走 child `error` 事件（不是 throw）：`runGlab` 已归一为带路径的错误消息，调用方不必再处理。
- 超时定时器与进程退出存在边界竞争：`child.exitCode` / `signalCode` 已落定就不标 timedOut。

## glab 二进制解析

- 宿主是 GUI 进程，PATH 常不含 homebrew：候选顺序是显式 `glabPath` → 平台惯例位置（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`）→ PATH 逐目录 → 裸命令名兜底；惯例位置与用户配置是主路径，裸命令名只是兜底（交给 spawn 按 PATH 解析，跳过存在性检查）。
- 候选必须有序去重：显式配置可能与惯例位置相同路径。
- Windows 候选后缀是 `glab.exe`。

## glab 行为面

- `glab api user` 成功但 stdout 非 JSON（用户 glab 被包装脚本劫持等）时测试探测返回 ok +「无法解析用户名」，不判失败——探测只回答「认证通不通」。
- glab 未认证时工具原样返回其报错：认证是用户自己的登录态，插件不代管、不引导自动修复。
- 版本探测超时 5s：慢盘 / 冷启动下 `--version` 也可能超时，失败保留路径并展示原文（面板显示「版本探测失败」而非「未找到」）。

## 宿主管道与 wire

- 产物经一次 JSON 往返剔除 undefined（lossless JSON 要求）；字段值不得含 undefined。
- 工作区关联的 cwd 依赖 Web 客户端上报（宿主刚启动、客户端未连时自动跳过工作区匹配，回落默认 / 唯一站点），勿改成猜进程 cwd；Windows 路径比较忽略大小写。
- 站点行 config 可能被两层用户 patch 直接编辑：读取统一走 `normalizeSites` 降级，写回经 `validateSiteDraft` 全量校验，绝不假设存量行合法。

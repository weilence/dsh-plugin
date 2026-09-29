# @weilence/dsh-remote

DSH web 插件（远程开发）：设置页新增「远程开发」菜单——把一台远端机变成完整
的开发机：工作区、Bash、终端、LSP、MCP server 全在远端执行，本地只出浏览器。

经你自备的 OpenSSH 别名（认证完全复用 `~/.ssh/config`，本插件不读写任何私钥
材料）管理远端机上的完整 dsh web 实例：

- **连接**（内含远端装配）：探针 node / npm / pnpm（缺失时尝试 `corepack enable`）→
  `npm install -g @deepseek-ai/dsh`（版本对齐本机运行时；本机版本探测失败时
  直接中止装配，不退装 npm latest）→ 安装本插件：先对比远端已装版本与
  profile 登记，一致则跳过；不一致才本地组装 tgz（npm tarball 布局）经 ssh
  推到远端 `~/.dsh/dsh-remote/payload/` 并 `dsh plugin add <tgz>` 安装，装毕读回
  node_modules 里的版本确认。裸包名 `dsh-remote` 在 npm 已被第三方包占用，
  本插件走 `@weilence/*` scope 且不依赖 registry。装配完成后续起实例：远端
  `nohup dsh --profile web --no-open --port 0`（profile 固定 web，不可配置），
  轮询日志里的 `dsh web: <url>` 就绪信号解析端口与 token，本地 `ssh -N -L`
  端口转发 + 健康检查后打开 `http://127.0.0.1:<local>/?token=…`——鉴权、
  loopback 栅栏对转发端口照常工作。已装齐时装配段秒过。
- **断开**：杀本地转发 + 远端 SIGTERM（官方语义 = 优雅退出）。
- **同步**（skills / MCP / 插件三类，均为声明式勾选）：运行态卡片上的
  「同步 ▾」下拉选类别，弹窗列表 = 本机清单、默认勾选 = 远端已有（打开时
  实时读取远端清单），确认后勾选项安装 / 升级，未勾选且远端已有的删除——
  删除范围恒为本机清单 ∩ 远端清单，远端独有条目（本机没有的）零接触。
  远端清单读取失败时禁用同步按钮：没有远端事实绝不执行删除。连接路径
  不做任何同步；写入靠远端实例 HMR 在线生效。
  - **skills**：两个用户级根（`~/.dsh/skills`、`~/.agents/skills`）按勾选 tar
    单向推送。
  - **MCP**：勾选的本机 MCP 服务器声明（含 env 凭据，面板明示）整块合并进
    远端 profile 的 `cordis.patch.yml`（按 serverName 对齐）——cat→改→cat
    原子往返，手写注释与无关行原样保留。
  - **插件**：逐插件版本对比后分流——本地路径安装（link / file）的插件永远
    本地打包传输（未发布的开发版本也能同步到远端）；npm 依赖形态的插件按
    弹窗选项选本地传输或远端自行下载（精确对齐本机版本）。

同步能力全部收敛在本插件面板里——dsh-skills / dsh-mcp 保持纯本地管理插件，
不感知远端，功能各自独立。

## 前置条件

- 本机 `ssh`（Windows 10+ 自带 OpenSSH 客户端）与 `tar`（bsdtar）；面板缺失时
  会置顶告警并禁用相应操作。
- `~/.ssh/config` 里配好可免密登录（agent / 密钥）的远端别名——BatchMode 下无
  法交互输密码。
- 远端 Linux/macOS + Node ≥ 22.19（部署会检查并给出指引，不代装 Node）。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-remote
```

（或手动把 `@weilence/dsh-remote` 加入 profile 的 `dsh.profile.bundles`。）

## 行为边界

- 远端产物固定三处：`~/.dsh/dsh-remote/`（实例日志、pid 与插件 tgz payload）、
  `~/.dsh/profiles/<name>/`（插件安装与 patch 写入）、两个用户级 skills 根。
- 删除连接只删本机记录；远端产物保留。
- 远端实例重启后 token 必换，旧 URL 失效（浏览器 cookie 仍有效）。
- stdout 的 `dsh web:` 行是唯一机器可读就绪信号，格式无版本契约——解析失败时
  面板回显远端日志尾部供人工判读。

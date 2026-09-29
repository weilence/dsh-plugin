# @weilence/dsh-remote

DSH web 插件：设置页新增「远程开发」菜单——把一台远端机变成完整的开发机：工作区、Bash、终端、LSP、MCP server 全在远端执行，本地只保留浏览器界面。

通过自行配置的 OpenSSH 别名（认证完全复用 `~/.ssh/config`，本插件不读写任何私钥文件）管理远端机上的完整 dsh web 实例：

- **连接**（内含远端部署）：探测 node / npm / pnpm（缺失时尝试 `corepack enable`）→ `npm install -g @deepseek-ai/dsh`（版本对齐本机运行时；本机版本探测失败时直接中止部署，不回退安装 npm latest）→ 安装本插件：先对比远端已装版本与 profile 登记，一致则跳过；不一致才本地组装 tgz（npm tarball 布局）经 ssh 推到远端 `~/.dsh/dsh-remote/payload/` 并 `dsh plugin add <tgz>` 安装，随后读回 node_modules 里的版本确认。无 scope 的包名 `dsh-remote` 在 npm 已被第三方包占用，本插件走 `@weilence/*` scope 且不依赖 registry。部署完成后启动实例：远端 `nohup dsh --profile web --no-open --port 0`（profile 固定 web，不可配置），轮询日志里的 `dsh web: <url>` 就绪信号解析端口与 token，本地 `ssh -N -L` 端口转发 + 健康检查后打开 `http://127.0.0.1:<local>/?token=…`——鉴权、loopback 校验对转发端口照常工作。已装齐时部署段立即完成。
- **断开**：结束本地转发，并向远端发 SIGTERM（官方语义为优雅退出）。
- **同步**（skills / MCP / 插件三类，**只往远端新增 / 覆盖，永不删除远端内容**）：连接卡片上的「同步 ▾」下拉选类别（无需先连接：skills / MCP 只需 ssh 可达；未连接时同步插件会先弹出「连接远端」引导弹窗），弹窗实时读取远端清单并与本机逐条比对：列表 = 本机清单，差异 / 新增 / 无法比对项默认不勾选（勾选才同步），已一致项默认隐藏（「隐藏已一致」开关可展开，展开后锁定勾选——同步它们本来就是 no-op）；确认后勾选项安装 / 升级（与本机一致的自动跳过），未勾选与远端独有条目不受影响。远端清单读取失败时按「无法比对」降级展示，仍可同步（无删除风险）；要清理远端内容，用远端实例自己的 skills / MCP 管理面板。连接过程不做任何同步；写入的内容在实例在线时通过 HMR 生效，实例未运行时在下次启动时生效。
  - **skills**：两个用户级根（`~/.dsh/skills`、`~/.agents/skills`）按内容指纹（全部文件的 sha256 折叠，隐藏文件不计）比对，差异技能 tar 单向推送。
  - **MCP**：勾选的本机 MCP 服务器声明（含 env 凭据，面板明示）按生效配置签名比对，差异行整块合并进远端 profile 的 `cordis.patch.yml`（按 serverName 对齐，远端手写行被覆盖时替换为本机行）——cat→改→cat 的原子 round-trip，手写注释与无关行原样保留；全部一致则不写盘。
  - **插件**：逐插件比对「远端激活状态 + 已装版本」后分流——本地路径安装（link / file）的插件永远本地打包传输（未发布的开发版本也能同步到远端）；npm 依赖形态的插件按弹窗选项选本地传输或远端自行下载（精确对齐本机版本）。

同步能力全部集中在本插件面板里——dsh-skills / dsh-mcp 保持纯本地管理插件，不感知远端，功能各自独立。

## 前置条件

- 本机 `ssh`（Windows 10+ 自带 OpenSSH 客户端）与 `tar`（bsdtar）；缺失时面板顶部告警并禁用相应操作。
- `~/.ssh/config` 里配好可免密登录（agent / 密钥）的远端别名——BatchMode 下无法交互输密码。
- 远端 Linux/macOS + Node ≥ 22.19（部署时检查并给出指引，不代为安装 Node）。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-remote
```

（或手动把 `@weilence/dsh-remote` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`。）安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可。

## 行为边界

- 远端产物固定三处：`~/.dsh/dsh-remote/`（实例日志、pid 与插件 tgz payload）、`~/.dsh/profiles/<name>/`（插件安装与 patch 写入）、两个用户级 skills 根。
- 删除连接只删本机记录；远端产物保留。
- 远端实例重启后 token 必换，旧 URL 失效（浏览器 cookie 仍有效）。
- stdout 的 `dsh web:` 行是唯一机器可读就绪信号，格式无版本契约——解析失败时面板回显远端日志尾部供人工判读。

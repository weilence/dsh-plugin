# dsh-remote 环境同步

本文件承载四类同步（skills / MCP / 插件 / 系统提示词）：同步语义与入口、比对判据、远端清单读取、写目标与生效时机、同步相关面板交互，以及陷阱与已确认决策。环境同步能力集中在本插件面板——dsh-skills / dsh-mcp / dsh-prompts 保持纯本地管理插件、不感知远端；部署与版本治理见 [deploy.md](deploy.md)，连接与隧道见 [connection.md](connection.md)，面板交互总览见 [panel.md](panel.md)。

## 结构

- `src/index.ts`：同步相关路由——`POST /sync`、`POST /remote-inventory`（远端清单）、`GET /local-rows`。
- `src/engine.ts`：同步流程（弹窗远端事实判定出徽标 + 提交即执行，见「已确认决策」）。
- `src/patchDoc.ts`：本机两层 patch 的层扫描（insert 行读取），供插件同步清单（两层用户 patch 语义见[根 docs/patch.md](../../../docs/patch.md)「两层用户 patch 约定」）。
- `src/localenv.ts`：本机清单只读扫描——skills 两根扫描（含 `foldSkillDigest` 内容指纹折叠，远端 find|sha256 输出共用同一折叠）、全局 mcp.json 条目扫描（`readLocalMcp`，条目对象规范化 JSON 签名）、插件行（patch insert 行 ∪ 层 package.json `dsh.profile.bundles` 激活清单——link 安装的主要登记处，`@deepseek-ai/*` 平台包过滤；行含安装形态与包定位：dependencies 的 link:/file: spec 为本地且 spec 目标即包根、registry 行定位到层内 node_modules 实体、行带本机包版本）、系统提示词行 `scanSystemPrompt`（profileContext.home 下的 system-prompt.md，与 dsh-prompts 同一文件）——全部只读。

## 同步语义（skills / MCP / 插件 / 系统提示词）

- 四类同步一律手动触发（卡片行「同步 ▾」下拉选类别 → 弹窗勾选 → 确认），连接过程不执行任何同步动作；同步入口在所有阶段常驻（入口常驻是[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」的通则）——skills / MCP / 提示词仅需 ssh 可达，插件安装依赖连接部署出的远端 dsh，未连接时点「同步插件」先弹「连接远端」引导弹窗（确认后立即关窗并发起连接，进度由卡片 spinner 呈现，连接完成后用户重新点一次菜单）。
- 同步语义 = **只往远端新增/覆盖，永不删除远端内容**（拍板记录见「已确认决策」）——勾选 = 安装/覆盖，未勾选 = 不动，远端独有条目（本机没有的）不受影响；勾选项随 `POST /sync` 直接提交（`{id, kind, names, registryPluginInstall?}`），不持久化在连接上、无中间保存步骤。
- 条目级「一致」判定双端同函数（shared.ts 的 `skillStatus` / `mcpStatus` / `pluginStatus` / `promptStatus`，弹窗徽标用）：skills 比内容指纹（本机 walk 与远端 `find|sha256` 管线共用 `localenv.foldSkillDigest` 折叠；隐藏路径段两侧同样跳过，目录包与 `<name>.md` 单文件取并集；刻意不比 mtime/mode，见「已确认决策」）；MCP 比生效配置签名（`canonicalJson` 递归键序无关，disabled 入签）；插件比「bundles 激活 + 版本号」（npm 语义：版本即内容契约，本地打包传输与远端 npm 下载同判；远端一条 `node -e` 批量读版本；同版本换内容不可见）；提示词比单文件内容 sha256（本机 `scanSystemPrompt`，远端 sha256sum/shasum 单文件管线，文件缺失打 `__ABSENT__` 哨兵）。
- 弹窗打开时 `POST /remote-inventory` 取远端事实逐条判定。远端清单读取：skills 两根 `find . -type f ! -path '*/.*' | xargs -0 sha256sum`（sha256sum / shasum 择一，hasher 缺失打 `__DSH_NO_HASHER__` 哨兵）；MCP 全局档条目按名取签名（结构坏该类 null）；插件取 bundles + `node -e` 批量读版本；提示词单文件 sha256。解析失败按该类 null 降级——弹窗按「无法比对」徽标渲染但不阻断同步；ssh 连接级失败原样抛。
- 弹窗默认值：非 same 项默认不勾选（打开看到的是待决策清单），same 项也默认不勾、可勾选——**勾选已一致项 = 强制重推**；「隐藏已一致」Switch（默认开）只影响显示，「全选」只作用当前可见行。
- 引擎提交即执行、不重读远端事实重判（弹窗判定就是事实源，见「已确认决策」）：勾选项全量推送 / 写入 / 安装，无「一致跳过」分支，lastSync 只报处理量；同步完成（或失败）由 store 的 op 迁移检测发 toast 摘要；同步失败而连接仍在 running 时保留错误摘要行 + 「查看完整」机制。
- 写目标与推送形态：skills 差异 tar 单向推送；插件激活写远端 profile package.json 的 `dsh.profile.bundles`（不是 patch 行）；MCP 合并写远端 `~/.dsh/mcp.json`（条目名即 serverName：只新增/覆盖，远端独有条目与顶层其他键不动，Map 原位覆盖保键序；迁移决策见「已确认决策」）；提示词以 tmp+mv 原子写远端 `~/.dsh/system-prompt.md`（与 dsh-prompts 面板管理同一文件，远端需装 dsh-prompts 才注册进系统提示词组装；dsh-prompts 配置单独覆写 dshHome 时本插件读不到该覆写——插件配置宿主不公开）；工作区档（`<cwd>/.mcp.json`）是目录特定，不参与跨机同步，远端 dsh-mcp 面板可无缝接手。
- 插件分流：本地路径安装（link / file）恒本地打包传输（未发布的开发版本也能到达远端）；registry 插件按请求选项 `registryPluginInstall` 选「本地传输」或「远端 npm 下载（`add name@本机version`）」；package.json 的 `file:` spec 持续引用当前 tgz（pnpm 后续任何 add/install 都会重读全部 file: 依赖），装成功后只清同包**其他版本**的 payload 文件、当前文件必须保留（缘由见 [deploy.md](deploy.md)「陷阱」）；manifest（`dsh-remote.json` 内）只是最近一次同步的记录，不驱动任何判定。
- 生效时机：远端 web 实例的配置 HMR 常开（base 组合包的 hmr 行只在无 profileContext 时禁用，web 模板不覆盖；headless / sdk / acp 等 stdio 一次性应用才显式禁用）——dsh-hmr 监听 profile package.json（bundles 清单变化重整 loader 树）与两层 cordis.patch.yml，MCP 同步写的 mcp.json 由远端 dsh-mcp 的文件 watcher 在线跟进；模块级热替换（root）默认关且与同步无关——同步写入的生效不经过实例重启（实例未运行时在下次启动生效），keep-instance 断开语义与 HMR 无耦合。

## 同步面板交互

- SyncDialog：选类别后打开该类清单（列表 = 本机清单，远端事实逐条判定出徽标——same 是行尾 ok 徽标、醒目于普通元信息，其余三态是状态文字；非 same 默认不勾选，same 项默认不勾、可自由勾选 = 强制重推），工具行左侧「全选」勾选框只作用当前可见行、右侧「隐藏已一致」是官方 Switch（默认开、只影响显示不改变提交集），确认即随 `POST /sync` 直接提交勾选项（无中间保存）。

## 陷阱（同步与比对）

- 同步的比对值在任一侧读不到（本机包定位失败 / 远端管道失败 / 远端 mcp.json 结构错误）时保守按不同处理——tgz 推送与 patch 写入幂等，宁可重推不可漏装。远端哈希管线按 `hash  path` 行解析（sha256sum / shasum 同形态），路径含换行等畸形文件名会解析失败、走保守分支——官方发现层（ls -1）同样受限。
- MCP 合并遇远端 mcp.json 结构坏（解析失败）时显式中止，不盲覆盖——盲覆盖会毁掉手写的其余条目；条目级签名（canonicalJson 全条目）使 disabled 与未知键的变化都判为 diff。
- 本机（及插件同步清单）对「本插件自身」的排除要同时匹配 `@weilence/dsh-remote` 与改名前的无 scope 包名 `dsh-remote`——本机 link 安装在改名重装前的过渡期仍保留旧名行，漏排会把自身当业务插件同步出去。

## 已确认决策（同步）

以下为已拍板的行为决策及理由。

- 同步语义 = 只往远端新增/覆盖，永不删除远端内容：勾选 = 安装/覆盖、未勾选 = 不动，远端独有条目不受影响，要清理远端用远端实例自己的 dsh-skills / dsh-mcp 面板；历史上的「先 save 后 sync」两步协议、`connection.sync` 字段、`kind=all` 与「未勾选=删除」的声明式语义均已删除。
- 四类同步一律手动触发，连接过程不执行任何同步动作。
- 引擎提交即执行、不重读远端事实重判：弹窗打开时的逐条判定就是事实源，无「一致跳过」分支，lastSync 只报处理量。
- MCP 同步改合并写远端 `~/.dsh/mcp.json`，不再写 patch：工作区档（`<cwd>/.mcp.json`）目录特定、不参与跨机同步，远端 dsh-mcp 面板可无缝接手。
- Skills 指纹刻意不比 mtime/mode，只比内容（双端共用 `foldSkillDigest` 折叠）。

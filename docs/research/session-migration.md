# DSH 会话迁移：官方归档格式、插件边界与跨机续接方案

本文面向需要备份会话或在另一台机器继续工作的使用者与插件维护者。结论以第一方源码和本仓已写实现为准，不把设计建议当成现网验证结果。

## 结论先行

- **右上角 download 下载的是完整会话 ZIP，不是 Markdown 对话导出。**归档含根会话、子代理后代的完整持久化事件日志及日志引用的图片、文件附件；没有 manifest。日志保留 LLM 上下文相关的消息、指令、工具调用与结果、请求记录、压缩记录等事件，而不是仅保留界面可见的聊天文本。[下载入口][host-download] · [下载参数][host-controller] · [事件词汇][host-events]
- **可以复用官方归档格式，但不能直接复制持久化目录或索引来实现导入。**本仓 `dsh-sessions` 复用官方 ZIP 条目生成器，以正式 format catalog 做 `strict` / `current` 恢复验证，再通过 `SessionPersistence.create` → `append` → `flush` → `close` 写入目标后端。[当前归档实现][plugin-archive] · [catalog 契约][host-catalog] · [持久化契约][host-persistence]
- **当前插件是人工快照迁移，不是双向自动增量同步。**导入保留 ID，只映射 `header.cwd`；目标会话不存在才创建，内容一致则跳过，内容不同则拒绝，不自动激活会话。远端传输只把已确认的快照送到已连接实例。[当前归档实现][plugin-archive] · [当前面板流程][plugin-client]
- **持续跨机工作优先采用单一远端实例。**两台机器连接同一实例、同一会话，由远端作为唯一写入点，无需合并两份日志。断线离线工作则采用人工快照移交，停止源端后再继续目标端；真双向持续同步需要另外设计单写入者、前缀比较和分叉冲突协议，当前插件不提供这些机制。此项是基于官方单写入者契约的架构建议。[写入所有权][host-persistence] · [现有 TCP 隧道][remote-forward]

## 1. 调查范围与验证状态

第一方调查依据为本机 `D:\Code\deepseek-harness` 的只读源码，`git rev-parse HEAD` 得到 `639ed015397290b3745d163aafe02ffee4aa3f84`，`origin` 指向 `deepseek-ai/deepseek-harness`；调查时该 checkout 的 `git status --short` 无输出。下文官方来源采用这一 commit 的 GitHub 源码行号链接，链接标识源码位置，不表示曾经通过线上接口验证。

本仓来源为工作区内的 [会话归档实现][plugin-archive]、[会话接收路由][plugin-host]、[会话面板][plugin-client]及 [dsh-remote 传输实现][remote-transport]。这些文件属于正在收尾的本地实现，不是已发布版本的兼容性承诺；本仓链接指向当前文件，避免并行格式化导致行号失效。

预期安装 checkout `C:\Users\weile\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh` 的 `Test-Path` 结果为 `False`。**未验证当前 GUI 的安装形态、实际宿主版本、已加载插件或真实跨机传输**；本文没有打开当前 GUI 做导出／导入，也没有使用真实 SSH 凭据做端到端迁移。测试文件只能证明仓库有相应测试设计，不能替代本次运行结果；README 与全量验证由主代理负责。

## 2. 官方 download 实际包含什么

### 归档结构

官方浏览器插件在会话 Header 的 utilities 槽位注册 download 菜单；控制器固定携带 `includeDescendants=true`，因此该入口不是只下载根会话。[菜单实现][host-download] · [槽位注册][host-download-slot] · [下载参数][host-controller]

当前格式版本是 V4。官方导出依次生成以下条目，并对共享附件去重；没有额外 manifest。[格式版本][host-header] · [归档条目][host-export-entries] · [附件路径][host-export-paths]

```text
session.v4.jsonl
subagents/<safeid>/session.v4.jsonl
media/sha256:<digest>.<ext>
files/<prefix>/<digest>/<name>
```

- 根日志位于 ZIP 根目录；子代理后代日志以 `safeid` 为目录名，非 `A-Za-z0-9_-` 字符替换为 `_`。这不是新的会话 ID，原 ID 仍在日志 header 内。[安全目录名][host-export-safeid] · [后代导出][host-export-entries]
- 图片路径保留 `sha256:` 前缀，扩展名对应 `png`、`jpg`、`webp` 或 `gif`。文件路径的 `prefix` 为十六进制 digest 的前两位；`name` 会净化路径分隔符和控制字符，空名或点目录名使用 `file`。[附件路径][host-export-paths]
- JSONL 第一行是会话 header，随后每行是一条完整已验证事件。导出从 persistence 的逻辑读句柄读取，不复制 JSONL／SQLite 后端的物理文件，因此不同后端可以导出相同逻辑格式。[日志序列化与读取][host-export-log]

### 「完整上下文」的准确含义

这里的「完整」指导出读取时该会话完整的已提交事件日志，不是仅导出当前压缩后的消息视图。V4 事件词汇包括 `system/message`、`developer/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`、`compaction/*`、权限和 inbox 等记录；因此归档含完整 LLM 日志及重建上下文所需的事件，但不是每次 HTTP 请求的独立抓包，也不是整个操作系统运行状态。[事件词汇][host-events] · [完整逻辑日志读取][host-export-log]

活跃会话在读日志前经过官方 flush 屏障。根与每个后代分别 flush、分别读取，**不是整棵会话树同一时刻的原子快照**；导出期间仍有写入时，各日志可能停在不同观察点。用于交接时应先让根与子会话停止推进，并确认浏览器下载完整。[根准备][host-export-root] · [逐后代读取][host-export-entries]

## 3. 当前插件如何恢复，哪些情况会拒绝

### 正式验证与存储接入

`dsh-sessions` 不自定义另一套 manifest，也不把归档解压到宿主内部目录。它解析 ZIP，验证路径、重复条目、CRC、展开大小、会话谱系及附件引用；日志走 `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`，随后做存储事件验证和 `Session.fromRestore` 验证。[归档验证][plugin-archive] · [catalog 选项][host-catalog] · [当前格式验证][host-current-validation]

**catalog 具备历史格式迁移能力，不等于当前插件支持任意历史 ZIP。**当前实现要求根条目为 `session.v4.jsonl`，header 版本等于安装包的 `SESSION_FORMAT_VERSION`，只接收当前 V4 归档；未知或不满足当前语义的必需事件不能静默丢弃。若日志来自其他版本，应先由兼容的官方宿主读取并重新导出，再验证目标插件是否支持。[当前归档实现][plugin-archive] · [版本分派与恢复][host-catalog-dispatch] · [未知事件兼容规则][host-events]

所有日志、引用附件和目标目录完成验证后，导入才开始写入。新会话使用官方 persistence 的 `create`，携带继承前缀长度，再 `append`、`flush`，在结束前关闭句柄，并保留写入和关闭的实际错误。`append` 只是接受有序追加；`flush` 才是持久化屏障，`close` 释放写入所有权。不能用拷贝持久化文件、SQLite、查询索引或投影缓存替代这些契约。[当前导入实现][plugin-archive] · [句柄持久化保证][host-handle] · [创建与所有权][host-persistence]

### 目标目录、身份与冲突策略

| 项目       | 当前行为                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 目标目录   | 必须显式填写目标机器上已存在的绝对目录；整份归档的 `header.cwd` 映射为这一目录。                     |
| 历史内容   | 保留事件、会话 ID、父子关系和继承前缀，不重写历史消息、工具参数及文本中的旧绝对路径。                |
| 目标不存在 | 以原 ID 创建冷存储会话。                                                                             |
| `same`     | 映射后的 header、继承前缀和事件规范化摘要一致，跳过日志写入；不是只比较 ID 或 ZIP 字节。             |
| `conflict` | 面板标为 `conflict`；同 ID 内容不同则拒绝整批导入的预检查，不覆盖、不拼接。                          |
| 目标已激活 | 只要在 `ctx.sessions` 中存在，就拒绝预览／导入；不只是拒绝正在生成响应的会话。                       |
| 工作区     | 创建或取得目标 workspace，并关联非 `origin: 'subagent'` 的会话；子代理日志不作为独立主会话挂入列表。 |
| 激活       | 只写 persistence 和 workspace；不会创建 agent、打开会话或自动继续执行。                              |

以上行为均来自 [当前归档实现][plugin-archive]；官方 workspace 会检查关联会话的存储 header 与目录是否匹配。[workspace 关联校验][host-workspace]

预览返回归档摘要、目标目录和每个目标 ID 的读取摘要；确认时必须匹配这些事实，提交前和逐会话创建前重新检查。归档、目标内容或目录发生变化，需要重新预览；官方 `create` 的已存在拒绝是最后一道防覆盖保护。路由内的导入互斥只是本插件实例内的保护，不是跨机器的 owner 协议。[预览与导入][plugin-archive] · [接收路由][plugin-host] · [官方创建语义][host-persistence]

### 附件可能阻断导入，失败不等于回滚

图片保存必须走官方 `attachments.saveImage`，文件走 `saveFileStream`。官方本地图片 provider 会根据策略规范化图片，可能缩放、转码或去掉元数据；附件 ID 是规范化后字节的 SHA-256，因此不能假设目标 `saveImage` 必然返回原引用。[图片规范化][host-normalization] · [图片引用生成][host-image-ref]

当前插件比较保存后的附件身份；若 digest、字节长度或关键元数据不同，就**明确失败，并且不写会话日志**，不会偷偷把新附件 ID 填回历史事件。这避免日志引用与附件不一致，但意味着某些官方 ZIP 在目标附件策略不同的环境中也可能无法导入。[附件验证与保存][plugin-archive]

导入没有整棵会话树事务或自动回滚。失败前可能已创建 workspace、保存附件或完整写入部分会话；失败结果区分 `imported`、`skipped`、`incomplete` 并保留真实原因。重新预览可识别已完整写入的 `same` 项，但部分日志可能成为冲突，不能宣称「重试就会自动修复」或盲目重复提交。[部分结果实现][plugin-archive] · [部分失败测试设计][plugin-tests]

当前限制包括 ZIP 64 MiB、展开总量 256 MiB、单日志 16 MiB、最多 4,096 个条目、256 个会话，每份日志最多 100,000 条事件；不支持 ZIP64、多盘、加密或符号链接条目，也拒绝未知或未被引用的条目。这是**插件限制**，不能反推官方 download 也有同样的限额。当前面板与 host 以 Base64 JSON 搬运档案，并非官方浏览器下载的流式大文件通道。[限额定义][plugin-shared] · [ZIP 处理][plugin-archive] · [面板传输][plugin-client]

## 4. 远端传输复用什么，安全边界在哪里

`dsh-remote` 只创建一个 engine，并把同一个 engine 交给 `RemoteTransportService` 和原有连接路由。连接通过 OpenSSH 的 `ssh -N -L` 把本机 loopback 端口转发到远端 loopback Web 实例；会话插件不另起 SSH 连接管理器。[服务接线][remote-host] · [TCP 隧道][remote-forward] · [传输服务][remote-transport]

传输流程是：从 engine 的已连接事实取得隧道根 URL → 用 `GET /?token=...` 换取 authority 绑定 Cookie → 向目标会话接口发受限 POST。官方 browser-auth 只在有效根 GET token 时签发 Cookie，并以 `303` 跳转到 `./`；token 本身不是可直接携带到任意 API 的授权头。[官方 token 交换][host-browser-auth] · [当前交换流程][remote-transport]

dsh-remote 的状态和操作路由统一通过宿主认证，未登录请求不能读取含远端启动 token 的状态。当前传输只允许 `/dsh-sessions/preview`、`/dsh-sessions/import` 两个远端 POST，不接受任意目标 URL、路径或方法，不开放通用 HTTP proxy。请求带 Cookie、对应 Origin 和 `x-dsh-sessions: 1`；接收端仍先调用宿主 `connection.requestRejection`，再验证方法、请求来源和协议 header。loopback 或协议 header **都不能替代宿主认证**。[受限传输][remote-transport] · [接收端校验][plugin-host] · [宿主认证栅栏][host-request-rejection]

Cookie 只驻留在单次传输内，不持久化，不跟随认证或 POST 的跳转；传输还有限时、请求／响应大小限制和连接身份变化检查。导入 POST 后超时、断连或结果不明时，操作可能已经提交，必须重新预览确认，不能直接重试。[传输失败处理][remote-transport]

两端必须启用兼容的 `dsh-sessions`，本机还需启用提供传输服务的新版 `dsh-remote` 并连接目标。当前面板的远端动作是**本机向远端人工推送完整快照**，没有远端日志拉取、后台监听、双向增量合并或自动切换活动会话；返程可在源实例导出 ZIP，人工交给目标实例恢复。[当前路由][plugin-host] · [当前面板][plugin-client]

## 5. 不能把会话 ZIP 当成完整环境备份

| 不包含的内容                           | 原因及后果                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 项目文件、依赖及工具环境               | 官方只枚举日志和引用附件，不打包 `cwd` 目录；目标应另行准备项目、依赖、skills、MCP、插件、模型与凭据。  |
| 外部 deliverables 的文件内容           | `deliverables/presented` 保存的是路径和描述；没有自动变成附件。卡片或历史链接还在，不代表目标文件存在。 |
| Git 私有 checkpoint 的对象与索引       | `workspace/changes` 等历史事件不包含私有 Git 对象库；只复制项目或日志不能保证历史文件差异可恢复。       |
| 定时任务的宿主存储                     | `schedule/change` 历史事件可以在日志中，但实际调度任务保存在独立的宿主级 domain；插件不迁移这一存储。   |
| 运行进程、后台 job、SSH 隧道和运行句柄 | 日志可以保留调用及结果记录，但不迁移进程或进程内 job registry；目标不能延续源机器进程。                 |

来源：[官方条目枚举][host-export-entries] · [deliverables 路径记录][host-present] · [Git 私有快照][host-git-snapshot] · [定时任务存储][host-schedule] · [进程内 job registry][host-jobs]

**保留日志也保留风险。**权限投影从 `permission/preset`、`sandbox/mode`、`approval/policy` 重建历史选择；inbox 从 `agent/inbox/spliced` 重建待处理消息。日志中的系统／开发者指令、压缩摘要和旧路径同样不是经过脱敏或安全清洗的文本。打开并继续恢复会话时，这些权限、队列和指令可能影响后续行为，不能将它们当成只读聊天记录。[权限重建][host-permissions] · [队列重建][host-inbox] · [事件词汇][host-events]

当前导入和远端提交都要求 `trusted: true`，面板必须先勾选可信来源确认。结构验证、CRC 和 SHA-256 只能验证格式及内容一致性，**不证明作者可信，也不消除提示注入或高权限风险**。不要导入来源不明的归档；可信备份也应在目标继续前核对权限、待处理消息、目标路径、agent preset 及实际工具配置。[可信确认][plugin-host] · [面板风险提示][plugin-locales] · [preset 元数据语义][host-header]

## 6. 更适合跨机继续工作的方案

### 首选：同一远端实例，保持唯一写入点

如果目标是「在两台机器之间切换工作设备」，而不是独立离线编辑两份历史，建议让项目、会话 persistence、附件和 agent 都驻留在一个远端实例。两台机器各自通过认证浏览器和受控隧道连接**同一个 Web 实例、同一个会话**；日志只有一份，无需同步或合并。官方 persistence 已定义单写入者所有权，现有 `dsh-remote` 已具备 TCP 转发能力；这是建议的部署拓扑，不是当前面板已经提供的跨设备 owner 管理功能。[单写入者契约][host-persistence] · [现有隧道][remote-forward]

不要把「两个独立 dsh web 进程共享一个 `DSH_HOME`」误当成同一个实例。当前 `dsh-remote` 启停仍按连接 ID 管理远端 pid，点击「断开」会停止对应远端实例；多人／双设备共用实例时，必须协调实例生命周期，不能让任一客户端误停另一客户端正在使用的服务。[连接事实][remote-engine] · [断开实现][remote-disconnect]

### 离线／断线：人工快照移交

1. 停止源端根与子会话继续推进；如有定时任务、外部进程或自动化写入，另外暂停并核对。导出只是逐日志 flush，不会自动冻结这些运行状态。[导出观察点][host-export-entries] · [独立定时任务][host-schedule]
2. 另行备份／传送项目文件、外部 deliverables、必要的 Git 私有 checkpoint 和环境配置，再导出完整 ZIP；归档存储应按敏感上下文处理，不默认已脱敏或加密。[归档范围][host-export-entries] · [备份提示][plugin-locales]
3. 在目标填写真实存在的绝对目录，预览 `new`／`same`／`conflict`，确认可信来源后导入。失败或提交结果不明，先重新预览，保留两端副本。[导入确认][plugin-host] · [结果处理][remote-transport]
4. 核对目标权限、队列、路径和工具环境后，人工打开并继续；源端保持停止，直到下一次明确移交。目标一旦产生新事件，旧快照通常会变成同 ID 不同内容，当前插件会拒绝覆盖。[当前冲突策略][plugin-archive] · [历史风险][plugin-locales]

### 真双向持续同步：另立协议，不同步活跃数据目录

若确需两端持续复制同一会话，最低限度需要：

- **append-only prefix compare：**比较两端 immutable header、继承边界和已提交事件，证明短日志是长日志的严格前缀后才追加缺少的尾部；只比 ID、最后序号、mtime 或摘要是否不同不够。
- **单 writer owner：**定义哪一端可以推进会话，以及 owner 移交、断线、超时和 fencing；离线时不能让两端都自认为可写。单后端的写锁不是跨副本的 owner 协议。
- **分叉冲突策略：**共同前缀后出现不同事件时，停止自动合并，保留分叉并由人选择或创建新会话；不能按时间排序拼接两条历史。
- **一致交付边界：**先验证并保存附件，再经官方 persistence 追加和 flush；还需定义会话树、workspace 关联及部分提交的恢复规则。

以上是设计门槛，不是当前实现能力；依据是官方事件不可改写、连续序号、单写入者和持久化屏障契约，以及当前插件的全量同内容／冲突判断。[追加与 flush 契约][host-handle] · [所有权契约][host-persistence] · [当前实现][plugin-archive]

**不建议同步整个活跃 `DSH_HOME`，也不建议以文件同步工具同步可写 SQLite。**它们把会话日志、附件、独立 domain、索引／缓存和运行态的不同一致性问题混在一起，绕过官方读写所有权与 flush 边界；当前官方导出选择逻辑读句柄而非物理文件，正是插件应遵循的更窄边界。需要灾难恢复级环境备份时，应另行设计停止写入后的备份／恢复流程，而不是把本插件快照迁移扩张为活跃目录镜像。[后端无关导出][host-export-log] · [持久化所有权][host-persistence] · [独立调度存储][host-schedule]

## 来源索引

官方链接均固定到 `639ed015397290b3745d163aafe02ffee4aa3f84`，行号来自本机只读源码；本仓链接指向当前工作区文件。

[host-download]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/client/HeaderAction.tsx#L29-L66
[host-download-slot]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/client/index.ts#L48-L62
[host-controller]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/client/controller.ts#L109-L126
[host-events]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/known-event-types.ts#L8-L82
[host-header]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/types.ts#L89-L130
[host-export-log]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts#L100-L169
[host-export-paths]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts#L171-L196
[host-export-safeid]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts#L309-L328
[host-export-entries]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts#L331-L404
[host-export-root]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/index.ts#L137-L164
[host-catalog]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-format/src/types.ts#L199-L229
[host-catalog-dispatch]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-format/src/catalog.ts#L92-L156
[host-current-validation]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-format-catalog/src/current.ts#L33-L51
[host-persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-persistence/src/index.ts#L115-L178
[host-handle]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-persistence/src/handle.ts#L85-L116
[host-workspace]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/workspace/workspace/src/entity.ts#L109-L129
[host-normalization]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/attachment/attachment-local/src/normalization.ts#L29-L125
[host-image-ref]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/attachment/attachment-local/src/store.ts#L92-L123
[host-browser-auth]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/browser-auth.ts#L229-L279
[host-request-rejection]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/rpc-host.ts#L103-L117
[host-present]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/deliverables/tool-present/src/index.ts#L76-L107
[host-git-snapshot]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/deliverables/workspace-changes/src/git.ts#L94-L168
[host-schedule]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/schedule/schedule/src/storage.ts#L1-L60
[host-jobs]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/jobs/jobs-local/src/index.ts#L128-L175
[host-permissions]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/permission-presets/src/index.ts#L95-L149
[host-inbox]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/inbox.ts#L20-L65

<!-- prettier-ignore-start -->

[plugin-archive]: <../../plugins/dsh-sessions/src/archive.ts>
[plugin-host]: <../../plugins/dsh-sessions/src/index.ts>
[plugin-client]: <../../plugins/dsh-sessions/src/client.tsx>
[plugin-shared]: <../../plugins/dsh-sessions/src/shared.ts>
[plugin-locales]: <../../plugins/dsh-sessions/src/client/locales.ts>
[plugin-tests]: <../../plugins/dsh-sessions/test/archive.test.ts>
[remote-host]: <../../plugins/dsh-remote/src/index.ts>
[remote-transport]: <../../plugins/dsh-remote/src/transport.ts>
[remote-forward]: <../../plugins/dsh-remote/src/ssh.ts>
[remote-engine]: <../../plugins/dsh-remote/src/engine.ts>
[remote-disconnect]: <../../plugins/dsh-remote/src/engine.ts>

<!-- prettier-ignore-end -->

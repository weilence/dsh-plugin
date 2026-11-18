# dsh-prompts 行为与陷阱

本文件承载 dsh-prompts 的行为与陷阱：插件定位、结构导览、提示词段与面板读写的行为，防错提醒紧随相关条目。全仓约定不在此重复，按条内引用读根 docs/ 对应文件。

## 插件定位

- 设置页「系统提示词」插件：管理用户系统提示词正文 `$DSH_HOME/system-prompt.md`，并把它注册进宿主系统提示词组装。
- 不碰 `AGENTS.md` 指令链（那是 `dsh-agent-instructions` 的职责），也不修改工作区指令。

## 结构导览

- `src/index.ts`：host half——经 `ctx.systemPrompt.section` 注册 `user:system-prompt` 段，并提供面板读写路由。
- `src/client.tsx`：client half——设置页「系统提示词」分区：原文编辑、创建、保存。
- `src/shared.ts`：host↔client 共享的路由路径常量与文件数据类型（集中惯例见根 docs/architecture.md）。
- `src/client/locales.ts`：本插件 zh / en 词典（机制见根 docs/i18n.md）。
- `src/client.module.css`：面板样式；`src/css-modules.d.ts`：CSS module 导入的类型声明。
- `test/host.test.ts`：路由与段的全部测试，覆盖什么见 [tests.md](tests.md)。
- `cordis.patch.yml`：loader 树插件行 insert；`package.json`：包清单（`dsh.client` 声明浏览器名录）——插件行与名录惯例见根 docs/architecture.md。
- `tsdown.config.ts` / `tsconfig.json`：构建与编译配置（惯例见根 docs/architecture.md）。
- `locale/zh.json` / `locale/en.json`：插件市场展示元数据（惯例见根 docs/i18n.md）；`icon.svg`：插件图标。

## 提示词段

- host half 经 `ctx.systemPrompt.section` 注册 `user:system-prompt` 段：`order: 10500`，位于第一方内容（部署 persona 后缀 10200）之后——用户段变化只影响提示词尾部，前缀 KV 缓存尽量保留。
- `interpolate: false`：用户文本里的 `{{…}}` 原样保留——不可改，未知变量引用会让系统提示词组装失败。
- 段文本每次组装同步重读文件（`lstatSync` + `readFileSync`，无缓存）：外部编辑与面板保存都在下一个尚未开始的模型步骤生效——不要为省 IO 加缓存，即时生效依赖每次组装重读。
- 任何读取异常（权限、非普通文件、超过 1 MiB 等）以空串兜底并按错误去重警告一次——段文本求值抛错会拖垮宿主全部请求，绝不阻塞系统提示词组装。
- 文件缺失 / 空内容时段自然消失，不占任何 token。

## 面板读写

- 读写路由目标固定为 `resolveDshHome(config.dshHome)/system-prompt.md`——浏览器不能提交目标路径，不接受浏览器指定的任意文件路径。
- `config.dshHome` 只决定本插件文件所在目录（默认 `$DSH_HOME`，未设置时为 `~/.dsh`），与 `dsh-agent-instructions` 的 `dshHome` 无关联——不要当作同一配置联动修改。
- client half 在设置页提供原文编辑、创建和保存，不设刷新与删除入口：分区每次挂载即重新读取，重开设置页即重试。
- 尚不存在时保存即创建；保存前对照读取时的 SHA-256 版本，其他程序已修改文件时返回冲突、不自动覆盖——旧内容不得直接落盘。
- 读取失败时停止编辑并显示实际错误，禁止覆盖写入。
- 文件不再需要时清空保存即可：缺失与空内容对段文本同义。
- 路由只接受预期 Host 的同源请求，写请求必须携带插件专用请求头；单文件上限 1 MiB，符号链接和非普通文件不能编辑——读到这类文件按异常处理，段文本以空串跳过。

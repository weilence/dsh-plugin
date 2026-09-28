# dsh-skills

设置页「Skills 管理」插件：直接扫描四个标准技能根（与官方 skill-filesystem provider 同一套发现与校验规则）并集全局注册表只读来源；对可写根新建 / 编辑 / 删除，Git 仓库技能安装与更新跟踪。

## 结构

- `src/index.ts`：host half，八个 HTTP 桥路由（list / file / save / delete / git-scan / git-install / git-check / git-update）；栅栏与 JSON 读写来自 `@dsh-plugins/shared/http`。
- `src/roots.ts`：四个可写根的归属判定（字面 + realpath 双变体，容忍 home 重定向 / 符号链接 / 大小写差异）。
- `src/scan.ts`：根扫描与校验（被遮蔽 / 无效条目也产出，供面板暴露与修复）。
- `src/frontmatter.ts`：行级已知键往返（无 YAML 依赖；读取端兼容引号 / 块标量，写入端新值按 YAML 双引号标量序列化）。
- `src/gitInstall.ts` / `gitUpdate.ts` / `gitMeta.ts`：Git 仓库技能发现与安装、更新检查与应用、安装元数据索引。
- `src/shared.ts`：双端 wire 类型与常量。
- `src/client/`：面板；技能为可展开卡片——点行在行内新建 / 编辑 / 查看（SkillForm / SkillView）；Git 安装为弹窗；HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-skills`）。

## 改动约定

- 读侧以**直接扫描**为主数据源：官方 web/desktop 组合刻意禁用 host 级 skill-filesystem（本地发现归各 agent preset 的 scoped 层），全局 `ctx.skills` 注册表默认为空，仅作只读补充（`ctx.get('skills')` 可选访问，缺席降级）。
- 管理范围固定两档（用户级 / 当前工作区 + 用户级），工作区档跟随主视图会话 cwd（sessions 快照 `retainedBy.mainView > 0`）；不提供任意目录选择。
- 编辑锁名称（与文件名一致）：改名或单文件 ↔ 目录包互转 = 删除后新建；更深的嵌套路径不是官方可发现的技能实体，拒绝删除。
- 写文件 node:fs 直落盘：本插件是宿主侧受信代码（用户从设置页发起的操作），不走模型沙箱策略。
- frontmatter 往返只重写已知键行，未知字段 / 注释 / 空行原样保留在原位——新增可编辑键时保持行级替换性质。

## 陷阱

- 会话目录重播只看 `name` / `description` 变化，且有约 200ms watcher 稳定窗；改正文不重播目录，但模型下次调用 `skill` 工具时读到的就是新正文。面板每次列表请求都是实时扫描，无缓存。
- 无效条目（缺描述、名称不合法、含旧版调用策略键）走与正常条目同一编辑流修复：填好 name / description 保存即转正。

## 测试

`pnpm --filter dsh-skills test`：scan / frontmatter / gitInstall / gitUpdate / roots 纯函数与临时目录单测；host.test.ts 桥集成往返。

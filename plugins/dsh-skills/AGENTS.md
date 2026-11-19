# @weilence/dsh-skills

侧栏「Skills 管理」全局面板插件：直接扫描四个标准技能根（与官方 skill-filesystem provider 同一套发现与校验规则）再合并全局注册表的只读来源；对可写根新建 / 编辑 / 删除，Git 仓库技能安装与更新跟踪。

## 心智模型

- 数据源：读侧以**直接扫描**为主——官方 web/desktop 组合刻意禁用 host 级 skill-filesystem（本地发现归各 agent preset 的 scoped 层），全局 `ctx.skills` 注册表默认为空，仅作只读补充（`ctx.get('skills')` 可选访问，不可用时降级）。
- 管理范围：固定两档（用户级 / 当前工作区 + 用户级），工作区档跟随主视图会话 cwd（sessions 快照 `retainedBy.mainView > 0`），不提供任意目录选择。
- 名称与形态：技能名锁定为文件名不可编辑，改名或单文件 ↔ 目录包互转一律删除后新建；更深嵌套路径不是官方可发现的技能实体。

## 实现约束

- 写文件用 node:fs 直接落盘。
- frontmatter round-trip 只重写已知键行，未知字段 / 注释 / 空行原样保留在原位——新增可编辑键时保持行级替换性质。
- 根归属判定保持字面 + realpath 双变体（容忍 home 重定向 / 符号链接 / 大小写差异）。

## 文档索引

- [docs/spec.md](docs/spec.md)：功能与行为规格——结构导览、扫描 / 校验 / frontmatter round-trip / Git 安装更新链路、面板行为语义。
- [docs/traps.md](docs/traps.md)：陷阱——实证事实、易错点、防错提醒。
- [docs/decisions.md](docs/decisions.md)：已确认决策——行为取舍与理由。
- [docs/tests.md](docs/tests.md)：测试地图——各测试文件覆盖与运行方式（单测 / 集成）。
- [README.md](README.md)：面向用户的功能、管理与安装说明。
- 全仓约定（双 half 架构、多语言、面板交互、测试分层）见根 AGENTS.md 的文档索引。

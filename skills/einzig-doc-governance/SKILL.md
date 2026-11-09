---
name: einzig-doc-governance
description: Follow a vault's Einzig document rules when organizing Obsidian inputs, updating versioned specs, or generating an Einzig proposal for review.
---

# Einzig 文档协作

先读 Vault 根目录的 `AGENTS.md`、项目文档规则和目标版本状态。目录以该 Vault 的 Einzig 映射为准。默认自由输入在 `用户输入/待整理`，版本玩法和进行中的需求在 `版本/Vx`，跨版本方法在 `共享工程`。归档按需读取。

- 保留用户输入的原文和附件。整理时用来源双链定位到笔记、标题或块。目标版本不明时先登记。跨版本同步单独审核。
- 先定位同一版本的功能 Key 及已有权威页。一个功能在该版本只有一个权威页。旧稿与新稿的关系逐条判断，日期只决定阅读顺序。分别记录新增、沿用、明确替代、冲突待确认。证据无法支持替代时保留冲突。
- 正文先给当前规则、适用范围和待决策项。短证据用默认折叠的 `> [!note]- 条款证据`，长证据放链接附录。保留已有条件、数值、来源与批准状态。提案、批准、实现和验收分别记录。
- 正式变更通过 Einzig 审核提交。尊重锁定范围，外部 Agent 写磁盘也不得绕过。功能 Key 由用户或既有索引确定，文档 ID 和修改 Key 由插件计算。改标题或移动文件时保留既有身份。

收到 Einzig 生成的整理请求时，按请求返回 JSON。保留版本、功能 Key、范围、目标路径和来源 SHA-256，移除返回值中的原文快照字段。每条差异保留稳定条款 ID、逐字引句和可核对的锚点。替代项同时给出目标正文中唯一匹配的旧段落，以及注明适用模式的新规则。先返回提案，由用户在 Obsidian 里逐条审核。未决项继续保留在草稿。

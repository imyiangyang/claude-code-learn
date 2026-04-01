# Claude Code 记忆系统分析

## 1. 记忆系统概述

Claude Code 的记忆系统是一个多层级、文件驱动的持久化上下文机制。它允许 Claude 在不同会话之间保持对用户需求、项目约定和工作模式的记忆。该系统分为两大类:

- **指令记忆 (CLAUDE.md)**: 项目级别的指令和约定,通过特殊文件注入系统提示词
- **自动记忆 (memdir)**: 运行时自动提取和保存的记忆,存储在文件系统目录中

这种设计让 Claude 能够"记住"用户的偏好、项目结构、常用命令等重要信息,无需在每个会话中重复说明。

## 2. CLAUDE.md 文件

> 📍 **源码位置**: `src/utils/claudemd.ts`（CLAUDE.md 加载逻辑）

### 2.1 什么是 CLAUDE.md

CLAUDE.md 是一个特殊的 Markdown 文件,用于向 Claude 提供项目级别的上下文和指令。当 Claude Code 启动时,它会自动查找并加载这些文件,将其内容注入到系统提示词中。

### 2.2 文件位置与加载优先级

CLAUDE.md 文件按照以下优先级顺序加载(后加载的优先级更高):

```
1. Managed memory (/etc/claude-code/CLAUDE.md)
   - 全局指令,适用于所有用户(企业/组织级)
   
2. User memory (~/.claude/CLAUDE.md)
   - 用户私有全局指令,适用于所有项目
   
3. Project memory (CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md)
   - 项目级指令,随代码库一起提交
   - 从当前目录向上遍历查找
   - 越靠近当前目录的文件优先级越高
   
4. Local memory (CLAUDE.local.md)
   - 项目级私有指令,通常添加到 .gitignore
```

### 2.3 加载时机

CLAUDE.md 文件在以下时机加载:

- **启动时**: 会话开始时自动加载所有相关 CLAUDE.md 文件
- **目录切换时**: 当 Claude 切换到不同目录时,会重新评估并加载新目录层级中的文件
- **文件变更时**: 当 CLAUDE.md 文件被修改时,系统会检测变更并更新上下文

### 2.4 示例 CLAUDE.md 内容

```markdown
# 项目指令

## 技术栈
- 使用 TypeScript 和 React
- 构建工具: Vite
- 测试框架: Vitest

## 代码规范
- 使用函数组件和 Hooks
- 优先使用 `const` 和 `let`,避免 `var`
- 组件文件名使用 PascalCase

## 常用命令
```bash
# 开发服务器
npm run dev

# 运行测试
npm test

# 构建生产版本
npm run build
```

## 注意事项
- 不要提交 .env 文件到版本控制
- 所有 API 调用必须通过 src/api/ 目录中的封装函数
```

### 2.5 最佳实践

1. **保持简洁**: 只包含 Claude 无法从代码中推断出的信息
2. **避免重复**: 不要重复 README 或代码中已有的信息
3. **使用规则目录**: 对于复杂项目,使用 `.claude/rules/*.md` 组织多个指令文件
4. **路径限定**: 使用 frontmatter 的 `paths` 字段限定规则适用的文件路径
5. **外部引用**: 使用 `@path` 语法引用其他文件,避免 CLAUDE.md 过于臃肿

## 3. memdir 自动记忆系统

> 📍 **源码位置**: `src/memdir/`（完整目录）

### 3.1 系统架构

memdir 是 Claude Code 的自动记忆存储系统,位于 `src/memdir/` 目录下。与 CLAUDE.md 不同,memdir 是 Claude 自动写入和读取的,无需用户手动编辑。

### 3.2 存储位置

> 📍 **源码位置**: `src/memdir/paths.ts:223-235`（`getAutoMemPath()`，memoized）, `src/memdir/paths.ts:109-150`（`validateMemoryPath()` 安全校验）

默认存储路径:
```
~/.claude/projects/<项目路径哈希>/memory/
```

路径解析优先级:
1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 环境变量(完整路径覆盖)
2. `autoMemoryDirectory` 设置项(支持 `~/` 展开)
3. 默认路径: `<memoryBase>/projects/<规范化路径>/memory/`

**安全校验（`validateMemoryPath()`）**: 拒绝以下路径：相对路径（`../foo`）、根/近根路径（长度 < 3）、Windows 驱动器根（`C:`）、UNC 网络路径（`\\server\share`）、含 null 字节的路径。

> 📍 **源码位置**: `src/memdir/paths.ts:179-186`（`getAutoMemPathSetting()`，security note：排除 `projectSettings` 以防恶意 repo 覆盖写入 `~/.ssh`）

**重要安全设计**：`autoMemoryDirectory` 设置**不**从 projectSettings（`.claude/settings.json`，随 repo 提交）读取，只从 policySettings/flagSettings/localSettings/userSettings 读取——防止恶意仓库通过设置 `autoMemoryDirectory: "~/.ssh"` 获取对敏感目录的静默写权限。

**`getAutoMemPath()` 的 memoize 策略**：以 `getProjectRoot()` 为缓存 key，不以路径字符串，这样测试中切换 projectRoot mock 时会重新计算，而生产中 env var/settings.json/CLAUDE_CONFIG_DIR 是会话稳定的。

**worktree 支持**（`src/memdir/paths.ts:203-205`）：使用 `findCanonicalGitRoot()` 获取 git repo 根，确保同一 repo 的所有 worktree 共享同一个 auto-memory 目录。

### 3.3 记忆类型与分类机制

> 📍 **源码位置**: `src/memdir/memoryTypes.ts:14-31`（`MEMORY_TYPES`、`parseMemoryType()`）, `src/memdir/memoryTypes.ts:113-178`（`TYPES_SECTION_INDIVIDUAL`）, `src/memdir/memoryTypes.ts:37-106`（`TYPES_SECTION_COMBINED`，含 `<scope>` 标签）

memdir 定义了四种记忆类型（`src/memdir/memoryTypes.ts`）:

```typescript
MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
```

| 类型 | 描述 | 存储范围 | 分类指导（来自 prompt 指令） |
|------|------|----------|---------------------------|
| **user** | 用户角色、目标、职责和知识 | 始终私有 | "个性化未来交互的信息" |
| **feedback** | 用户对 Claude 工作方式的反馈 | 默认可私有,项目约定可团队共享 | "带有 why + how-to-apply 的行为修正" |
| **project** | 项目进行中工作、目标、事件 | 私有或团队（偏向团队） | "**不能从代码/git 推导**的项目状态" |
| **reference** | 外部系统信息指针 | 通常为团队 | "指向外部系统的链接/路径/ID" |

**关键设计：分类逻辑是 prompt-driven 的，不是代码实现的。** 系统在 `memoryTypes.ts` 中定义了两套分类指南：

- `TYPES_SECTION_INDIVIDUAL`（个人模式）：单一 auto-memory 目录的 4 类型指导
- `TYPES_SECTION_COMBINED`（团队模式）：带 `<scope>` 标签的 4 类型指导，区分 private/team

每个 memory 文件通过 frontmatter 中的 `type:` 字段声明分类：

```markdown
---
type: feedback
description: 用户希望使用集成测试而非单元测试
---

## 测试策略

用户明确要求所有测试都连接真实数据库...
```

**分类发生的时机：**

1. **主对话中** — 主 agent 的 system prompt 包含完整的 4 类型分类指南，Claude 在写入 memory 文件时在 frontmatter 中指定 `type:`
2. **后台提取中** — 提取 agent 收到**同样的分类指南**（从 `memoryTypes.ts` 注入），保证分类一致

**验证与降级：** `parseMemoryType()` 函数（`memoryTypes.ts` line 28）对合法值返回对应类型，对非法值或缺失值返回 `undefined`——**优雅降级，不报错**。没有 type 的旧文件仍然正常工作

**feedback 类型特殊规则**（`memoryTypes.ts:60-62`）：记录**成功的方法**（validation），不只记录纠正（corrections）。只记录纠正会导致 Claude 规避以往错误却逐渐偏离用户已验证的方法，变得过度保守。feedback body 结构：规则 → **Why:** 行（原因）→ **How to apply:** 行（适用场景）。

**project 类型特殊规则**（`memoryTypes.ts:79`）：相对日期必须转为绝对日期（"Thursday" → "2026-03-05"），因为记忆是时间点快照，不是实时状态。

> 📍 **源码位置**: `src/memdir/memoryTypes.ts:201-202`（`MEMORY_DRIFT_CAVEAT`）, `src/memdir/memoryTypes.ts:240-256`（`TRUSTING_RECALL_SECTION`��

**记忆漂移警告（`MEMORY_DRIFT_CAVEAT`）**: 注入到 "When to access memories" 章节，提示：记忆记录随时间变旧，使用前验证当前状态，与现实冲突时信任当前观察而非记忆，并更新/删除过时记忆。

**`TRUSTING_RECALL_SECTION`（"Before recommending from memory"）**: 实验验证（`memoryTypes.ts:244`），header 措辞 "Before recommending"（行动触发点）比 "Trusting what you recall"（抽象标题）测试结果好 3/3 vs 0/3。内容：命名具体函数/文件/flag 的记忆是"写入时存在"的声明，推荐前必须验证（检查文件/grep 函数），"记忆说 X 存在"≠"X 现在存在"。

### 3.4 文件结构

```
~/.claude/projects/<project>/memory/
├── MEMORY.md              # 记忆索引文件
├── user_role.md           # 用户角色记忆
├── feedback_testing.md    # 测试相关反馈
├── project_deadlines.md   # 项目截止日期
└── reference_tools.md     # 工具引用
```

### 3.5 MEMORY.md 索引

> 📍 **源码位置**: `src/memdir/memdir.ts:34-38`（常量定义）, `src/memdir/memdir.ts:57-103`（`truncateEntrypointContent()`）

MEMORY.md 是记忆的入口文件,采用索引格式:

```markdown
- [用户角色](user_role.md) — 数据科学家,专注可观测性
- [测试策略](feedback_testing.md) — 集成测试必须连接真实数据库
- [发布计划](project_deadlines.md) — 移动端 3 月 5 日冻结合并
```

**截断算法**（`truncateEntrypointContent()`）：先按行截断（自然边界），再在最后一个换行符处按字节截断，防止切断行中间。同时检查原始行数和字节数，均超限时附加 WARNING 说明哪个 cap 触发。

> 📍 **源码位置**: `src/memdir/memdir.ts:87-98`（截断警告消息格式）

**截断警告消息格式**：
- 仅字节超限: `"${size} (limit: 25KB) — index entries are too long"`
- 仅行数超限: `"${n} lines (limit: 200)"`
- 两者均超限: `"${n} lines and ${size}"`

限制:
- 最多 200 行
- 最大 25,000 字节
- 超出限制会被截断并显示警告

### 3.6 与 CLAUDE.md 的区别

| 特性 | CLAUDE.md | memdir |
|------|-----------|--------|
| 编辑者 | 用户手动编辑 | Claude 自动写入 |
| 内容类型 | 指令和约定 | 观察和反馈 |
| 存储位置 | 项目目录 | ~/.claude/ |
| 版本控制 | 通常提交 | 从不提交 |
| 用途 | 告诉 Claude 该做什么 | 记录 Claude 学到什么 |

## 4. ~/.claude/ 配置目录

### 4.1 目录结构

```
~/.claude/
├── CLAUDE.md                 # 用户全局指令
├── settings.json             # 用户全局设置
├── settings.local.json       # 用户本地覆盖设置
├── keybindings.json          # 自定义快捷键
├── projects/                 # 项目记忆存储
│   └── <project-id>/
│       └── memory/           # 自动记忆目录
├── skills/                   # 用户技能
│   └── <skill-name>/
│       └── SKILL.md
├── commands/                 # 自定义命令
├── agents/                   # 自定义代理
├── rules/                    # 全局规则文件
├── teams/                    # 团队配置(TEAMMEM)
├── tasks/                    # 团队任务列表
├── plugins/                  # 插件数据
│   ├── repos/                # 插件仓库
│   └── data/                 # 插件持久数据
├── debug/                    # 调试日志
├── cache/                    # 缓存文件
│   └── changelog.md          # 更新日志缓存
├── telemetry/                # 遥测数据
└── backups/                  # 配置备份
```

### 4.2 主要文件说明

- **settings.json**: 用户全局设置,包括权限、模型选择、功能开关等
- **CLAUDE.md**: 适用于所有项目的全局指令
- **keybindings.json**: 自定义键盘快捷键配置
- **projects/**: 每个项目的自动记忆存储目录
- **skills/**: 用户定义的复用工作流
- **debug/**: 调试日志文件,可通过 `claude --debug` 查看

### 4.3 隐私和分析退出

用户可以通过以下方式控制数据收集:

```bash
# 禁用自动记忆
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1

# 或设置简单模式(禁用记忆、LSP、插件等)
export CLAUDE_CODE_SIMPLE=1
```

设置文件中也有对应的选项:
```json
{
  "autoMemoryEnabled": false,
  "analyticsOptOut": true
}
```

## 5. 记忆层级

Claude Code 的记忆系统采用分层设计,从全局到会话逐级细化:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Global (~/.claude/CLAUDE.md)                      │
│  - 适用于所有项目的用户偏好                                   │
│  - 全局快捷键、默认模型设置                                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Project (./CLAUDE.md, .claude/rules/*.md)         │
│  - 项目特定的编码规范                                         │
│  - 构建命令、测试策略                                         │
│  - 架构决策和约定                                             │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Local (./CLAUDE.local.md)                         │
│  - 个人项目偏好(不提交到版本控制)                             │
│  - 本地开发环境配置                                           │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Auto Memory (~/.claude/projects/*/memory/)        │
│  - Claude 自动记录的观察                                       │
│  - 用户反馈和纠正                                             │
│  - 项目上下文和参考信息                                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Session (临时)                                     │
│  - 当前会话的上下文                                          │
│  - 任务列表和计划                                             │
│  - 不持久化到磁盘                                             │
└─────────────────────────────────────────────────────────────┘
```

## 6. 记忆的生命周期

> 📍 **源码位置**: `src/memdir/memdir.ts:199-266`（`buildMemoryLines()`，定义 2 步保存规程）

### 6.1 读取时机

1. **会话启动**: 加载所有 CLAUDE.md 和 MEMORY.md 文件
2. **目录遍历**: 访问文件时加载相关目录的 CLAUDE.md
3. **工具调用**: 使用 `/memory` 命令查看记忆
4. **自动提取**: 会话结束时自动提取记忆(如果启用)

### 6.2 更新时机

1. **显式保存**: 用户要求"记住"某事时立即保存
2. **自动提取**: 会话结束时后台代理分析对话并提取记忆
3. **定期整理**: `/dream` 技能将日志整理为主题文件

### 6.3 持久化机制

- **CLAUDE.md**: 直接写入文件系统,用户版本控制
- **memdir**: 写入 `~/.claude/projects/<id>/memory/`
- **设置**: 保存到 `~/.claude/settings.json`

## 7. TEAMMEM 功能标志

> 📍 **源码位置**: `src/memdir/memdir.ts:7-9`（条件 require，feature('TEAMMEM')），`src/memdir/paths.ts:179-186`（getAutoMemPathSetting，注释说明 projectSettings 排除原因）

### 7.1 功能概述

TEAMMEM 是一个构建时功能标志,用于启用团队记忆共享功能。当启用时:

- 团队记忆存储在 `~/.claude/teams/{team-name}/memory/`
- 支持私有和团队两种范围的记忆
- 提供团队记忆同步机制

### 7.2 团队记忆结构

```
~/.claude/teams/{team-name}/
├── config.json          # 团队配置
├── memory/              # 团队共享记忆
│   ├── MEMORY.md
│   └── *.md
└── inboxes/             # 团队成员收件箱
    └── {agent}.json
```

### 7.3 记忆范围

当 TEAMMEM 启用时,记忆文件可以指定范围:

- **private**: 仅当前用户可见
- **team**: 团队成员共享

**补充发现（Q&A 学习）**：

**`DIR_EXISTS_GUIDANCE`（`src/memdir/memdir.ts:116-117`）**: 每个 memory 目录 prompt 末尾附加此提示，告知 Claude "目录已存在，直接用 Write 工具写入，不要运行 mkdir 或检查是否存在"。动机：Claude 曾在写入前浪费 turn 执行 `ls`/`mkdir -p`，`ensureMemoryDirExists()` 在 prompt 构建时（每会话一次，通过 `systemPromptSection` 缓存）幂等创建目录。

**2 步保存规程（`buildMemoryLines()`，`src/memdir/memdir.ts:199-266`）**：
- Step 1：写 memory 到独立文件（如 `user_role.md`），含 frontmatter（name/description/type）
- Step 2：在 MEMORY.md 添加指针（`- [Title](file.md) — one-line hook`，每条 ≤150 chars）
- MEMORY.md 是索引不是 memory，不含 frontmatter，不直接写 memory 内容

**`buildMemoryPrompt()` vs `buildMemoryLines()`**（`src/memdir/memdir.ts:272-316`）：`buildMemoryPrompt()` 在 agent memory 中使用（无 `getClaudeMds()` 等效物），读取并内联 MEMORY.md 内容；`buildMemoryLines()` 在系统提示中使用，MEMORY.md 通过 user context 注入，不在此重复。

**KAIROS 日志模式**（`src/memdir/memdir.ts:327-370`）：assistant-mode（长期会话）使用 append-only 日志写法，路径 `logs/YYYY/MM/YYYY-MM-DD.md`，提示模板中路径以模式而非字面日期表示（保持 prompt cache 跨午夜有效）；MEMORY.md 只用于读取（由 nightly dream 维护），不在此模式直接编辑。

## 8. 记忆与隐私

### 8.1 存储内容

**会存储的内容**:
- 用户角色和偏好
- 项目约定和反馈
- 外部系统引用
- 会话摘要(可选)

**不会存储的内容**:
- 代码内容或文件路径
- 敏感凭证或 API 密钥
- 具体的对话内容(除非显式要求)
- Git 历史或代码模式(可从代码推导)

### 8.2 数据位置

所有记忆数据都存储在本地文件系统:
- 默认位置: `~/.claude/`
- 可通过 `CLAUDE_CONFIG_DIR` 环境变量自定义
- 不会上传到 Anthropic 服务器

### 8.3 退出选项

用户可以通过多种方式控制记忆功能:

1. **禁用自动记忆**:
   ```bash
   export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
   ```

2. **简单模式**(禁用所有高级功能):
   ```bash
   export CLAUDE_CODE_SIMPLE=1
   ```

3. **设置文件**:
   ```json
   {
     "autoMemoryEnabled": false
   }
   ```

4. **分析退出**:
   ```json
   {
     "analyticsOptOut": true
   }
   ```

### 8.4 安全考虑

- CLAUDE.md 文件会被提交到版本控制,**不应包含敏感信息**
- `CLAUDE.local.md` 适用于私有指令,应添加到 `.gitignore`
- 自动记忆存储在用户主目录,其他用户无法访问
- 团队记忆文件权限由操作系统控制

## 9. 自动记忆提取与压缩管道（深度分析）

Claude Code 的记忆"压缩"**并非传统意义上的压缩算法**,而是一个**多层自动蒸馏（distillation）管道**,由两个独立的后台智能体协同完成。

### 9.1 第一层：Post-Turn 自动提取（每轮对话后）

> 📍 **源码位置**: `src/services/extractMemories/extractMemories.ts:296-615`（完整 `initExtractMemories()` 闭包）

**触发点：** `src/query/stopHooks.ts` → `executeExtractMemories()`

当主对话循环结束（Claude 输出最终回答、无更多 tool call）,系统会以 **fire-and-forget** 方式启动一个「提取智能体」：

| 细节 | 说明 |
|------|------|
| **实现方式** | 创建一个 **forked agent**（与主对话共享 prompt cache,零成本复制上下文） |
| **工具权限** | 只允许 Read/Grep/Glob（全开）+ Edit/Write（**仅限 memory 目录**） |
| **最大轮次** | 5 turns（防止过度探索） |
| **优化策略** | Turn 1 批量并行读取所有 memory 文件,Turn 2 批量并行写入更新 |
| **去重逻辑** | 先检查 `hasMemoryWritesSince()` — 如果主对话已手动写入 memory,跳过提取 |
| **频率控制** | Feature gate `tengu_bramble_lintel`（默认每 N 轮执行一次） |
| **游标机制** | 只有提取成功才推进 `lastMemoryMessageUuid`,失败的轮次下次重试 |
| **合并策略** | 如果提取正在运行时新轮次到达,暂存上下文,只保留最新一份（coalescing） |

**互斥机制详细说明**（`hasMemoryWritesSince()`，`src/services/extractMemories/extractMemories.ts:121-148`）：扫描 cursor 之后的所有 assistant messages，检测是否有 Edit/Write tool_use 块且 `file_path` 在 auto-memory 目录内。如果是，跳过 forked extraction 并推进 cursor，确保主 agent 和 background agent 对同一时间段的写入互斥。

**工具权限（`createAutoMemCanUseTool()`，`src/services/extractMemories/extractMemories.ts:171-222`）**：
- Read/Grep/Glob：无条件允许（只读工具）
- Bash：仅 `isReadOnly()` 为 true 的命令（ls/find/grep/cat/stat/wc/head/tail 等）
- Edit/Write：仅 `file_path` 在 memory 目录内
- REPL：特殊放行（ant-native 构建中 primitive tools 被隐藏，内部操作仍经过同一检查）
- 其余：全部 deny，记录 analytics 事件

**throttle 机制（`tengu_bramble_lintel`，`src/services/extractMemories/extractMemories.ts:377-385`）**：feature gate 控制每 N 轮执行一次提取。trailing run（stash 的上下文）跳过 throttle，因为是处理已提交的工作。

**`drainPendingExtraction()` 超时（`src/services/extractMemories/extractMemories.ts:579-586`）**：`Promise.race([Promise.all(inFlightExtractions), setTimeout(60_000).unref()])`，使用 `.unref()` 防止 timer 阻塞进程退出，在响应 flush 后但 graceful shutdown 之前调用。

**前置条件（全部满足才触发）：**
- Feature gate `tengu_passport_quail` 已启用
- Auto-memory 已启用（非 `--bare` 模式,未通过环境变量禁用）
- 非远程模式
- 仅主 agent（子 agent 不触发）

### 9.2 第二层：Dream 自动整合（定时后台 — 真正的"压缩"）

> 📍 **源码位置**: `src/services/autoDream/autoDream.ts:1-324`（完整 Dream agent），`src/services/autoDream/config.ts:13-21`（`isAutoDreamEnabled()`），`src/services/autoDream/consolidationLock.ts:1-140`（lock 机制）

**触发点：** `src/services/autoDream/autoDream.ts`

这是真正的"压缩"环节——一个后台整合智能体,分 **4 个阶段**工作：

**门控条件：** 距上次 Dream > 24 小时 **AND** 已经过 >= 5 个会话 **AND** 获取到排他锁

```
Phase 1 (Orient / 定向)
  └─ ls memory 目录、读 MEMORY.md 索引、略读现有主题文件,避免重复

Phase 2 (Gather / 收集信号)
  └─ 搜索每日日志（append-only stream）→ 窄范围 grep 会话转录
  └─ 发现矛盾条目和新信息

Phase 3 (Consolidate / 整合)
  └─ 将新信号合并进现有主题文件
  └─ 相对日期转换为绝对日期（"上周" → "2026-03-24"）
  └─ 去重：相同信息合并到同一主题文件

Phase 4 (Prune / 修剪)
  └─ 更新 MEMORY.md 索引（保持 < 200 行 / 25KB）
  └─ 删除过期指针,新增指针
  └─ 解决矛盾条目（两个文件内容冲突时,修正错误的那个）
```

整合提示定义在 `src/services/autoDream/consolidationPrompt.ts`,锁机制在 `consolidationLock.ts`。

**锁文件设计（`src/services/autoDream/consolidationLock.ts`）**：
- 锁文件路径：`<memory-dir>/.consolidate-lock`
- 文件内容：持有者的 PID
- **`mtime` = lastConsolidatedAt**（不是加锁时间，而是上次整合时间）
- 失败回滚：`rollbackConsolidationLock(priorMtime)` 使用 `utimes()` 将 mtime 恢复到 priorMtime
- 崩溃恢复：PID 失活 + mtime 超过 `HOLDER_STALE_MS`（1小时）→ 自动回收锁

**scan throttle（`src/services/autoDream/autoDream.ts:56`）**：`SESSION_SCAN_INTERVAL_MS = 10分钟`——当 time-gate 通过但 session-gate 不够时，防止每轮都触发 `listSessionsTouchedSince` I/O 扫描（lock mtime 不推进，time-gate 会持续通过）。

**`isAutoDreamEnabled()` 优先级**（`src/services/autoDream/config.ts:13-21`）：settings.json 的 `autoDreamEnabled` 字段优先，未设置则回落到 GrowthBook feature flag `tengu_onyx_plover` 的 `enabled` 字段。

**autoDream 排除当前会话**（`src/services/autoDream/autoDream.ts:163-166`）：`listSessionsTouchedSince` 扫描到的 session IDs 中过滤掉当前 session（其 mtime 总是最新的）。

**Dream 进度监控（`makeDreamProgressWatcher()`，`src/services/autoDream/autoDream.ts:281-313`）**：每次 assistant turn 中，提取 text blocks（展示给用户）+ 统计 tool_use 数量 + 收集 Edit/Write 的 `file_path`（用于任务状态和完成消息）。

### 9.3 硬编码限制参数

> 📍 **源码位置**: `src/memdir/memdir.ts:35-38`，`src/memdir/memoryScan.ts:21-22`，`src/memdir/findRelevantMemories.ts:18-24`（`SELECT_MEMORIES_SYSTEM_PROMPT`，max_tokens:256）

| 参数 | 值 | 来源文件 | 说明 |
|------|-----|---------|------|
| `MAX_ENTRYPOINT_LINES` | 200 | `memdir.ts:35` | MEMORY.md 索引最大行数 |
| `MAX_ENTRYPOINT_BYTES` | 25,000 | `memdir.ts:38` | 索引最大字节数 |
| `MAX_MEMORY_FILES` | 200 | `memoryScan.ts:21` | 目录最多扫描文件数（按 mtime 倒序） |
| `MAX_MEMORY_LINES` | 200 | `attachments.ts` | 单个 memory 文件注入上下文的最大行数 |
| `MAX_MEMORY_BYTES` | 4,096 | `attachments.ts` | 单个 memory 文件注入上下文的最大字节数 |
| Sonnet 选择 max_tokens | 256 | `findRelevantMemories.ts:109` | 相关性选择 API 调用的输出上限 |
| Extract agent maxTurns | 5 | `extractMemories.ts:426` | 防止提取 agent 过度探索 |
| drain timeout | 60,000ms | `extractMemories.ts:579` | `drainPendingExtraction()` 软超时 |
| Dream minHours | 24 | `autoDream.ts:64` | Dream 最小触发间隔 |
| Dream minSessions | 5 | `autoDream.ts:65` | Dream 最小累积会话数 |
| Dream scan throttle | 10min | `autoDream.ts:56` | session scan I/O 最小间隔 |
| Lock stale threshold | 1h | `consolidationLock.ts:19` | 持有者失活后视为可回收 |

**`scanMemoryFiles()` 的单遍扫描优化**（`src/memdir/memoryScan.ts:32-34`）：`readFileInRange` 内部自带 stat，单次调用读取内容 + mtime，避免分开的 stat-sort-read 三步操作，对 N ≤ 200 的常见情况减少一半 syscall。

### 9.4 记忆注入上下文的流程

> 📍 **源码位置**: `src/memdir/memdir.ts:419-507`（`loadMemoryPrompt()` 分发逻辑），`src/memdir/findRelevantMemories.ts:39-75`（`findRelevantMemories()`），`src/memdir/memoryScan.ts:35-77`（`scanMemoryFiles()`），`src/memdir/memoryAge.ts:33-42`（`memoryFreshnessText()`）

记忆不仅在启动时加载,还在**每轮对话中动态注入最相关的记忆**：

**系统提示注入（启动时）：**
- `loadMemoryPrompt()`（`memdir.ts` line 419）被 `constants/prompts.ts` 调用
- 将 memory 指令 + MEMORY.md 全文注入系统提示的 `memory` 段
- 通过 `systemPromptSection` 缓存,每个会话只加载一次

**相关记忆注入（每轮对话）：**

```
用户发送消息
  │
  ├─→ startRelevantMemoryPrefetch() [与 API 调用并行]
  │     ├─ scanMemoryFiles(): 扫描 memory 目录,读取所有文件 frontmatter
  │     ├─ findRelevantMemories(): 调用 Sonnet 模型做相关性排序
  │     │   └─ 输入: 用户消息 + memory manifest（文件名、描述、类型列表）
  │     │   └─ 输出: 最多 5 个最相关的 memory 文件路径
  │     └─ 过滤: 跳过本会话已 surfaced 的文件（会话级去重）
  │
  └─→ getRelevantMemoryAttachments() [API 响应前注入]
        ├─ readMemoriesForSurfacing(): 读取选中文件（≤200 行 / ≤4KB）
        ├─ memoryFreshnessText(): 为 >1 天前的文件添加"过时警告"
        └─ 作为 <system-reminder> 块注入消息流
```

**过时感知机制（`memoryAge.ts`）：**
- 今天/昨天修改的文件：无额外标注
- 更早修改的文件：添加提醒 "This memory is N days old — verify against current state before asserting"
- 防止 Claude 将过时的状态信息当作当前事实

> 📍 **源码位置**: `src/memdir/memoryAge.ts:33-42`（`memoryFreshnessText()`，≤1 天返回空字符串），`src/memdir/memoryAge.ts:49-53`（`memoryFreshnessNote()`，带 `<system-reminder>` 包装，用于 FileReadTool 输出）

**`selectRelevantMemories()` 的 false-positive 防护**（`src/memdir/findRelevantMemories.ts:87-95`）：传入 `recentTools` 列表，system prompt 指示：正在使用的工具不需要推荐其参考文档（已在实际操作中），但工具的警告/gotcha/已知问题 memory 仍应推荐（正使用时最关键）。

**`loadMemoryPrompt()` 分发逻辑**（`src/memdir/memdir.ts:419-507`）：
1. `KAIROS` + autoEnabled + kairosActive → `buildAssistantDailyLogPrompt()`（append-only log 模式）
2. `TEAMMEM` + `isTeamMemoryEnabled()` → `buildCombinedMemoryPrompt()`（两个目录）
3. `autoEnabled` → `buildMemoryLines()`（单目录）
4. 否则 → 记录 `tengu_memdir_disabled` 事件，返回 null

**`buildSearchingPastContextSection()` feature gate**（`src/memdir/memdir.ts:375-407`）：由 `tengu_coral_fern` gate 控制，开启时在 memory prompt 末尾注入两条搜索命令，让 Claude 知道如何搜索 memory 目录和 transcript JSONL 文件，使用窄搜索词（错误消息/文件路径/函数名）而非宽泛关键词。

### 9.5 完整管道流程图

```
对话结束(无更多 tool call)
  │
  ├─→ executeExtractMemories() [fire-and-forget]
  │     ├─ 创建 forked agent（共享 prompt cache）
  │     ├─ 预注入 memory manifest（scanMemoryFiles() 扫描结果）
  │     ├─ 代理执行 ≤5 轮: 读取现有 → 并行写入新/更新的 memory 文件
  │     ├─ 游标仅在成功时推进
  │     └─ 写入磁盘: memory/*.md + MEMORY.md
  │
  └─→ executeAutoDream() [fire-and-forget, 独立]
        └─ 满足 24h + 5 session 门控时才运行
             ├─ Phase 1: 定向（读取现有状态）
             ├─ Phase 2: 收集信号（日志 + 转录）
             ├─ Phase 3: 整合（合并、去重、消除矛盾）
             ├─ Phase 4: 修剪索引（< 200 行 / 25KB）
             └─ 写入磁盘: 更新后的文件 + MEMORY.md

关闭前: drainPendingExtraction() 等待进行中的提取（60s 软超时）
```

### 9.6 关键源文件索引

> 📍 **补充发现（Q&A 学习）**

| 文件路径 | 职责 |
|---------|------|
| `src/memdir/memdir.ts` | 核心协调器：构建 memory prompt、管理 MEMORY.md 入口、截断逻辑、`loadMemoryPrompt()` 分发（KAIROS/TEAMMEM/auto/null）、`buildSearchingPastContextSection()`（tengu_coral_fern gate） |
| `src/memdir/memoryTypes.ts` | 4 类型分类定义、分类指导 prompt（`TYPES_SECTION_INDIVIDUAL/COMBINED`）、验证逻辑、`TRUSTING_RECALL_SECTION`、`MEMORY_DRIFT_CAVEAT` |
| `src/memdir/memoryScan.ts` | 扫描 memory 目录、读取 frontmatter、按 mtime 排序；单遍优化（readFileInRange 含 stat）；`formatMemoryManifest()` 格式化为文本清单 |
| `src/memdir/findRelevantMemories.ts` | Sonnet 驱动的相关性选择器（structured JSON output），返回最多 5 个；`recentTools` 过滤 false positive；`MEMORY_SHAPE_TELEMETRY` gate |
| `src/memdir/memoryAge.ts` | 记忆过时检测：`memoryFreshnessText()`（≤1天返回空）、`memoryFreshnessNote()`（带 system-reminder 包装） |
| `src/memdir/paths.ts` | 路径解析、安全校验、`isAutoMemoryEnabled()`（5层）、`isExtractModeActive()`（tengu_passport_quail）、`getAutoMemPath()`（memoized by projectRoot）、worktree git-root 共享、`isAutoMemPath()`（安全 normalize） |
| `src/services/extractMemories/extractMemories.ts` | 后台提取 agent：闭包状态（cursor/throttle/coalescing）、`hasMemoryWritesSince()`（互斥）、`createAutoMemCanUseTool()`（权限矩阵）、`drainPendingExtraction()`（60s unref） |
| `src/services/extractMemories/prompts.ts` | 提取 agent 的 prompt 模板（auto-only / combined 两版） |
| `src/services/autoDream/autoDream.ts` | 定时整合 agent：三门控（time→scan throttle→session→lock）、`makeDreamProgressWatcher()`、失败回滚 |
| `src/services/autoDream/config.ts` | `isAutoDreamEnabled()`：settings.json 优先，回落 tengu_onyx_plover |
| `src/services/autoDream/consolidationLock.ts` | lock 文件：mtime=lastConsolidatedAt、PID body、`HOLDER_STALE_MS=1h`、`utimes()` 回滚、`listSessionsTouchedSince()` |
| `src/services/autoDream/consolidationPrompt.ts` | Dream 4 阶段整合指令 |
| `src/query/stopHooks.ts` | 触发器：在每轮对话结束时 fire extraction 和 dream |
| `src/utils/attachments.ts` | 相关记忆预取、读取、注入为 system-reminder |
| `src/utils/messages.ts` | 消息组装：将 relevant_memories 渲染为 system-reminder 块 |

## 10. 记忆分类错误的纠正机制

Claude Code 提供 **3 种纠正途径**,但**没有自动检测分类错误的机制** — 系统采用"soft enforcement"策略。

### 10.1 途径一：`/memory` 命令（手动编辑）

```bash
> /memory
```

- 打开文件浏览器 UI（`src/commands/memory/memory.tsx`）
- 选择要编辑的 memory 文件
- 用 `$EDITOR`（vim/nano/code）直接编辑
- 直接修改 frontmatter 中的 `type:` 字段即可纠正分类
- 保存后 cache 自动清除（`clearMemoryFileCaches()`）,下一轮对话立即生效

### 10.2 途径二：`/remember` 技能（审查与提升）

```bash
> /remember
```

由 `src/skills/bundled/remember.ts` 实现,功能包括：

- 审查所有 auto-memory 条目
- 提议"提升"到不同层级：
  - → `CLAUDE.md`（项目级持久指令）
  - → `CLAUDE.local.md`（个人偏好,不提交版本控制）
  - → 团队 memory（如果启用 TEAMMEM）
  - → 保持在 auto-memory 中
- **关键安全规则**：所有修改必须先展示、获得用户明确批准后才执行（"Present ALL proposals before making any changes; do NOT modify files without explicit user approval"）

### 10.3 途径三：Auto-Dream 隐式修正

Dream 整合过程的 Phase 4 指令中包含：**"Resolve contradictions — if two files disagree, fix the wrong one"**

- 整合 agent 在整理时**可能**会注意到分类不一致并修正
- 但这不是显式的"修正分类"逻辑,而是整合过程中的副作用
- **不保证**会捕获到所有分类错误

### 10.4 设计哲学：Soft Enforcement

| 设计选择 | 说明 |
|---------|------|
| **无硬性校验** | `parseMemoryType()` 对非法值返回 `undefined` 而非抛错 |
| **指令驱动** | 通过 prompt 详细教导模型如何分类,而非代码强制 |
| **优雅降级** | 分类错误不会导致记忆丢失,只是在 relevance filtering 时可能被忽略 |
| **人类兜底** | `/memory` 命令让用户随时可以手动修正任何记忆文件 |

> 这反映了 Anthropic 的工程哲学：**在 AI 不确定性面前,宁可降级也不失败**（degrade gracefully, don't fail loudly）。

### 10.5 注意事项：没有 `/forget` 命令

源码中**未发现专门的 `/forget` 命令**实现。用户删除记忆的方式：

1. 通过 `/memory` 打开编辑器,手动删除文件内容
2. 编辑 MEMORY.md 索引移除对应指针,然后删除主题文件
3. 通过 `/remember` 技能审查时标记为删除

## 11. 相关命令

| 命令 | 描述 | 实现文件 |
|------|------|---------|
| `/init` | 创建 CLAUDE.md 文件 | `src/commands/init/` |
| `/memory` | 管理自动记忆（打开编辑器） | `src/commands/memory/memory.tsx` |
| `/remember` | 审查 auto-memory,提议提升到 CLAUDE.md 等层级 | `src/skills/bundled/remember.ts` |
| `/dream` | 手动触发记忆整合（4 阶段蒸馏） | `src/services/autoDream/` |
| `/config` | 查看和修改设置（含 autoMemoryEnabled） | `src/commands/config/` |

> **注意：** 源码中未发现专门的 `/forget` 命令实现。

## 12. 总结

Claude Code 的记忆系统是一个精心设计的分层架构,平衡了自动化和可控性:

- **CLAUDE.md** 提供显式、可版本控制的指令
- **memdir** 自动捕获隐式知识和反馈
- **自动提取管道** 每轮对话后 fire-and-forget 提取,Dream 定时整合蒸馏
- **分类策略** 4 类型封闭分类（user/feedback/project/reference）,prompt-driven 而非代码强制,优雅降级
- **分层加载** 确保正确的优先级和覆盖
- **相关性注入** 每轮对话通过 Sonnet 模型动态选择最相关的 ≤5 个记忆文件注入上下文
- **隐私优先** 所有数据本地存储,提供完整的退出机制

这种设计让 Claude 能够在保持上下文的同时,尊重用户隐私和项目约定。其"宁可降级也不失败"的哲学贯穿整个记忆系统——从分类验证到过时检测,每个环节都选择了 graceful degradation 而非 hard failure。

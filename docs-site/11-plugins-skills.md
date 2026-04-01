# Claude Code 插件与技能系统

> 📍 **核心源文件**: `src/skills/loadSkillsDir.ts`（技能加载核心，1086行）, `src/skills/bundledSkills.ts`（内置技能注册）, `src/skills/mcpSkillBuilders.ts`（MCP技能集成）

## 概述

Claude Code 的技能系统（Skill System）是其可扩展架构的核心组件，允许用户通过声明式 Markdown 文件定义可复用的工作流。技能本质上是预配置的提示词模板，封装了特定任务的执行逻辑、工具权限和上下文要求。

技能与工具（Tool）和代理（Agent）共同构成了 Claude Code 的三层能力体系：

- **工具**：原子级操作（如读取文件、执行命令）
- **技能**：可复用的工作流模板
- **代理**：自主执行复杂任务的智能体

## 技能系统架构

### 技能加载来源

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:638-803`（getSkillDirCommands：memoize 并行加载所有来源）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:78-94`（getSkillsPath：各 source 的路径映射）

Claude Code 从多个层级加载技能，按优先级排序：

| 来源 | 路径 | 优先级 |
|------|------|--------|
| 托管策略 | `~/.claude-managed/.claude/skills/` | 最高 |
| 用户配置 | `~/.claude/skills/` | 高 |
| 项目配置 | `./.claude/skills/` | 中 |
| 额外目录 | `--add-dir` 指定的路径 | 低 |
| 内置技能 | 编译在 CLI 中 | 最低 |

**补充发现（Q&A 学习）**：
- `getSkillDirCommands` 使用 `memoize` 缓存（按 `cwd` 参数缓存），只在 session 开始时加载一次
- 所有来源的加载**并行执行**（`Promise.all`），互不阻塞
- `--bare` 模式下跳过自动发现（managed/user/project），只加载 `--add-dir` 指定的路径
- `CLAUDE_CODE_DISABLE_POLICY_SKILLS` 环境变量可禁用 managed（策略）技能

### 技能文件格式

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:185-265`（parseSkillFrontmatterFields：解析所有 frontmatter 字段）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:159-178`（parseSkillPaths：`**` 全匹配时视为 undefined）

技能采用目录结构存储，每个技能是一个包含 `SKILL.md` 的文件夹：

```
.skills/
  my-skill/
    SKILL.md
  another-skill/
    SKILL.md
    helper.js  # 可选的辅助文件
```

`SKILL.md` 使用 YAML Frontmatter 定义元数据：

```markdown
---
name: my-skill
description: 简短描述
allowed-tools:
  - Read
  - Write
  - Bash(git:*)
when_to_use: 详细的使用场景说明
argument-hint: "<参数提示>"
arguments:
  - arg1
  - arg2
context: fork  # 或 inline
paths:
  - "src/**/*.ts"  # 条件技能：仅当操作匹配文件时激活
---

# 技能正文

使用 `$arg1` 和 `$arg2` 引用参数。
```

**支持的所有 frontmatter 字段**：
- `name`：显示名（覆盖目录名）
- `description`：描述文本
- `allowed-tools`：允许使用的工具列表
- `when_to_use`：使用场景说明（LLM 用于决策）
- `argument-hint`：参数提示字符串
- `arguments`：参数名列表
- `context`：执行模式（`fork` 或省略=inline）
- `paths`：条件激活路径模式（gitignore 格式）
- `model`：指定使用的模型（`inherit` 继承当前）
- `effort`：努力程度（影响 token 预算）
- `agent`：指定执行此技能的代理名
- `user-invocable`：是否允许用户 `/命令` 调用（默认 true）
- `disable-model-invocation`：禁止模型自动调用
- `hooks`：技能钩子配置
- `shell`：shell 执行配置
- `version`：技能版本

## 内置技能（Bundled Skills）

Claude Code 内置了多个核心技能，在 `src/skills/bundled/` 中定义：

### /simplify
代码审查与清理技能。启动三个并行代理分别检查代码复用、代码质量和执行效率。

### /batch
大规模并行变更编排技能。将大型重构分解为 5-30 个独立的 worktree 代理，每个代理创建独立的 PR。

### /skillify
将当前会话转换为可复用技能。分析会话历史，引导用户完成技能创建流程。

### /remember
自动内存审查技能。分析 `CLAUDE.md`、`CLAUDE.local.md` 和自动内存条目，提出整理建议。

### /verify
验证代理技能。在复杂变更后执行独立的对抗性验证。

### /debug
调试辅助技能。系统化的问题诊断流程。

## 实验性功能标志

### EXPERIMENTAL_SKILL_SEARCH

`EXPERIMENTAL_SKILL_SEARCH` 是 Anthropic 内部使用的实验性功能，启用远程技能发现和加载：

- **远程技能搜索**：通过 `DiscoverSkillsTool` 发现远程托管的技能
- **AKI/GCS 集成**：从 Google Cloud Storage 加载远程技能
- **本地缓存**：缓存远程技能内容以减少加载延迟
- **规范技能前缀**：使用 `_canonical_<slug>` 格式引用远程技能

该功能目前仅限 `USER_TYPE=ant` 的内部用户使用。

### TEMPLATES

`TEMPLATES` 功能标志启用模板化任务自动化：

- 支持从模板创建新任务
- 模板列表和回复功能
- CLI 子命令集成 (`claude new`, `claude list`, `claude reply`)

### WORKFLOW_SCRIPTS

`WORKFLOW_SCRIPTS` 启用工作流脚本系统：

- 本地工作流任务执行
- 工作流工具（WorkflowTool）集成
- 权限请求的特殊处理
- 后台任务对话框支持

## 自定义斜杠命令

用户可以通过创建技能文件定义自定义 `/command`：

### 创建自定义命令

1. 在 `~/.claude/skills/` 或项目 `.claude/skills/` 创建目录
2. 编写 `SKILL.md` 文件
3. 使用 `user-invocable: true` 启用用户调用

### 命令类型

| 类型 | 说明 | 示例 |
|------|------|------|
| Inline | 在当前会话中执行（默认） | `/simplify` |
| Fork | 在子代理中隔离执行 | `/batch` |

### 参数传递

```markdown
---
arguments:
  - filename
  - message
---

请处理文件 `$filename`，添加消息：$message
```

使用时：`/my-skill file.txt "Hello World"`

## 技能发现机制

### 启动时加载

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:677-714`（并行加载：managed + user + project + additional + legacy）

Claude Code 在启动时从所有配置来源并行加载技能：

```typescript
const [managedSkills, userSkills, projectSkills, legacyCommands] = 
  await Promise.all([
    loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
    loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),
    // ...
  ])
```

### 动态发现

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:861-915`（discoverSkillDirsForPaths：向上遍历至 cwd）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:885-898`（gitignore 检查：阻止 node_modules 内技能）

当用户操作文件时，Claude Code 会动态发现嵌套的技能目录：

```typescript
// 从文件路径向上遍历到 cwd，发现 .claude/skills/
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]>
```

**补充发现（Q&A 学习）**：
- 动态发现只向上遍历到 `cwd`，不包含 cwd 本身（cwd 级技能已在启动时加载）
- `dynamicSkillDirs` Set 记录已检查过的路径（命中或未命中），避免重复 stat 调用
- 发现的目录按深度排序（深的在前），深层目录的同名技能覆盖浅层（更贴近文件优先）
- **gitignore 检查**：`node_modules/pkg/.claude/skills/` 等被 gitignore 的路径不会被加载
- 通过 `skillsLoaded` signal 通知其他模块缓存需要清除（解耦，无循环依赖）

### 条件技能激活

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:997-1058`（activateConditionalSkillsForPaths：用 ignore 库进行 gitignore 格式匹配）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:824-829`（conditionalSkills Map + activatedConditionalSkillNames Set）

带有 `paths` 配置的技能是"条件技能"，仅在操作匹配文件时激活：

```typescript
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[]
```

**补充发现（Q&A 学习）**：
- 使用 `ignore` 库（gitignore 格式匹配），与 CLAUDE.md 条件规则行为一致
- 激活一次后，技能名进入 `activatedConditionalSkillNames` Set，即使缓存清除也不会回到"未激活"状态（session 内持久激活）
- `ignore()` 对以 `../` 开头或绝对路径会抛出异常，所以先进行路径有效性检查

## 技能执行流程

### SkillTool 执行流程

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:344-400`（getPromptForCommand：参数替换、${CLAUDE_SKILL_DIR}、${CLAUDE_SESSION_ID}、shell 执行）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:372-396`（MCP 技能安全：loadedFrom !== 'mcp' 时才执行内联 shell 命令）

1. **验证输入**：检查技能名称、格式和可用性
2. **权限检查**：根据用户权限规则决定是否允许执行
3. **加载内容**：从磁盘或缓存读取 SKILL.md
4. **参数替换**：将 `$arg` 替换为实际参数
5. **变量替换**：
   - `${CLAUDE_SKILL_DIR}` → 技能所在目录绝对路径（Windows 下反斜杠转正斜杠）
   - `${CLAUDE_SESSION_ID}` → 当前会话 ID
6. **Shell 执行**：执行 `!command` 内联命令（仅限非 MCP 技能）
7. **上下文注入**：将技能内容作为用户消息注入对话
8. **工具权限更新**：应用技能定义的 `allowed-tools`

### Fork 执行模式

对于 `context: fork` 的技能：

1. 创建独立的子代理
2. 分配独立的 token 预算
3. 在隔离上下文中执行
4. 返回执行结果摘要

### MCP 技能集成

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:1082-1086`（registerMCPSkillBuilders 叶子注册模块）
> 📍 **源码位置**: `src/skills/mcpSkillBuilders.ts`（MCP 技能构建器接口）

MCP（Model Context Protocol）服务器可以暴露技能：

```typescript
// MCP 技能通过 mcpSkillBuilders.ts 注册
export function registerMCPSkillBuilders(b: MCPSkillBuilders): void
```

**补充发现（Q&A 学习）**：
- `registerMCPSkillBuilders` 使用叶子注册模块模式，避免 `mcpSkills.ts` 直接导入 `loadSkillsDir.ts` 造成循环依赖
- 动态 import 在 Bun bundled 二进制中无法解析，所以改用变量间接注册

## 去重机制

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:717-769`（realpath 去重：first-wins，同文件多路径加载只取第一个）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:118-124`（getFileIdentity：realpath 解析符号链接）

**补充发现（Q&A 学习）**：
- 去重使用 `realpath()` 获取规范路径（解析符号链接），避免通过不同路径加载同一文件
- 不使用 inode 去重：虚拟/容器/NFS 文件系统中 inode 值可能不可靠（如全为0）
- 去重策略：**first-wins**（先加载的版本保留），按 managed > user > project > additional 顺序处理
- 无法获取 realpath 的文件（不存在或权限问题）不参与去重，直接保留

## 技能与工具的区别

| 特性 | 技能（Skill） | 工具（Tool） |
|------|--------------|-------------|
| **定义方式** | Markdown 文件 | TypeScript 代码 |
| **调用方式** | `/skill-name` 或 `SkillTool` | 直接工具调用 |
| **权限粒度** | 一组工具权限 | 单一操作 |
| **上下文** | 可携带复杂提示词 | 即时执行 |
| **可移植性** | 用户可自定义 | 内置固定 |
| **执行模式** | Inline 或 Fork | 立即执行 |

## 技能市场与生态

### 官方技能市场

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts`（isOfficialMarketplaceSkill ���过 pluginInfo.repository 识别官方市场技能）

源码中提到了 `isOfficialMarketplaceSkill` 函数，表明存在官方技能市场：

```typescript
function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  if (command.source !== 'plugin' || !command.pluginInfo?.repository) {
    return false
  }
  return isOfficialMarketplaceName(
    parsePluginIdentifier(command.pluginInfo.repository).marketplace
  )
}
```

### 插件集成

技能可以通过插件系统分发：

- 插件在 `src/services/plugins/` 中管理
- 插件技能通过 `pluginInfo` 字段标识来源
- 支持从 GitHub 等仓库加载

### 技能遥测

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:960-970`（tengu_dynamic_skills_changed：记录动态发现事件）

Claude Code 收集技能使用数据以改进推荐：

```typescript
logEvent('tengu_skill_tool_invocation', {
  command_name: sanitizedCommandName,
  skill_source: command.source,
  skill_loaded_from: command.loadedFrom,
  was_discovered: context.discoveredSkillNames?.has(commandName),
})
```

## 安全考虑

### 技能沙箱

> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:372-396`（MCP 技能禁止内联 shell 命令）
> 📍 **源码位置**: `src/skills/loadSkillsDir.ts:885-898`（gitignore 检查阻止不可信路径）

- MCP 技能的内联 shell 命令被禁止执行（`loadedFrom !== 'mcp'` 检查）
- 远程技能内容经过验证
- 技能文件权限检查（`isPathGitignored`）

### 权限边界

- 技能只能访问其 `allowed-tools` 中声明的工具
- 用户可通过权限规则阻止特定技能
- `disableModelInvocation` 可阻止模型自动调用

## 总结

Claude Code 的技能系统提供了强大的可扩展机制：

1. **声明式定义**：使用 Markdown 定义复杂工作流
2. **分层加载**：支持用户、项目、组织多级配置
3. **动态发现**：根据操作上下文自动激活相关技能
4. **灵活执行**：支持 Inline 和 Fork 两种执行模式
5. **生态集成**：与 MCP、插件系统深度整合

这一设计使 Claude Code 能够从通用编程助手演进为可深度定制的工作流自动化平台。

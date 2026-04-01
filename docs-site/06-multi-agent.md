# Claude Code 多智能体系统架构详解

## 概述

Claude Code 的多智能体系统是其核心架构特性之一，允许主会话在需要时派生子智能体（Sub-agent）来并行处理任务。这种设计使得复杂工作可以被分解为多个独立的、可并行执行的子任务，每个子任务由专门优化的智能体处理。

> 📍 **核心源码位置**:
> - `src/tools/AgentTool/AgentTool.tsx` — 工具主逻辑（1035行）
> - `src/tools/AgentTool/runAgent.ts` — 智能体执行引擎（973行）
> - `src/tools/AgentTool/loadAgentsDir.ts` — 智能体定义加载（755行）
> - `src/coordinator/coordinatorMode.ts` — Coordinator 模式（369行）

## 多智能体架构

### 智能体 spawning 机制

当 Claude Code 需要执行一个独立的子任务时，它会通过 `AgentTool` 创建一个新的子智能体。这个过程涉及以下关键步骤：

1. **智能体选择**：根据 `subagent_type` 参数选择对应的智能体定义
2. **上下文隔离**：子智能体获得独立的工具权限、系统提示词和上下文
3. **执行模式选择**：支持同步（阻塞）和异步（后台）两种执行模式
4. **结果回传**：子智能体完成后，结果通过 `AgentToolResult` 返回给父智能体

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:239-250`（`call()` 函数入口）

核心代码位于 `src/tools/AgentTool/AgentTool.tsx` 和 `src/tools/AgentTool/runAgent.ts`。

### shouldRunAsync 完整判断逻辑

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:567`

以下六个条件任一为真（且后台任务未被 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 禁用）即异步运行：

```typescript
const shouldRunAsync = (
  run_in_background === true          // 显式指定后台
  || selectedAgent.background === true // agent 定义强制后台
  || isCoordinator                     // Coordinator 模式
  || forceAsync                        // Fork subagent 实验
  || assistantForceAsync               // KAIROS/Daemon 模式
  || (proactiveModule?.isProactiveActive() ?? false) // 主动模式
) && !isBackgroundTasksDisabled
```

**补充发现（Q&A 学习）**：
- `getAutoBackgroundMs()` 函数（`src/tools/AgentTool/AgentTool.tsx:72-77`）：当 `CLAUDE_AUTO_BACKGROUND_TASKS` 环境变量或 GrowthBook gate `tengu_auto_background_agents` 开启时，前台 agent 运行超过 120 秒自动转为后台。
- `PROGRESS_THRESHOLD_MS = 2000`（`src/tools/AgentTool/AgentTool.tsx:63`）：同步 agent 运行超过 2 秒后显示 `BackgroundHint` UI 提示。

### 隔离机制

每个子智能体都运行在自己的隔离环境中：

- **独立的系统提示词**：基于智能体类型定制的角色定义
- **独立的工具权限**：通过 `tools` 和 `disallowedTools` 控制可用工具
- **独立的权限模式**：支持 `acceptEdits`、`plan`、`dontAsk` 等多种模式
- **可选的 Worktree 隔离**：通过 `isolation: 'worktree'` 在独立的 Git worktree 中运行

**补充发现（Q&A 学习）**：

权限模式覆盖规则（`src/tools/AgentTool/runAgent.ts:415-434`）：子智能体的 `permissionMode` 可覆盖父级，但父级为 `bypassPermissions`、`acceptEdits` 或 `auto`（需 `TRANSCRIPT_CLASSIFIER` feature gate）时**不覆盖**。

## 五个内置智能体详解

> 📍 **源码目录**: `src/tools/AgentTool/built-in/`
> - `generalPurposeAgent.ts` — 通用智能体
> - `exploreAgent.ts` — 探索智能体
> - `planAgent.ts` — 规划智能体
> - `verificationAgent.ts` — 验证智能体
> - `claudeCodeGuideAgent.ts` — 指南智能体

### 1. general-purpose（通用智能体）

**定位**：全能型任务执行者

**系统提示词核心**：
```
You are an agent for Claude Code, Anthropic's official CLI for Claude. 
Given the user's message, you should use the tools available to complete the task. 
Complete the task fully—don't gold-plate, but don't leave it half-done.
```

**特点**：
- 拥有完整的工具访问权限（`tools: ['*']`）
- 适用于复杂的多步骤研究任务
- 支持搜索代码、分析架构、执行多文件操作
- 默认继承主智能体的模型配置

**使用场景**：当需要执行涉及多个文件修改、复杂搜索或跨模块分析的综合性任务时。

### 2. Explore（探索智能体）

**定位**：只读代码库探索专家

**核心约束**：
```
=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
```

**特点**：
- **严格只读**：禁止所有文件修改操作
- **快速响应**：使用轻量级模型（外部用户使用 `haiku`）
- **并行搜索**：鼓励同时发起多个 grep/glob 查询
- **禁用工具**：`AgentTool`、`FileEditTool`、`FileWriteTool` 等被显式禁用

**使用场景**：快速定位文件、搜索代码模式、理解代码库结构。

**补充发现（Q&A 学习）**：

1. **ONE_SHOT_BUILTIN_AGENT_TYPES**（`src/tools/AgentTool/constants.ts:9-11`）：`Explore` 和 `Plan` 被标记为一次性智能体（`Set(['Explore', 'Plan'])`），省略 agentId/SendMessage/usage trailer（~135 chars），每周在 34M+ Explore runs 中节省大量 token。

2. **剥离 CLAUDE.md**（`src/tools/AgentTool/runAgent.ts:391-398`）：`omitClaudeMd: true` 时从 userContext 中剔除 `claudeMd` 字段。Explore/Plan 不需要 commit/PR/lint 规则，每周节省 5-15 Gtok（受 `tengu_slim_subagent_claudemd` feature flag 控制，默认开启）。

3. **剥离 gitStatus**（`src/tools/AgentTool/runAgent.ts:400-410`）：Explore 和 Plan 智能体还会剥离 `systemContext.gitStatus`（最多 40KB 的 stale git status），节省约 1-3 Gtok/week fleet-wide。

### 3. Plan（规划智能体）

**定位**：软件架构与实现规划专家

**核心职责**：
```
You are a software architect and planning specialist for Claude Code. 
Your role is to explore the codebase and design implementation plans.
```

**工作流程**：
1. **理解需求**：分析给定的任务需求
2. **深入探索**：使用搜索工具理解现有架构
3. **设计方案**：基于探索结果制定实现策略
4. **详细规划**：提供步骤化的实施计划

**输出要求**：
必须列出 3-5 个最关键的待修改文件：
```
### Critical Files for Implementation
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts
```

**使用场景**：在开始复杂实现前，先让 Plan 智能体分析并制定详细的实施策略。

### 4. Verification（验证智能体）

**定位**：主动破坏性验证专家

这是 Claude Code 中最复杂的内置智能体，其系统提示词长达 150+ 行，设计目标是**尝试破坏**而非**确认实现**。

**核心哲学**：
```
You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.
```

**系统提示词关键摘录**：

#### 失败模式识别
```
You have two documented failure patterns. 
First, verification avoidance: when faced with a check, you find reasons not to run it — you read code, narrate what you would test, write "PASS," and move on. 
Second, being seduced by the first 80%: you see a polished UI or a passing test suite and feel inclined to pass it, not noticing half the buttons do nothing...
```

#### 验证策略矩阵
```
**Frontend changes**: Start dev server → check your tools for browser automation...
**Backend/API changes**: Start server → curl/fetch endpoints → verify response shapes...
**CLI/script changes**: Run with representative inputs → verify stdout/stderr/exit codes...
**Infrastructure/config changes**: Validate syntax → dry-run where possible...
**Bug fixes**: Reproduce the original bug → verify fix → run regression tests...
```

#### 对抗性探测（Adversarial Probes）
```
- **Concurrency**: parallel requests to create-if-not-exists paths
- **Boundary values**: 0, -1, empty string, very long strings, unicode, MAX_INT
- **Idempotency**: same mutating request twice
- **Orphan operations**: delete/reference IDs that don't exist
```

#### 严格的输出格式
每个检查必须包含：
```
### Check: [what you're verifying]
**Command run:**
  [exact command you executed]
**Output observed:**
  [actual terminal output — copy-paste, not paraphrased]
**Result: PASS** (or FAIL — with Expected vs Actual)
```

#### 最终裁决
必须以以下格式之一结束：
```
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

**特点**：
- **背景执行**：`background: true`，验证任务在后台运行
- **受限写入**：只能写入 `/tmp` 目录（用于临时测试脚本）
- **禁止修改项目文件**：`FileEditTool`、`FileWriteTool` 被禁用
- **红色标识**：`color: 'red'` 在 UI 中突出显示

**使用场景**：任何非平凡任务（3+ 文件修改、后端/API 变更、基础设施变更）完成后，都应该调用 Verification 智能体验证。

### 5. claude-code-guide（指南智能体）

**定位**：Claude Code、Agent SDK 和 Claude API 的帮助专家

**专业领域**：
1. **Claude Code CLI**：安装、配置、hooks、skills、MCP 服务器、快捷键
2. **Claude Agent SDK**：基于 Claude Code 技术构建自定义智能体
3. **Claude API**：直接模型交互、工具使用、集成

**特点**：
- 使用轻量级模型（`haiku`）快速响应
- 自动获取官方文档（`code.claude.com/docs`）
- 权限模式为 `dontAsk`，无需用户确认
- 支持检查已运行的同类智能体，避免重复创建

**使用场景**：用户询问 "Can Claude..."、"How do I..." 等关于 Claude Code 功能的问题时。

## 自定义智能体

### 加载机制

Claude Code 通过 `loadAgentsDir.ts` 从以下位置加载自定义智能体：

> 📍 **源码位置**: `src/tools/AgentTool/loadAgentsDir.ts:193-221`（`getActiveAgentsFromList`）

1. **内置智能体**（`built-in`）：随软件发布
2. **插件智能体**（`plugin`）：由插件提供
3. **用户设置智能体**（`userSettings`）：`~/.claude/agents/`
4. **项目智能体**（`projectSettings`）：`.claude/agents/`
5. **策略设置智能体**（`policySettings`）：组织策略配置
6. **功能标志智能体**（`flagSettings`）：实验性功能

### 智能体定义格式

自定义智能体使用 Markdown 文件定义，前置元数据包含：

> 📍 **Zod 验证 Schema**: `src/tools/AgentTool/loadAgentsDir.ts:73-99`（`AgentJsonSchema`）

```yaml
---
name: my-custom-agent
description: 描述这个智能体的用途和何时使用
tools: ['FileReadTool', 'GrepTool', 'BashTool']
disallowedTools: ['FileWriteTool', 'FileEditTool']
model: haiku  # 或 sonnet、opus、inherit
permissionMode: plan  # acceptEdits、plan、dontAsk、bubble
background: false
memory: user  # user、project、local
isolation: worktree  # worktree、remote（ant-only）
color: blue
skills: ['my-skill', 'another-skill']  # 预加载的 skills
hooks:                                  # agent 生命周期 hooks
  SubagentStop:
    - matcher: ".*"
      command: "echo done"
mcpServers:                             # agent 专属 MCP 服务器
  - slack                               # 引用已有 server
  - { my-server: { command: "..." } }   # inline 定义（用后清理）
maxTurns: 50                            # 最大轮次
effort: high                            # 思考努力程度
---

系统提示词内容...
```

### 智能体优先级

当存在同名智能体时，优先级顺序为：

> 📍 **源码位置**: `src/tools/AgentTool/loadAgentsDir.ts:203-220`（Map 覆盖策略）

1. 内置智能体（最低优先级，可被覆盖）
2. 插件智能体
3. 用户设置智能体
4. 项目智能体
5. 功能标志智能体
6. 策略设置智能体（最高优先级）

**实现原理**：`getActiveAgentsFromList` 按上述顺序迭代填充 `Map<agentType, AgentDefinition>`，后迭代的覆盖前迭代的，最终 `Array.from(agentMap.values())` 返回去重后的列表。

## 智能体类型体系

> 📍 **源码位置**: `src/tools/AgentTool/loadAgentsDir.ts:106-165`

```typescript
// 三种智能体定义类型
type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void
  getSystemPrompt: (params: { toolUseContext: Pick<ToolUseContext, 'options'> }) => string
}

type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string  // 无参数（prompt 通过闭包存储）
  source: SettingSource          // userSettings | projectSettings | policySettings | flagSettings
}

type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  plugin: string  // 插件名称
}

type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition | PluginAgentDefinition
```

## 智能体隔离与安全

### 工具权限差异

| 智能体类型 | 文件写入 | 文件编辑 | Bash | Agent spawning |
|-----------|---------|---------|------|----------------|
| general-purpose | ✓ | ✓ | ✓ | ✓ |
| Explore | ✗ | ✗ | 只读 | ✗ |
| Plan | ✗ | ✗ | 只读 | ✗ |
| Verification | ✗（仅/tmp） | ✗ | ✓ | ✗ |
| claude-code-guide | ✗ | ✗ | ✓ | ✗ |

**安全设计原则**：默认只读，按需授权写入。Explore 和 Plan 智能体被设计为只读，确保在探索阶段不会意外修改代码。

### Worktree 隔离

通过 `isolation: 'worktree'` 参数，智能体可以在独立的 Git worktree 中运行：

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:590-593`

```typescript
const worktreeInfo = await createAgentWorktree(slug);
// 智能体在独立的 worktreePath 中执行所有操作
```

这提供了文件系统级别的隔离，智能体的修改不会影响主工作目录，直到显式合并。

**Worktree 清理策略**（`src/tools/AgentTool/AgentTool.tsx:644-685`）：
- `hookBased: true` 时**永久保留**（hook-based worktrees 无法检测 VCS 变化）
- `hasWorktreeChanges(worktreePath, headCommit)` 返回 true 时**保留**（有修改）
- 无变化时**自动删除**并清空 metadata 中的 `worktreePath`

### Agent 专属 MCP Server 清理规则

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:95-218`（`initializeAgentMcpServers`）

- **Inline 定义**（`{ [name]: config }` 格式）：agent 结束时清理（`newlyCreatedClients`）
- **字符串名引用**（`"slack"` 格式）：使用 memoized 共享 client，**不清理**

**Plugin-only 策略**（`src/tools/AgentTool/runAgent.ts:117-127`）：`strictPluginOnlyCustomization` 开启时，只有 admin-trusted（内置/插件/policy）的 agent 才能加载 frontmatter MCP servers；用户自定义 agent 的 frontmatter MCP 会被跳过。

### runAgent 生命周期清理

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:816-858`（`finally` 块）

agent 结束（正常/abort/错误）时清理：
1. `mcpCleanup()` — agent-specific MCP servers
2. `clearSessionHooks(rootSetAppState, agentId)` — 注册的 session hooks
3. `cleanupAgentTracking(agentId)` — prompt cache break 检测状态
4. `readFileState.clear()` — 克隆的文件状态缓存
5. `initialMessages.length = 0` — fork context messages 内存
6. `unregisterPerfettoAgent(agentId)` — perfetto 追踪注册
7. `clearAgentTranscriptSubdir(agentId)` — 转录子目录映射
8. 清理 `AppState.todos[agentId]` — 防止 whale sessions 的孤立 key 泄漏
9. `killShellTasksForAgent(agentId)` — 杀死后台 bash 任务（防 zombie 进程）

## Fork Subagent 实验

> 📍 **源码位置**: `src/tools/AgentTool/forkSubagent.ts`

### 工作原理

当 `isForkSubagentEnabled()` 为 true 且 `subagent_type` 未传时，触发 Fork 路径：

```typescript
// src/tools/AgentTool/forkSubagent.ts:32-39
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false  // 与 coordinator 模式互斥
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}
```

**FORK_AGENT 特殊之处**（`src/tools/AgentTool/forkSubagent.ts:60-71`）：
- **不在 builtInAgents 注册**，仅供内部路由
- `permissionMode: 'bubble'` — 权限提示冒泡回父终端
- `model: 'inherit'` — 继承父代模型（保证 context length 对等）
- `useExactTools: true` — 使用父代完全相同的工具集（保证 API 请求前缀 byte-identical，命中 prompt cache）
- `override.systemPrompt` 传入父代已渲染的系统提示词 bytes（避免 GrowthBook cold→warm 重算导致的 prompt cache bust）

### 递归 Fork 防护

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:332-334` + `forkSubagent.ts:78+`

主检查：`toolUseContext.options.querySource === 'agent:builtin:fork'`（存储在 context.options，抵抗 autocompact 的消息重写）。
备用检查：扫描 messages 中是否含 `FORK_BOILERPLATE_TAG`（来自 `src/constants/xml.ts`）。

## 智能体通信

### 结果回传机制

子智能体通过 `AsyncGenerator<Message>` 向父智能体流式输出结果：

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:748-806`

```typescript
for await (const message of query({...})) {
  // stream_event 中的 ttft 转发给父代 metrics
  if (message.type === 'stream_event' && message.event.type === 'message_start')
    toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
  // attachment（如 structured_output）直接 yield，不记录 transcript
  if (message.type === 'attachment') { yield message; continue }
  // 只记录 assistant/user/progress/compact_boundary
  if (isRecordableMessage(message)) {
    await recordSidechainTranscript([message], agentId, lastRecordedUuid)
    yield message
  }
}
```

### 异步任务通知

后台运行的智能体完成后，通过 `enqueueAgentNotification` 发送通知：

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:978-991`

```typescript
enqueueAgentNotification({
  taskId,
  description,
  status: 'completed',
  finalMessage,
  usage: { totalTokens, toolUses, durationMs }
});
```

**`<task-notification>` XML 格式**（Coordinator 模式接收格式，`src/coordinator/coordinatorMode.ts:148-164`）：
```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status summary}</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

### SendMessage 工具

命名智能体（通过 `name` 参数）可以通过 `SendMessageTool` 相互通信：

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:700-712`（`agentNameRegistry` 注册）

```typescript
// 向特定命名的智能体发送消息
SendMessage({ to: 'backend-agent', content: 'API 设计完成' })
```

`name → agentId` 的映射存储在 `AppState.agentNameRegistry`（`Map<string, AgentId>`），仅异步 agent 才注册（同步 agent 期间 coordinator 阻塞，SendMessage 路由无意义）。

## Coordinator 模式

> 📍 **源码位置**: `src/coordinator/coordinatorMode.ts`

### 激活方式

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

### Coordinator 的工具集

仅拥有：`Agent`、`SendMessage`、`TaskStop`、`subscribe_pr_activity`（可选）。Worker 工具集由 `ASYNC_AGENT_ALLOWED_TOOLS` 过滤 `INTERNAL_WORKER_TOOLS` 得到（`src/coordinator/coordinatorMode.ts:88-95`）。

### Coordinator 核心设计原则（`src/coordinator/coordinatorMode.ts:111-369`）

1. **只编排，不执行**：自己不使用文件/bash 工具，全部委托 worker
2. **永远综合，不委托理解**：禁止 "based on your findings, fix it"；必须自己读懂研究结果再写精确的实施 spec
3. **并行是超能力**：读操作（研究）自由并行；写操作（实现）同一文件集串行
4. **continue vs spawn**：上下文重叠度高 → continue（`SendMessage`）；低 → spawn fresh（`Agent`）
5. **Worker 结果不是对话**：`<task-notification>` 是内部信号，不要致谢或应答

### Scratchpad 目录

`src/coordinator/coordinatorMode.ts:104-106` — `tengu_scratch` feature gate 开启时，向 worker 的 userContext 注入 scratchpad 目录路径。Workers 可在此目录读写，无需权限提示，用于跨 worker 的持久化知识共享。

## 嵌套智能体与深度限制

### 嵌套能力

智能体可以嵌套创建子智能体，形成层级结构。这在 `AgentTool.tsx` 中有明确的递归处理逻辑。

### Fork 子智能体限制

为了防止无限递归，Fork 路径有特殊的保护机制：

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:332-334`

```typescript
// 递归 Fork 守卫
if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` 
    || isInForkChild(toolUseContext.messages)) {
  throw new Error('Fork is not available inside a forked worker...');
}
```

### 队友（Teammate）限制

在进程内队友（in-process teammate）模式下，队友不能创建其他队友：

> 📍 **源码位置**: `src/tools/AgentTool/AgentTool.tsx:272-274`

```typescript
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — the team roster is flat.');
}
```

**补充发现（Q&A 学习）**：进程内队友（in-process teammate）也不能创建后台 agent（`src/tools/AgentTool/AgentTool.tsx:278-280`）：`isInProcessTeammate() && teamName && run_in_background === true` 时抛错。同样，具有 `background: true` 定义的 agent 也不能被进程内队友创建。

## Skill 预加载机制

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:577-646`

agent 前置元数据中的 `skills` 字段列出需要预加载的 skill 名称，`runAgent` 在启动时自动注入：

```typescript
// 三步 skill 名称解析（resolveSkillName）
// 1. 精确匹配
// 2. 用 agent 的 plugin 前缀限定（my-skill → my-plugin:my-skill）
// 3. 后缀匹配（找 name.endsWith(':skillName') 的 command）
```

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:945-972`（`resolveSkillName`）

skill 内容以 `isMeta: true` 的 userMessage 注入到 `initialMessages`，并附带 `formatSkillLoadingMetadata` 生成的 UI 元数据。

## SubagentStart Hook 支持

> 📍 **源码位置**: `src/tools/AgentTool/runAgent.ts:530-555`

agent 启动时执行 `executeSubagentStartHooks`，收集 `additionalContexts` 并以 `hook_additional_context` 类型的 attachment message 注入到 `initialMessages`（与 SessionStart/UserPromptSubmit hooks 保持一致的注入方式）。

## 实际使用场景

### 场景 1：代码探索与理解

```
用户：帮我理解这个项目的认证流程

Claude Code：
→ 调用 Explore 智能体
→ 搜索 auth、login、session 相关文件
→ 返回关键文件位置和流程说明
```

### 场景 2：复杂功能实现

```
用户：添加一个支持 JWT 的认证中间件

Claude Code：
→ 调用 Plan 智能体制定实施计划
→ 根据计划逐步修改文件
→ 调用 Verification 智能体验证实现
→ 返回 VERDICT: PASS 后向用户��告完成
```

### 场景 3：并行任务处理

```
用户：重构所有 API 端点并更新对应的测试

Claude Code：
→ 同时启动多个 general-purpose 智能体
→ 智能体 A：重构用户相关端点
→ 智能体 B：重构订单相关端点
→ 智能体 C：重构产品相关端点
→ 等待所有智能体完成后汇总结果
```

### 场景 4：后台验证

```
Claude Code（完成文件修改后）：
→ 启动 Verification 智能体（background: true）
→ 继续与用户交互
→ 验证完成后收到通知
→ 如果 VERDICT: FAIL，自动修复问题
```

### 场景 5：Coordinator 编排（`isCoordinatorMode() = true`）

```
Coordinator（不执行任务本身）：
→ 并行启动研究 Worker A + Worker B
→ 等待 <task-notification> 到来
→ 综合研究结果，写精确实施 spec
→ SendMessage 给 Worker A 执行实现
→ Spawn 新 Verification Worker（新鲜视角）
→ 向用户报告最终结果
```

## 总结

Claude Code 的多智能体系统通过精心设计的角色分工、严格的权限隔离和灵活的通信机制，实现了安全高效的并行任务处理。Verification 智能体的存在尤其体现了 Anthropic 对代码质量的重视，其详细的系统提示词堪称 LLM 提示工程的典范。

这种架构使得 Claude Code 能够：
- 安全地并行处理多个独立任务
- 在探索阶段防止意外修改（剥离 CLAUDE.md + gitStatus 节省 token）
- 在实现后自动验证质量
- 根据任务类型选择最优的执行策略
- 通过 Coordinator 模式实现更高层次的多 Agent 编排

**补充发现（Q&A 学习）— 关键数字**：
- Explore spawns: 34M+/week（ONE_SHOT 优化节省 ~135 chars × 34M = 4.6B chars/week）
- claudeMd 剥离节省：5-15 Gtok/week
- gitStatus 剥离节省：1-3 Gtok/week
- worktree 自动后台转换阈值：2000ms（前台运行超时提示）
- MCP server 等待超时：30秒（`MAX_WAIT_MS = 30_000`，`src/tools/AgentTool/AgentTool.tsx:379`）

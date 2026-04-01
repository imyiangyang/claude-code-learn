# Claude Code 工具系统深度解析

## 概述

Claude Code 的工具系统是其核心架构之一，负责将 Claude 的意图转化为可执行的操作。本文档深入分析泄露源码中的工具类型系统、内置工具清单、注册机制、调用流程以及安全控制等关键机制。

---

## 1. 工具类型系统

工具系统的核心定义位于 `src/Tool.ts`，采用 TypeScript 泛型接口实现高度类型安全的工具定义。

### 核心 Tool 接口

> 📍 **Tool 接口定义**: `src/Tool.ts:362-695`

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  // 基础属性
  name: string
  aliases?: string[]
  searchHint?: string
  
  // Schema 定义
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>
  
  // 核心方法
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  
  // 权限与安全
  isConcurrencySafe(input: z.infer<Input>): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>
  
  // UI 渲染
  renderToolUseMessage(input: Partial<z.infer<Input>>, options: {...}): React.ReactNode
  renderToolResultMessage?(...): React.ReactNode
  renderToolUseProgressMessage?(...): React.ReactNode
  
  // 其他元数据
  maxResultSizeChars: number
  strict?: boolean
  shouldDefer?: boolean
  alwaysLoad?: boolean
}
```

**补充发现（Q&A 学习）**：

- `interruptBehavior?(): 'cancel' | 'block'`（`src/Tool.ts:416`）：控制用户发送新消息时，正在运行的工具的中断行为。默认为 `'block'`（新消息等待工具完成）。
- `backfillObservableInput?`（`src/Tool.ts:481`）：在观察者（SDK 流、transcript、canUseTool、Pre/PostToolUse hooks）看到 input 之前，对副本进行变更。必须幂等。原始 API 绑定 input 永不变更（保留 prompt cache）。
- `isOpenWorld?(input)` 方法（`src/Tool.ts:434`）：标记工具的调用是否是"开放世界"（意味着输出依赖外部状态，不可完全预测）。
- `preparePermissionMatcher?`（`src/Tool.ts:514-516`）：为 hook `if` 条件准备匹配器，实现 `"Bash(git *)"` 这类带参数的权限规则。
- `getActivityDescription?`（`src/Tool.ts:546-548`）：返回 spinner 显示的人类可读描述，如 "Reading src/foo.ts"。
- `renderGroupedToolUse?`（`src/Tool.ts:678-694`）：将同类工具的多次并行调用渲染为一个组（非 verbose 模式）。

### buildTool 工厂函数

> 📍 **TOOL_DEFAULTS 定义**: `src/Tool.ts:757-769`  
> 📍 **DefaultableToolKeys 类型**: `src/Tool.ts:707-714`  
> 📍 **buildTool 函数**: `src/Tool.ts:783-792`

所有工具通过 `buildTool()` 工厂函数创建，该函数提供安全的默认值：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // 默认不安全，需显式声明
  isReadOnly: (_input?: unknown) => false,           // 默认非只读
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input, _ctx) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

这种设计体现了**fail-closed**的安全原则：默认情况下工具被视为不安全，需要开发者显式声明安全属性。

**补充发现（Q&A 学习）**：

- `ToolDef` 类型（`src/Tool.ts:721-726`）是 `Tool` 的子集，`DefaultableToolKeys` 中的方法是可选的——`buildTool` 填充其余部分。
- `BuiltTool<D>` 类型（`src/Tool.ts:735-741`）在类型级别模拟了运行时的 `{...TOOL_DEFAULTS, ...def}` 展开，确保类型安全，60+ 个工具零类型错误。

---

## 2. 内置工具清单

Claude Code 包含 40+ 个内置工具，按功能分类如下：

> 📍 **getAllBaseTools 函数**: `src/tools.ts:193-261`

| 类别 | 工具名称 | 功能描述 |
|------|----------|----------|
| **文件操作** | `FileReadTool` | 读取文件、图片、PDF、Notebook |
| | `FileWriteTool` | 创建或覆盖文件 |
| | `FileEditTool` | 局部文件修改（字符串替换） |
| | `GlobTool` | 文件模式匹配搜索 |
| | `GrepTool` | 基于 ripgrep 的内容搜索 |
| **Shell 执行** | `BashTool` | Bash 命令执行 |
| | `PowerShellTool` | PowerShell 命令执行 |
| **网络** | `WebFetchTool` | 获取 URL 内容 |
| | `WebSearchTool` | 网络搜索 |
| **Agent 管理** | `AgentTool` | 子 Agent 创建 |
| | `SendMessageTool` | Agent 间消息发送 |
| | `TeamCreateTool` | 团队 Agent 创建 |
| | `TeamDeleteTool` | 团队 Agent 删除 |
| **任务管理** | `TaskCreateTool` | 任务创建 |
| | `TaskUpdateTool` | 任务更新 |
| | `TaskGetTool` | 任务查询 |
| | `TaskListTool` | 任务列表 |
| | `TaskStopTool` | 任务停止 |
| | `TaskOutputTool` | 任务输出获取 |
| | `TodoWriteTool` | Todo 列表写入 |
| **MCP/LSP** | `MCPTool` | MCP 服务器工具调用 |
| | `ListMcpResourcesTool` | MCP 资源列表 |
| | `ReadMcpResourceTool` | MCP 资源读取 |
| | `LSPTool` | 语言服务器协议集成 |
| **Notebook** | `NotebookEditTool` | Jupyter Notebook 编辑 |
| **模式切换** | `EnterPlanModeTool` | 进入计划模式 |
| | `ExitPlanModeTool` | 退出计划模式 |
| | `EnterWorktreeTool` | 进入 Git Worktree |
| | `ExitWorktreeTool` | 退出 Git Worktree |
| **其他** | `SkillTool` | Skill 执行 |
| | `ToolSearchTool` | 延迟加载工具搜索 |
| | `ScheduleCronTool` | Cron 定时任务 |
| | `RemoteTriggerTool` | 远程触发 |
| | `SleepTool` | 主动模式等待 |
| | `SyntheticOutputTool` | 结构化输出生成 |
| | `AskUserQuestionTool` | 询问用户问题 |
| | `BriefTool` | 摘要生成 |
| | `ConfigTool` | 配置管理（仅 `USER_TYPE=ant`） |
| | `REPLTool` | REPL 交互（仅 `USER_TYPE=ant`） |
| | `McpAuthTool` | MCP 认证 |

**补充发现（Q&A 学习）**：

- Ant-native 构建将 bfs/ugrep 嵌入 Bun 二进制，此时 `GlobTool` 和 `GrepTool` 不会注册（`src/tools.ts:197-199`，`hasEmbeddedSearchTools()` 检查）。
- `GlobTool` 和 `GrepTool` 在 Ant-native 构建中被跳过：`...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool])`
- `ToolSearchTool` 只有在 `isToolSearchEnabledOptimistic()` 返回 true 时才注册（`src/tools.ts:259`）。
- `TestingPermissionTool` 在 `NODE_ENV === 'test'` 时注册（`src/tools.ts:253`）。

### 工具权限分类

> 📍 **ALL_AGENT_DISALLOWED_TOOLS**: `src/constants/tools.ts:36-46`  
> 📍 **ASYNC_AGENT_ALLOWED_TOOLS**: `src/constants/tools.ts:55-76`  
> 📍 **IN_PROCESS_TEAMMATE_ALLOWED_TOOLS**: `src/constants/tools.ts:77-106`  
> 📍 **COORDINATOR_MODE_ALLOWED_TOOLS**: `src/constants/tools.ts:107-116`

`src/constants/tools.ts` 定义了不同 Agent 类型的工具访问权限：

- **ALL_AGENT_DISALLOWED_TOOLS**: 所有 Agent 禁止使用的工具（TaskOutputTool、ExitPlanModeTool、EnterPlanModeTool、AskUserQuestionTool、TaskStopTool；非 ant 用户还禁止 AgentTool）
- **ASYNC_AGENT_ALLOWED_TOOLS**: 异步 Agent 允许使用的工具集（FileRead/Edit/Write、Bash、WebSearch 等）
- **IN_PROCESS_TEAMMATE_ALLOWED_TOOLS**: 进程内队友 Agent 额外允许的工具（TaskCreate/Get/List/Update、SendMessage、以及 AGENT_TRIGGERS feature 下的 Cron 工具）
- **COORDINATOR_MODE_ALLOWED_TOOLS**: 协调器模式下仅允许 AgentTool、TaskStopTool、SendMessageTool、SyntheticOutputTool

---

## 3. 工具注册机制

工具通过 `buildTool()` 工厂函数创建并导出，然后在 `src/tools.ts` 中统一注册：

> 📍 **getTools 函数**: `src/tools.ts:271-344`  
> 📍 **assembleToolPool 函数**: `src/tools.ts:345-382`  
> 📍 **getMergedTools 函数**: `src/tools.ts:383+`

```typescript
// 工具定义示例（FileEditTool.ts）
export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 100_000,
  strict: true,
  // ... 其他配置
})
```

工具注册到系统后，通过 `ToolUseContext` 提供给查询引擎：

> 📍 **ToolUseContext 类型**: `src/Tool.ts:158-300`

```typescript
export type ToolUseContext = {
  options: {
    tools: Tools  // 可用工具列表
    // ... 其他选项
  }
  // ... 上下文方法
}
```

**补充发现（Q&A 学习）**：

- `getTools()` 在 `CLAUDE_CODE_SIMPLE` 模式下仅返回 `[BashTool, FileReadTool, FileEditTool]`（`src/tools.ts:272-306`）。
- `assembleToolPool()` 是将内置工具与 MCP 工具合并的单一来源（`src/tools.ts:345`），REPL.tsx（通过 `useMergedTools` hook）和 `runAgent.ts` 都使用此函数。
- `filterToolsByDenyRules()`（`src/tools.ts:262-270`）在工具注册时就过滤掉被 deny 规则完全封锁的工具，而不仅仅在调用时检查。
- `REPL_ONLY_TOOLS`（`src/tools.ts:148`）：当 REPL 模式启用时，这些原始工具对 Claude 隐藏，只能通过 REPL VM 内部访问。

---

## 4. 工具调用流程

完整的工具调用流程如下：

```
Claude API 返回 tool_use block
        ↓
解析 tool_use 参数
        ↓
查找对应 Tool 实现 (findToolByName)
        ↓
调用 validateInput() 验证输入
        ↓
调用 checkPermissions() 检查权限
        ↓
[如果需要] 显示权限确认对话框
        ↓
调用 tool.call() 执行工具
        ↓
工具执行中通过 onProgress 报告进度
        ↓
生成 ToolResult
        ↓
调用 mapToolResultToToolResultBlockParam 转换为 API 格式
        ↓
返回 tool_result block 给 Claude
```

> 📍 **findToolByName 函数**: `src/Tool.ts:358-360`  
> 📍 **toolMatchesName 函数**: `src/Tool.ts:348-353`（支持 aliases 查找）

### 并发控制

> 📍 **isConcurrencySafe 接口方法**: `src/Tool.ts:402`

工具通过 `isConcurrencySafe()` 方法声明是否支持并发执行：

- **并发安全**: `FileReadTool`、`GrepTool`、`GlobTool` 等只读工具
- **非并发安全**: `FileEditTool`、`FileWriteTool` 等写入工具默认返回 `false`

并发不安全的工具会阻塞后续工具调用，直到当前调用完成。

---

## 5. 工具权限控制

### 权限检查流程

1. **validateInput()**: 工具级输入验证（如检查文件是否存在）
2. **checkPermissions()**: 权限系统检查
3. **Hooks 检查**: PreToolUse hooks 可以拦截或修改工具调用
4. **用户确认**: 对于危险操作，显示权限对话框

### 权限模式

> 📍 **PermissionMode 类型**: `src/types/permissions.ts`  
> 📍 **ToolPermissionContext 类型**: `src/Tool.ts:123-138`  
> 📍 **getEmptyToolPermissionContext**: `src/Tool.ts:140-148`

`src/types/permissions.ts` 定义了多种权限模式：

- `default`: 默认模式，需要用户确认危险操作
- `plan`: 计划模式，批量确认
- `bypassPermissions`: 绕过权限检查
- `auto`: 自动模式，基于分类器自动决策

**补充发现（Q&A 学习）**：

- `shouldAvoidPermissionPrompts`（`src/Tool.ts:133`）：为 true 时，权限提示自动拒绝（用于无法显示 UI 的后台 agents）。
- `awaitAutomatedChecksBeforeDialog`（`src/Tool.ts:135`）：协调器工作进程使用，在显示权限对话框前先等待自动化检查（分类器、hooks）完成。
- `prePlanMode`（`src/Tool.ts:137`）：存储进入计划模式前的权限模式，以便退出时恢复。
- `strippedDangerousRules`（`src/Tool.ts:131`）：追踪被剥离的危险规则。

### 危险工具的特殊处理

BashTool 和文件写入类工具有额外的安全检查：

```typescript
// BashTool 的权限检查示例
async checkPermissions(input, context) {
  // 检查命令是否在允许列表中
  // 检查是��涉及敏感路径
  // 检查是否需要沙箱
  return bashToolHasPermission(input, context)
}
```

---

## 6. 工具输入验证

所有工具输入通过 Zod Schema 进行严格验证：

```typescript
// FileEditTool 输入 Schema
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z.string().describe('The text to replace it with'),
    replace_all: semanticBoolean(z.boolean().default(false).optional())
      .describe('Replace all occurrences of old_string'),
  }),
)
```

### 验证特性

- **strictObject**: 拒绝未声明的属性（通过 Zod v4 的 `z.strictObject`）
- **semanticBoolean/semanticNumber**: 支持自然语言输入（如 "true"、"yes"）
- **lazySchema**: 延迟初始化，避免循环依赖

> 📍 **ToolInputJSONSchema 类型**: `src/Tool.ts:15-21`（允许 MCP 工具直接使用 JSON Schema 而非 Zod 转换）  
> 📍 **ValidationResult 类型**: `src/Tool.ts:95-101`

---

## 7. 工具输出格式

工具输出通过 `mapToolResultToToolResultBlockParam` 转换为 Claude API 格式：

> 📍 **ToolResult 类型**: `src/Tool.ts:321-336`

```typescript
mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
  const { filePath, userModified, replaceAll } = data
  const modifiedNote = userModified
    ? '. The user modified your proposed changes before accepting them.'
    : ''

  if (replaceAll) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.`,
    }
  }
  // ...
}
```

**补充发现（Q&A 学习）**：

- `ToolResult.newMessages?`（`src/Tool.ts:323-328`）：工具可以注入额外消息（如 UserMessage、AssistantMessage），用于更新对话上下文。
- `ToolResult.contextModifier?`（`src/Tool.ts:330`）：仅对非并发安全工具生效，允许工具执行后修改 `ToolUseContext`（如添加新的 working directory）。
- `ToolResult.mcpMeta?`（`src/Tool.ts:332-335`）：传递 MCP 协议元数据（`structuredContent`、`_meta`）给 SDK 消费者。

### 输出大小控制

> 📍 **maxResultSizeChars 字段**: `src/Tool.ts:466`

- `maxResultSizeChars`: 定义工具结果大小上限
- 超过限制时，结果会被持久化到磁盘，Claude 收到的是预览和文件路径
- `FileReadTool` 的 `maxResultSizeChars = Infinity`（因为 Read 的输出已有自限制，持久化会导致循环 Read→file→Read）

---

## 8. 文件编辑工具深析

`FileEditTool` 是最复杂的工具之一，实现了原子性文件编辑：

### 核心特性

1. **原子写入**: 使用 `writeTextContent` 确保写入的原子性
2. **冲突检测**: 通过 `readFileState` 跟踪文件修改时间，防止覆盖用户修改
3. **Git 集成**: 支持生成 Git diff 用于远程会话
4. **LSP 通知**: 编辑后自动通知 LSP 服务器

### 编辑流程

```typescript
async call(input, context) {
  // 1. 发现 Skill（异步，不阻塞）
  const newSkillDirs = await discoverSkillDirsForPaths([absoluteFilePath], cwd)
  
  // 2. 读取当前文件状态
  const { content: originalFileContents, encoding, lineEndings } = readFileForEdit(absoluteFilePath)
  
  // 3. 检查文件是否被外部修改
  const lastWriteTime = getFileModificationTime(absoluteFilePath)
  if (lastWriteTime > lastRead.timestamp) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }
  
  // 4. 应用编辑
  const { patch, updatedFile } = getPatchForEdit({...})
  
  // 5. 原子写入
  writeTextContent(absoluteFilePath, updatedFile, encoding, lineEndings)
  
  // 6. 通知 LSP
  lspManager.changeFile(absoluteFilePath, updatedFile)
  lspManager.saveFile(absoluteFilePath)
  
  // 7. 更新读取状态
  readFileState.set(absoluteFilePath, { content: updatedFile, timestamp: ... })
}
```

### 引号风格保持

`preserveQuoteStyle` 函数确保编辑时保持文件的引号风格（直引号 vs 弯引号）。

---

## 9. Bash 工具特性

`BashTool` 是最强大的工具，也是最需要安全控制的工具：

### 超时处理

```typescript
const getDefaultTimeoutMs = () => getDefaultBashTimeoutMs()  // 默认 2 分钟
const getMaxTimeoutMs = () => getMaxBashTimeoutMs()          // 最大 10 分钟
```

### 输出截断

- 使用 `EndTruncatingAccumulator` 处理大输出
- 超过 `maxResultSizeChars` (30K) 时持久化到磁盘

### 后台任务

支持 `run_in_background` 参数将命令转为后台任务：

```typescript
if (input.run_in_background) {
  const taskId = await spawnShellTask(...)
  return { data: { backgroundTaskId: taskId, ... } }
}
```

### 命令分类

> 📍 **isSearchOrReadCommand 接口**: `src/Tool.ts:429-433`（BashTool 通过 `isSearchOrReadBashCommand` 实现）

BashTool 通过 `isSearchOrReadBashCommand` 识别命令类型，用于 UI 折叠：

- **搜索命令**: grep、find、rg、ag 等
- **读取命令**: cat、head、tail、less 等
- **列表命令**: ls、tree、du 等

### 沙箱支持

当启用沙箱模式时，BashTool 通过 `SandboxManager` 限制命令的文件系统和网络访问。

---

## 10. 工具并发

### 并发模型

Claude Code 支持工具并发执行，但有以下限制：

1. **并发安全工具**: 可以同时执行多个
2. **非并发安全工具**: 串行执行
3. **混合调用**: 并发安全工具可以与非并发安全工具同时运行

### 实现机制

```typescript
// Tool 接口定义
isConcurrencySafe(input: z.infer<Input>): boolean

// 示例：FileReadTool 始终并发安全
isConcurrencySafe() {
  return true
}

// 示例：FileEditTool 默认不安全
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false
}
```

### 并行工具调用

Claude 可以在单个响应中请求多个工具调用：

```typescript
// 用户消息示例：
"运行 git status 和 git diff"

// Claude 可以同时调用：
// 1. BashTool { command: "git status" }
// 2. BashTool { command: "git diff" }
```

这些调用是独立的，可以并行执行，结果分别返回。

---

## 11. ToolSearchTool（延迟加载）

> 📍 **shouldDefer 字段**: `src/Tool.ts:442`  
> 📍 **alwaysLoad 字段**: `src/Tool.ts:449`

**补充发现（Q&A 学习）**：

`ToolSearchTool` 实现了工具的延迟加载（deferred loading）机制：
- 当 `shouldDefer: true` 时，工具的完整 schema 不出现在初始 prompt 中（节省 token）
- 模型看到的只是 `ToolSearchTool` 的 schema，通过关键词搜索找到需要的工具
- `alwaysLoad: true` 的工具即使 ToolSearch 启用也始终出现在 initial prompt
- `searchHint` 字段提供关键词匹配用的提示短语（3-10 个词，非工具名中已有的词）

---

## 总结

Claude Code 的工具系统设计体现了以下核心原则：

1. **类型安全**: 完整的 TypeScript 泛型支持，编译时保证工具定义的正确性
   > 📍 `src/Tool.ts:362-695`（Tool 接口）
2. **安全第一**: fail-closed 默认值、多层权限检查、输入验证
   > 📍 `src/Tool.ts:757-769`（TOOL_DEFAULTS）
3. **原子操作**: 文件编辑等关键操作保证原子性
4. **可扩展性**: 通过 MCP 协议支持外部工具，通过 Skill 系统支持自定义工作流
5. **用户体验**: 丰富的 UI 渲染、进度报告、错误处理
   > 📍 `src/Tool.ts:605-695`（渲染方法）

工具系统是 Claude Code 能够安全、高效地执行复杂软件工程任务的基础架构。

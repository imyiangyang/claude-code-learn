# QueryEngine 与 Query 管道

## 概述

QueryEngine 是 Claude Code 的核心组件，负责协调 UI、Claude API 和工具系统之间的交互。它管理对话状态、处理流式响应、执行工具调用循环，并优化提示缓存以降低成本。

---

## 1. QueryEngine 定位

QueryEngine 是 Claude Code 的**中央协调器**，位于 `src/QueryEngine.ts`（约 1295 行）。它的主要职责包括：

- 管理对话生命周期和会话状态
- 处理用户输入并生成 API 请求
- 协调工具调用和结果处理
- 跟踪 token 使用量和成本
- 处理错误重试和降级策略

> 📍 **源码位置**: `src/QueryEngine.ts:184-207`

```typescript
// QueryEngine 的核心定位
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
  // ...
}
```

QueryEngine 被设计为**每个对话一个实例**，通过 `submitMessage()` 方法启动新的对话轮次，状态（消息、文件缓存、使用量等）在轮次之间保持持久化。

> 📍 **submitMessage 定义**: `src/QueryEngine.ts:209-212`
>
> ```typescript
> async *submitMessage(
>   prompt: string | ContentBlockParam[],
>   options?: { uuid?: string; isMeta?: boolean },
> ): AsyncGenerator<SDKMessage, void, unknown>
> ```

**补充发现（Q&A 学习）**：

1. `discoveredSkillNames` 在每次 `submitMessage()` 调用时清空（`src/QueryEngine.ts:238`），跨轮次追踪技能发现用于分析事件 `was_discovered`，但不跨轮次持久化。
2. `loadedNestedMemoryPaths` 跨轮次持久化（不在 `submitMessage` 里重置），确保已加载的嵌套 MEMORY.md 不被重复加载。
3. `QueryEngine` 同时处理 SDK/headless 模式与 REPL 模式，通过构造器注入的 `initialMessages` 来恢复会话。

---

## 2. 核心状态机

QueryEngine 通过复杂的状态机管理对话流程：

### 2.1 消息状态

> 📍 **Message 联合类型定义**: `src/Tool.ts:31-40`（从 `./types/message.js` 导入）

```typescript
// 消息类型的联合类型（从 src/utils/messages.ts:41-60 可见完整导入）
export type Message =
  | AssistantMessage      // AI 助手消息
  | UserMessage          // 用户消息
  | SystemMessage        // 系统消息
  | ProgressMessage      // 进度消息
  | AttachmentMessage    // 附件消息
  | StreamEvent          // 流式事件
  | TombstoneMessage     // 墓碑消息（用于删除）
```

### 2.2 状态转换流程

```
用户输入 → processUserInput() → 构建消息 → API 请求
                                    ↓
                              流式响应处理
                                    ↓
                    工具调用? → 执行工具 → 注入结果 → 继续
                                    ↓
                              无工具调用 → 完成响应
```

> 📍 **processUserInput 调用**: `src/QueryEngine.ts:410-428`

### 2.3 Query 循环状态（query.ts）

> 📍 **State 类型定义**: `src/query.ts:204-217`

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

**补充发现（Q&A 学习）**：

- `transition` 字段记录上一次迭代继续的原因（undefined 代表第一次迭代），允许测试断言恢复路径触发而无需检查消息内容。
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`（`src/query.ts:164`）：最多重试 3 次以恢复 max_output_tokens 错误。
- `budgetTracker` 由 `feature('TOKEN_BUDGET')` 门控（`src/query.ts:280`）。

---

## 3. Streaming 处理

QueryEngine 使用**逐 token 处理**机制来实时展示 AI 响应：

### 3.1 流式事件类型

> 📍 **query 函数定义**: `src/query.ts:219-239`  
> 📍 **queryLoop 主循环**: `src/query.ts:241-307`（主 while 循环从 `src/query.ts:307` 开始）

```typescript
// 流式事件处理
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  // ...
})) {
  // 处理不同类型的消息
  switch (message.type) {
    case 'assistant':
      // 处理助手消息
      break
    case 'stream_event':
      // 处理流式事件
      if (message.event.type === 'message_start') {
        currentMessageUsage = updateUsage(currentMessageUsage, message.event.message.usage)
      }
      if (message.event.type === 'message_delta') {
        currentMessageUsage = updateUsage(currentMessageUsage, message.event.usage)
      }
      break
  }
}
```

### 3.2 Token 使用量跟踪

> 📍 **currentMessageUsage 初始化**: `src/QueryEngine.ts:658`  
> 📍 **accumulateUsage 导入**: `src/QueryEngine.ts:17`（来自 `src/services/api/claude.js`）

```typescript
// 跟踪当前消息的使用量
let currentMessageUsage: NonNullableUsage = EMPTY_USAGE

// message_start 时重置
if (message.event.type === 'message_start') {
  currentMessageUsage = EMPTY_USAGE
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.message.usage)
}

// message_delta 时累加
if (message.event.type === 'message_delta') {
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.usage)
}

// message_stop 时汇总到总量
if (message.event.type === 'message_stop') {
  this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
}
```

**补充发现（Q&A 学习）**：

- 流式响应在进入 `query()` 之前，还经过了 `applyToolResultBudget()`（`src/query.ts:379-394`）对工具结果大小进行预处理，超预算内容被替换（通过 `contentReplacementState` 跟踪）。
- `stream_request_start` 事件在每次循环迭代最开始就 yield（`src/query.ts:337`），通知上层开始新一轮 API 请求。

---

## 4. 工具调用循环

QueryEngine 实现了完整的 **Agentic 循环**：

### 4.1 循环流程

```
1. 发送消息到 Claude API
2. 接收流式响应
3. 检测到 tool_use 块
4. 暂停响应展示
5. 执行工具（可能需要用户确认）
6. 将 tool_result 注入对话
7. 继续 API 请求
8. 重复直到无工具调用
```

> 📍 **工具调用主循环**: `src/query.ts:307-1700`（整个 while(true) 循环体）  
> 📍 **runTools 导入**: `src/query.ts:98`（来自 `./services/tools/toolOrchestration.js`）

### 4.2 代码实现

```typescript
// query.ts 中的工具调用循环
const assistantMessages: AssistantMessage[] = []
const toolResults: (UserMessage | AttachmentMessage)[] = []
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false

for await (const message of deps.callModel({...})) {
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    
    // 提取 tool_use 块
    const msgToolUseBlocks = message.message.content.filter(
      content => content.type === 'tool_use'
    ) as ToolUseBlock[]
    
    if (msgToolUseBlocks.length > 0) {
      toolUseBlocks.push(...msgToolUseBlocks)
      needsFollowUp = true  // 需要继续循环
    }
  }
}

// 如果有工具调用，执行工具并继续
if (needsFollowUp) {
  const toolUpdates = streamingToolExecutor
    ? streamingToolExecutor.getRemainingResults()
    : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
  
  for await (const update of toolUpdates) {
    if (update.message) {
      toolResults.push(update.message)
    }
  }
  
  // 继续下一轮
  continue
}
```

### 4.3 Streaming Tool Execution

> 📍 **StreamingToolExecutor 导入**: `src/query.ts:96`  
> 📍 **useStreamingToolExecution 初始化**: `src/query.ts:561`（由 `config.gates.streamingToolExecution` 控制）  
> 📍 **streamingToolExecutor 实例化**: `src/query.ts:562-565`  
> 📍 **addTool 调用**: `src/query.ts:838-842`  
> 📍 **getCompletedResults 调用**: `src/query.ts:848-856`

```typescript
// 流式工具执行器
const streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null

// 在流式响应中实时添加工具
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)
  }
}

// 获取已完成的工���结果
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      yield result.message
      toolResults.push(result.message)
    }
  }
}
```

**补充发现（Q&A 学习）**：

- `StreamingToolExecutor` 在发生 fallback 或 max_output_tokens 恢复时，会被 discard 然后重新创建（`src/query.ts:733-735` 和 `src/query.ts:912-914`），确保状态干净。
- 所有工具执行结束后的工具结果汇总（getRemainingResults）发生在 `src/query.ts:1380-1381`。

---

## 5. SYSTEM_PROMPT_DYNAMIC_BOUNDARY

### 5.1 什么是动态边界

> 📍 **SYSTEM_PROMPT_DYNAMIC_BOUNDARY 定义**: `src/constants/prompts.ts:114-115`

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 是一个特殊的分隔符，用于将系统提示词分为**静态部分**和**动态部分**：

```typescript
// src/constants/prompts.ts:114-115
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

### 5.2 为什么需要这个边界

**提示缓存（Prompt Caching）** 是 Claude API 的一项重要优化功能：

- **静态内容**：跨会话不变的内容（如系统指令、工具定义）
- **动态内容**：随会话变化的内容（如当前工作目录、Git 状态、MCP 服务器指令）

通过将系统提示词分割，静态部分可以使用 `cache_scope: 'global'` 进行全局缓存，而动态部分则不缓存或仅使用组织级缓存。

### 5.3 成本优化原理

> 📍 **splitSysPromptPrefix 函数**: `src/utils/api.ts:321`  
> 📍 **边界注入位置**: `src/constants/prompts.ts:573`（`shouldUseGlobalCacheScope()` 条件下）  
> 📍 **边界跳过逻辑**: `src/utils/api.ts:338` 和 `src/utils/api.ts:364`

```typescript
// src/utils/api.ts - splitSysPromptPrefix 函数
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  
  if (useGlobalCacheFeature) {
    const boundaryIndex = systemPrompt.findIndex(
      s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    )
    
    if (boundaryIndex !== -1) {
      // 分割静态和动态内容
      const staticBlocks: string[] = []
      const dynamicBlocks: string[] = []
      
      for (let i = 0; i < systemPrompt.length; i++) {
        const block = systemPrompt[i]
        if (i < boundaryIndex) {
          staticBlocks.push(block)   // 全局缓存
        } else {
          dynamicBlocks.push(block)  // 不缓存
        }
      }
      
      return [
        { text: staticJoined, cacheScope: 'global' },   // 跨会话缓存
        { text: dynamicJoined, cacheScope: null },      // 不缓存
      ]
    }
  }
}
```

### 5.4 成本节省效果

- **全局缓存**：静态系统提示词（约 50-70K tokens）只需在首次请求时计算
- **后续请求**：直接从缓存读取，节省约 **90%** 的输入 token 成本
- **动态内容**：仅包含会话特定的信息，通常只有几百 tokens

**补充发现（Q&A 学习）**：

- `analyzeContext.ts` 中也引用此常量（`src/utils/analyzeContext.ts:5`），用于在上下文分析时跳过边界标记（`src/utils/analyzeContext.ts:287`）。
- Betas 常量中的 `PROMPT_CACHING_SCOPE_BETA_HEADER = 'prompt-caching-scope-2026-01-05'`（`src/constants/betas.ts:17-18`）控制全局缓存范围的 API 启用。

---

## 6. 错误处理与重试

### 6.1 错误分类

> 📍 **categorizeRetryableAPIError**: `src/services/api/errors.ts:1163`

```typescript
// src/services/api/errors.ts:1163
export function categorizeRetryableAPIError(error: APIError): string {
  const status = error.status
  const code = (error as unknown as { code?: string }).code
  
  if (status === 429) return 'rate_limit'
  if (status === 413) return 'prompt_too_long'
  if (status === 529) return 'overloaded'
  if (code === 'idempotency_key_reuse') return 'idempotency_error'
  return 'unknown'
}
```

### 6.2 重试机制

> 📍 **FallbackTriggeredError 类**: `src/services/api/withRetry.ts:160-167`  
> 📍 **withRetry 函数**: `src/services/api/withRetry.ts:170`

```typescript
// src/services/api/withRetry.ts
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemMessage, T> {
  let attempt = 0
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  
  while (true) {
    try {
      const result = await operation(client, attempt, context)
      return result
    } catch (error) {
      // 处理特定错误类型
      if (error instanceof APIUserAbortError) throw error
      
      // 529 错误特殊处理（服务器过载）
      if (is529Error(error)) {
        consecutive529Errors++
        const delay = calculate529BackoffDelay(consecutive529Errors)
        yield createRetryMessage(attempt, maxRetries, delay)
        await sleep(delay)
        continue
      }
      
      // 模型降级
      if (error instanceof FallbackTriggeredError && fallbackModel) {
        throw error  // 在调用方处理降级
      }
      
      attempt++
      if (attempt >= maxRetries) throw error
    }
  }
}
```

### 6.3 模型降级（Fallback）

> 📍 **FallbackTriggeredError throw**: `src/services/api/withRetry.ts:347`

当主模型（如 Claude Opus）不可用时，自动降级到备用模型：

```typescript
try {
  for await (const message of deps.callModel({...})) {
    // 处理流式响应
  }
} catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    // 切换到备用模型并重试
    currentModel = fallbackModel
    attemptWithFallback = true
    
    // 清除之前的消息状态
    assistantMessages.length = 0
    toolResults.length = 0
    toolUseBlocks.length = 0
    
    // 记录降级事件
    logEvent('tengu_model_fallback_triggered', {
      original_model: innerError.originalModel,
      fallback_model: fallbackModel,
    })
    
    continue  // 重试
  }
  throw innerError
}
```

---

## 7. 上下文窗口管理

### 7.1 Token 使用量跟踪

> 📍 **totalUsage 初始化**: `src/QueryEngine.ts:189`（`private totalUsage: NonNullableUsage`）  
> 📍 **EMPTY_USAGE 导入**: `src/QueryEngine.ts:19`（来自 `src/services/api/logging.js`）

```typescript
// 跟踪总使用量
private totalUsage: NonNullableUsage = EMPTY_USAGE

// 更新使用量
this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)

// 检查预算限制
if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
  yield {
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    errors: [`Reached maximum budget ($${maxBudgetUsd})`],
  }
  return
}
```

### 7.2 自动压缩（Auto Compact）

> 📍 **autocompact 调用**: `src/query.ts:454-467`  
> 📍 **buildPostCompactMessages**: `src/query.ts:528`（导入自 `./services/compact/compact.js`）

当上下文接近限制时，自动触发压缩：

```typescript
// query.ts 中的自动压缩逻辑
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages: messagesForQuery,
  },
  querySource,
  tracking,
  snipTokensFreed,
)

if (compactionResult) {
  // 使用压缩后的消息继续
  const postCompactMessages = buildPostCompactMessages(compactionResult)
  messagesForQuery = postCompactMessages
}
```

### 7.3 压缩边界

```typescript
// 压缩边界消息
yield {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: getSessionId(),
  uuid: message.uuid,
  compact_metadata: toSDKCompactMetadata(message.compactMetadata),
}

// 释放压缩前的消息以进行垃圾回收
const mutableBoundaryIdx = this.mutableMessages.length - 1
if (mutableBoundaryIdx > 0) {
  this.mutableMessages.splice(0, mutableBoundaryIdx)
}
```

**补充发现（Q&A 学习）**：

- `HISTORY_SNIP` feature flag 控制另一种轻量压缩（snip）策略：`snipModule.snipCompactIfNeeded()`（`src/query.ts:401-410`），在 autocompact 之前运行，释放的 tokens 数 (`snipTokensFreed`) 传给 autocompact 的阈值判断。
- `REACTIVE_COMPACT` 和 `CONTEXT_COLLAPSE` 是两个额外的上下文管理策略，均通过 feature flag 门控（`src/query.ts:15-20`）。
- `taskBudgetRemaining` 在每次 compact 后被更新，确保 task_budget 在 server 端有正确的 remaining 值（`src/query.ts:511-514`）。

---

## 8. Abort/Cancel 机制

### 8.1 AbortController 使用

> 📍 **interrupt 方法**: `src/QueryEngine.ts:1158-1159`  
> 📍 **abortController 初始化**: `src/QueryEngine.ts:203`  
> 📍 **createAbortController 导入**: `src/QueryEngine.ts:44`

```typescript
export class QueryEngine {
  private abortController: AbortController
  
  constructor(config: QueryEngineConfig) {
    this.abortController = config.abortController ?? createAbortController()
  }
  
  interrupt(): void {
    this.abortController.abort()
  }
}
```

### 8.2 流式中断处理

> 📍 **aborted_streaming 返回**: `src/query.ts:1051`

```typescript
// 检查是否已中止
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    // 消费剩余结果，生成合成 tool_result
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) {
        yield update.message
      }
    }
  } else {
    // 生成中断消息
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Interrupted by user',
    )
  }
  
  yield createUserInterruptionMessage({ toolUse: true })
  return { reason: 'aborted_streaming' }
}
```

> 📍 **yieldMissingToolResultBlocks**: `src/query.ts:123-149`

### 8.3 工具执行中断

> 📍 **aborted_tools 返回**: `src/query.ts:1515`

```typescript
// 工具执行期间的中断检查
if (toolUseContext.abortController.signal.aborted) {
  // Chicago MCP: 清理计算机使用状态
  if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
    try {
      const { cleanupComputerUseAfterTurn } = await import(
        './utils/computerUse/cleanup.js'
      )
      await cleanupComputerUseAfterTurn(toolUseContext)
    } catch {
      // 静默失败
    }
  }
  
  return { reason: 'aborted_tools' }
}
```

---

## 9. 关键数据类型

### 9.1 核心消息类型

> 📍 **消息类型来源**: `src/utils/messages.ts:40-60`（通过 `./types/message.js` 导入后再导出）

```typescript
// 助手消息
export type AssistantMessage = {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: Array<TextBlock | ToolUseBlock | ThinkingBlock | ...>
    usage?: Usage
    stop_reason?: string
    stop_sequence?: string
  }
  uuid: string
  requestId?: string
  timestamp: number
  isApiErrorMessage?: boolean
}

// 用户消息
export type UserMessage = {
  type: 'user'
  message: {
    role: 'user'
    content: string | Array<TextBlockParam | ToolResultBlockParam | ...>
  }
  uuid: string
  timestamp: number
  isMeta?: boolean
  toolUseResult?: string
}

// 流式事件
export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
}
```

### 9.2 工具相关类型

```typescript
// 工具使用块
export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

// 工具结果块
export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<TextBlockParam | ImageBlockParam>
  is_error?: boolean
}
```

### 9.3 QueryEngine 配置

> 📍 **QueryEngineConfig 类型**: `src/QueryEngine.ts:130-173`

```typescript
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  abortController?: AbortController
  // ...
  snipReplay?: (           // SDK only: HISTORY_SNIP 截断消息回放处理器
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}
```

**补充发现（Q&A 学习）**：

- `snipReplay` 是 SDK 专属配置（`src/QueryEngine.ts:169-172`）：HISTORY_SNIP 启用时由 `ask()` 注入，用于 SDK 模式下内存边界截断（REPL 模式保留完整历史用于滚动显示）。
- `orphanedPermission` 允许恢复之前中断的权限请求（`src/QueryEngine.ts:157`），仅处理一次（`hasHandledOrphanedPermission` 标志位，`src/QueryEngine.ts:190`）。
- `replayUserMessages` 控制是否将用户消息重播给 SDK 调用方（`src/QueryEngine.ts:231`）。

---

## 10. 与 Claude API 的通信

### 10.1 Beta Headers

> 📍 **所有 Beta Header 定义**: `src/constants/betas.ts:1-52`

```typescript
// src/constants/betas.ts
export const TASK_BUDGETS_BETA_HEADER = 'task-budgets-2026-03-13'          // 行 16
export const TOKEN_EFFICIENT_TOOLS_BETA_HEADER = 'token-efficient-tools-2026-03-28'  // 行 21-22
export const CLAUDE_CODE_20250219_BETA_HEADER = 'claude-code-20250219'     // 行 3
export const INTERLEAVED_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14'    // 行 4-5
export const CONTEXT_1M_BETA_HEADER = 'context-1m-2025-08-07'             // 行 6
export const STRUCTURED_OUTPUTS_BETA_HEADER = 'structured-outputs-2025-12-15'  // 行 8
export const EFFORT_BETA_HEADER = 'effort-2025-11-24'                     // 行 15
export const FAST_MODE_BETA_HEADER = 'fast-mode-2026-02-01'               // 行 19
export const REDACT_THINKING_BETA_HEADER = 'redact-thinking-2026-02-12'   // 行 20
export const PROMPT_CACHING_SCOPE_BETA_HEADER = 'prompt-caching-scope-2026-01-05' // 行 17-18
export const WEB_SEARCH_BETA_HEADER = 'web-search-2025-03-05'            // 行 9
export const TOOL_SEARCH_BETA_HEADER_1P = 'advanced-tool-use-2025-11-20'  // 行 13
export const TOOL_SEARCH_BETA_HEADER_3P = 'tool-search-tool-2025-10-19'   // 行 14
```

**补充发现（Q&A 学习）**：

- Bedrock 仅支持有限数量的 beta headers，部分需通过 `extraBodyParams` 而非 header 传递（`src/constants/betas.ts:38-42`，`BEDROCK_EXTRA_PARAMS_HEADERS` 集合）。
- `VERTEX_COUNT_TOKENS_ALLOWED_BETAS` 限制了 Vertex `countTokens` API 允许的 beta 列表（`src/constants/betas.ts:48-52`）。
- `CLI_INTERNAL_BETA_HEADER` 仅 `USER_TYPE === 'ant'`（Anthropic 内部用户）时启用（`src/constants/betas.ts:29-30`）。
- `AFK_MODE_BETA_HEADER` 和 `SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER` 通过 `feature()` 门控（`src/constants/betas.ts:23-28`）。

### 10.2 Beta 控制逻辑

```typescript
// src/utils/betas.ts
export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  
  // 基础 beta header
  if (!isHaiku) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
  }
  
  // 1M 上下文支持
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  
  // 交错思考模式
  if (modelSupportsISP(model)) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }
  
  // Token 高效工具（约 4.5% 输出 token 减少）
  if (tokenEfficientToolsEnabled) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }
  
  // 任务预算
  if (params.taskBudget) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
  
  return betaHeaders
})
```

### 10.3 请求格式

> 📍 **queryModel 函数**: `src/services/api/claude.ts`  
> 📍 **anthropic.beta.messages.create 调用**: `src/services/api/claude.ts`

```typescript
// src/services/api/claude.ts
async function* queryModel(...) {
  const betas = getMergedBetas(options.model, { isAgenticQuery })
  
  // 构建工具 schema
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )
  
  // 构建系统提示词块
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  
  // 发送请求
  const stream = await anthropic.beta.messages.create({
    model,
    max_tokens: maxOutputTokens,
    messages: messagesForAPI,
    system,
    tools: allTools,
    ...(useBetas && { betas }),
    ...getExtraBodyParams(betas),
    metadata: getAPIMetadata(),
  })
  
  // 处理流式响应
  for await (const event of stream) {
    yield* handleStreamEvent(event, ...)
  }
}
```

### 10.4 流式事件处理

```typescript
// 处理不同类型的流式事件
async function* handleStreamEvent(
  event: BetaRawMessageStreamEvent,
  ...
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  switch (event.type) {
    case 'message_start':
      yield { type: 'stream_event', event }
      break
      
    case 'content_block_start':
      yield { type: 'stream_event', event }
      break
      
    case 'content_block_delta':
      yield { type: 'stream_event', event }
      break
      
    case 'content_block_stop':
      yield { type: 'stream_event', event }
      break
      
    case 'message_delta':
      yield { type: 'stream_event', event }
      break
      
    case 'message_stop':
      yield { type: 'stream_event', event }
      break
  }
}
```

---

## 11. 会话持久化与 Transcript

> 📍 **recordTranscript 调用**: `src/QueryEngine.ts:451-462`（用户消息发送后立即记录）  
> 📍 **flushSessionStorage 条件调用**: `src/QueryEngine.ts:457-461`（`CLAUDE_CODE_EAGER_FLUSH` 或 `CLAUDE_CODE_IS_COWORK` 环境变量控制）

**补充发现（Q&A 学习）**：

用户消息在进入 API 请求之前就被写入 transcript（`src/QueryEngine.ts:436-463`），这解决了以下问题：
- 如果在 API 响应返回前进程被终止，transcript 依然包含用户消息，`--resume` 功能可以正常恢复
- bare 模式 (`isBareMode()`) 下写入是 fire-and-forget（非阻塞），避免增加 critical path 延迟

---

## 总结

QueryEngine 和 Query 管道构成了 Claude Code 的核心 AI 交互层：

1. **QueryEngine** 作为中央协调器，管理对话状态、工具调用和错误恢复
   > 📍 `src/QueryEngine.ts:184-1295`
2. **Query 管道** 实现了完整的 agentic 循环，支持流式响应和工具执行
   > 📍 `src/query.ts:219-1729`
3. **SYSTEM_PROMPT_DYNAMIC_BOUNDARY** 优化了提示缓存，显著降低成本
   > 📍 `src/constants/prompts.ts:114-115`
4. **健壮的错误处理** 包括重试、降级和压缩恢复机制
   > 📍 `src/services/api/withRetry.ts:160-347`
5. **Beta headers** 控制实验性功能的启用，如 task budgets 和 token-efficient tools
   > 📍 `src/constants/betas.ts:1-52`

这个架构使得 Claude Code 能够高效、可靠地与 Claude API 交互，同时提供丰富的功能如工具调用、上下文管理和成本优化。

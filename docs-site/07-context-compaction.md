# 上下文压缩系统 (Context Compaction)

> 📍 **核心源码位置**:
> - `src/services/compact/autoCompact.ts` — 自动压缩触发逻辑（351行）
> - `src/services/compact/compact.ts` — 核心压缩算法（1705行）
> - `src/services/compact/prompt.ts` — 压缩 prompt 构建（374行）
> - `src/services/compact/microCompact.ts` — 微压缩（530行）
> - `src/services/compact/sessionMemoryCompact.ts` — Session Memory 压缩（630行）
> - `src/services/compact/postCompactCleanup.ts` — 压缩后清理（77行）

## 1. 为什么需要上下文压缩

Claude Code 是一个基于大型语言模型的对话式编程助手。随着对话轮次的增加，上下文窗口中的消息会不断累积，带来两个核心问题：

- **上下文窗口限制**: Claude 模型有固定的上下文窗口大小（如 200K tokens）。当对话历史超过这个限制时，API 会返回 `prompt_too_long` 错误，导致请求失败。

- **成本问题**: 长对话意味着每次 API 调用都要处理大量 tokens，这会显著增加 API 成本。对于需要多轮迭代的复杂编程任务，成本累积尤为明显。

上下文压缩系统通过智能地总结和截断历史对话，在保留关键信息的同时减少 token 使用量，从而解决上述问题。

## 2. 压缩触发条件

自动压缩（Auto-Compact）在以下条件下触发：

### Token 阈值

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:62-65`

```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
```

系统会预留 13,000 tokens 的缓冲空间。当当前 token 使用量超过 `有效上下文窗口 - 13,000` 时，自动压缩就会启动。

### 有效上下文窗口计算

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:33-49`

```typescript
// MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000（基于 compact summary p99.99 = 17,387 tokens）
function getEffectiveContextWindowSize(model): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY  // = 20_000
  )
  return contextWindow - reservedTokensForSummary
}
```

**补充发现（Q&A 学习）**：可通过 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量限制 contextWindow 上限（测试用途）。

### 警告阈值

- **警告阈值**: 当剩余 tokens 少于 20,000 时，系统会显示警告提示
- **错误阈值**: 当剩余 tokens 少于 20,000 时，显示更严重的错误提示
- **阻塞限制**: 当达到 `有效窗口 - 3,000` 时，会阻塞新的请求直到压缩完成

**补充发现（Q&A 学习）**：`isAtBlockingLimit` 计算（`src/services/compact/autoCompact.ts:122-136`）：`blockingLimit = effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS(3_000)`，可通过 `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` 环境变量覆盖（测试用途）。

### 手动触发

用户可以随时通过 `/compact` 命令手动触发压缩，手动压缩的缓冲阈值更低（3,000 tokens），允许在更接近极限时进行压缩。

### isAutoCompactEnabled() 检查顺序

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:147-158`

三层检查依次执行（任一返回 false 则禁用自动压缩）：
1. `DISABLE_COMPACT` 环境变量 → 完全禁用（手动 /compact 也禁用）
2. `DISABLE_AUTO_COMPACT` 环境变量 → 只禁用自动（手动 /compact 仍可用）
3. `userConfig.autoCompactEnabled`（全局配置开关）

## 3. 压缩算法

### 核心压缩流程

`compactConversation` 函数实现了主要的压缩逻辑：

> 📍 **源码位置**: `src/services/compact/compact.ts`（整体函数）

1. **预处理**: 执行 PreCompact hooks，允许外部系统注入自定义指令
2. **内容清理**: 
   - 使用 `stripImagesFromMessages` 移除图片内容（替换为 `[image]` 标记，同时处理 tool_result 中嵌套的图片/文档）
   - 使用 `stripReinjectedAttachments` 移除会被重新注入的附件类型（`skill_discovery`/`skill_listing`，`EXPERIMENTAL_SKILL_SEARCH` gate 下）
3. **生成摘要**: 调用独立的 forked agent 来生成对话摘要
4. **后处理**: 
   - 创建压缩边界标记（compact boundary message）
   - 重新注入必要的附件（如最近读取的文件、技能信息等）
   - 执行 PostCompact hooks

### 摘要生成

压缩使用一个专门的子代理来生成摘要：

> 📍 **源码位置**: `src/services/compact/compact.ts:451-491`（PTL 重试循环）

```typescript
const compactPrompt = getCompactPrompt(customInstructions)
const summaryRequest = createUserMessage({
  content: compactPrompt,
})
```

摘要生成支持两种模式：
- **Cache Sharing 模式**: 复用主对话的 prompt cache，提高缓存命中率（默认启用，`tengu_compact_cache_prefix` gate）
- **普通流式模式**: 独立的 API 调用，不共享缓存

**补充发现（Q&A 学习）** �� `NO_TOOLS_PREAMBLE`（`src/services/compact/prompt.ts:19-26`）：

cache-sharing fork path 继承父代完整工具集（为保证 cache-key 匹配），但 Sonnet 4.6+ adaptive-thinking 模型偶尔会发起工具调用。由于 `maxTurns: 1`，被拒绝的工具调用 = 无文本输出 → 退回 streaming fallback（在 4.6 上概率 2.79%，4.5 上仅 0.01%）。`NO_TOOLS_PREAMBLE` 被放在 prompt **最前面**并明确说明后果：

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
```

### 错误处理与重试

当压缩请求本身遇到 `prompt_too_long` 错误时，系统会执行 `truncateHeadForPTLRetry`：

> 📍 **源码位置**: `src/services/compact/compact.ts:227-248`

```typescript
const MAX_PTL_RETRIES = 3
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'
```

**工作原理**：
1. 丢弃最旧的 API-round groups 直到覆盖 tokenGap
2. 无法解析 gap 时（Vertex/Bedrock 某些错误格式）丢弃 20% 的 groups
3. 每次重试在消息头部添加 `PTL_RETRY_MARKER`（下次重试先剥离，防止成为独立 group 导致进度停滞）
4. 最多重试 3 次，仍失败则抛出 `ERROR_MESSAGE_PROMPT_TOO_LONG`

## 4. AutoCompact 机制

`autoCompactIfNeeded` 是自动压缩的核心入口，它在每次用户输入后检查是否需要压缩。

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:241-351`

### 防递归保护

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:170-183`

```typescript
if (querySource === 'session_memory' || querySource === 'compact') {
  return false
}
```

防止在子代理（如 session_memory 或 compact 本身）中触发自动压缩，避免死锁。

**补充发现（Q&A 学习）** — `marble_origami` 特殊处理（`src/services/compact/autoCompact.ts:176-183`）：

在 `CONTEXT_COLLAPSE` feature gate 下，`querySource === 'marble_origami'`（context-collapse agent）时也返回 false。原因：若 marble_origami 触发 autocompact，`runPostCompactCleanup` 会调用 `resetContextCollapse()`，破坏**主线程**的 committed log（模块级共享状态跨 fork 共享）。

### 压缩优先级

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:287-310`

1. **Session Memory 压缩**: 首先尝试使用 session memory 进行压缩（如果用户没有提供自定义指令）
2. **传统压缩**: 如果 session memory 不可用，则使用传统的摘要压缩

### 压缩后的清理

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:298` → `src/services/compact/postCompactCleanup.ts`

```typescript
runPostCompactCleanup(querySource)
```

**清理内容**（`src/services/compact/postCompactCleanup.ts:31-77`）：

| 清理项 | 条件 |
|--------|------|
| `resetMicrocompactState()` | 总是 |
| `resetContextCollapse()` | 主线程 + CONTEXT_COLLAPSE gate |
| `getUserContext.cache.clear()` | 主线程 |
| `resetGetMemoryFilesCache('compact')` | 主线程 |
| `clearSystemPromptSections()` | 总是 |
| `clearClassifierApprovals()` | 总是 |
| `clearSpeculativeChecks()` | 总是 |
| `clearBetaTracingState()` | 总是 |
| `sweepFileContentCache()` | COMMIT_ATTRIBUTION gate |
| `clearSessionMessagesCache()` | 总是 |
| ~~`resetSentSkillNames()`~~ | **刻意跳过**（见下） |

**刻意不清理 `sentSkillNames`**（`src/services/compact/postCompactCleanup.ts:65-69`）：重注入完整 `skill_listing`（~4K tokens）完全是 `cache_creation`（无 cache_read 收益）。模型仍有 SkillTool schema，`invoked_skills` attachment 已保留用过的 skill 内容。

## 5. 熔断机制：MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

这是上下文压缩系统中最重要的生产级保护机制。

### 生产事故背景

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:67-70`（代码注释）

```
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
```

这些失败通常发生在上下文已不可恢复地超过限制的情况下（例如，单条消息就超过 token 限制）。系统会不断尝试压缩，但每次都会失败，造成大量无效的 API 调用。

### 熔断器实现

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:258-265`

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}
```

当连续失败次数达到 3 次时，熔断器触发，该会话将不再尝试自动压缩，直到用户手动触发 `/compact` 或重新开始会话。

**失败计数逻辑**（`src/services/compact/autoCompact.ts:334-349`）：
- 成功时 `consecutiveFailures: 0`（重置）
- 失败时 `consecutiveFailures: prevFailures + 1`
- 达到阈值时记录 warn 日志

### 重要性

这个简单的常量（从 1 到 3）每年可能节省数百万次 API 调用和相应的计算资源。它体现了生产工程中的一个核心原则：**优雅地失败比无限重试更有价值**。

## 6. 压缩质量保证

### 保留的关键信息

压缩不是简单的截断，而是智能摘要。压缩后重新注入的内容：

> 📍 **源码位置**: `src/services/compact/compact.ts:531-585`

| 注入内容 | 约束 |
|----------|------|
| 最近读取的文件（`createPostCompactFileAttachments`） | 最多 5 个，总预算 50K tokens，单文件 5K |
| Async agent attachments | — |
| Plan 附件（如有计划文件） | — |
| Plan mode 指令附件（如在 plan 模式） | — |
| 已调用 skill 内容（`createSkillAttachmentIfNeeded`） | 单 skill 5K，总预算 25K |
| Deferred tools delta（`getDeferredToolsDeltaAttachment`） | — |
| Agent listing delta | — |
| MCP instructions delta | — |
| SessionStart hooks 结果 | — |

**相关常量**（`src/services/compact/compact.ts:122-130`）：
```typescript
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
```

### 部分压缩

`partialCompactConversation` 支持选择性压缩：
- **from 方向**: 压缩某条消��之后的内容，保留之前的内容
- **up_to 方向**: 压缩某条消息之前的内容，保留之后的内容

这允许用户精确控制哪些对话历史需要保留。

### 消息保留机制

```typescript
export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: readonly Message[] | undefined,
): SystemCompactBoundaryMessage
```

通过元数据标记保留的消息段，确保消息链的完整性。

### preCompactDiscoveredTools 持久化

> 📍 **源码位置**: `src/services/compact/compact.ts:606-611`

```typescript
const preCompactDiscovered = extractDiscoveredToolNames(messages)
if (preCompactDiscovered.size > 0) {
  boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
    ...preCompactDiscovered,
  ].sort()
}
```

压缩前已发现的 deferred tool 名称集合被持久化到 compact boundary message 的 metadata 中。post-compact 的 schema 过滤器利用此数据继续向 API 发送已加载的 deferred tool schemas，避免重新发现。

## 7. 手动压缩命令

用户可以通过 `/compact` 命令手动触发压缩：

```typescript
export const call: LocalCommandCall = async (args, context) => {
  // ...
  const result = await compactConversation(
    messagesForCompact,
    context,
    cacheSafeParams,
    false,  // 不抑制用户问题
    customInstructions,  // 支持自定义指令
    false,  // 非自动压缩
  )
  // ...
}
```

### 自定义指令

用户可以传递自定义指令来指导摘要生成：

```
/compact 重点保留与数据库相关的讨论
```

### 与自动压缩的区别

- 手动压缩不会触发熔断机制
- 支持自定义指令
- 提供更详细的错误反馈
- `suppressFollowUpQuestions: false`（保留摘要后的跟进问题提示）
- 压缩后显示升级提示（如果有更大的模型可用）

**补充发现（Q&A 学习）** — `suppressFollowUpQuestions` 参数（`src/services/compact/compact.ts:616`）：

自动压缩传 `true`（抑制，不打断 agentic 流），手动 /compact 传 `false`（保留，供用户继续对话）。影响 `getCompactUserSummaryMessage` 中摘要后的提示文本内容。

**补充发现（Q&A 学习）** — `isVisibleInTranscriptOnly: true`（`src/services/compact/compact.ts:622`）：

summary message 被标记为 transcript-only，只在 transcript 文件中可见，不出现在 UI 的对话历史显示中（用户界面上不会看到这条摘要消息）。

## 8. 功能标志

### REACTIVE_COMPACT

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:195-199`

```typescript
if (feature('REACTIVE_COMPACT')) {
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
    return false
  }
}
```

**作用**: 反应式压缩模式。不主动触发压缩，而是等待 API 返回 `prompt_too_long` 错误后再进行压缩。

**优势**: 减少不必要的压缩，只在真正需要时才执行。

### CACHED_MICROCOMPACT

```typescript
if (feature('CACHED_MICROCOMPACT')) {
  const mod = await getCachedMCModule()
  // ...
}
```

**作用**: 启用基于缓存编辑的微压缩。使用 `cache_edits` API 在不使缓存失效的情况下删除工具结果。

**特点**:
- 不修改本地消息内容
- 在 API 层添加 `cache_reference` 和 `cache_edits`
- 基于计数阈值触发
- 仅支持主线程（非子代理）

**microcompact 可压缩工具集**（`src/services/compact/microCompact.ts:41-50`）：

`COMPACTABLE_TOOLS = { FileRead, Shell(含所有 shell 工具), Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite }`

`IMAGE_MAX_TOKEN_SIZE = 2000`（超过此大小的图片 tool result 被微压缩）

### HISTORY_SNIP

> 📍 **源码位置**: `src/query.ts`（引用 `./services/compact/snip.js`）

```typescript
const snipModule = feature('HISTORY_SNIP')
  ? require('./services/compact/snip.js')
  : null
```

**作用**: 历史截断功能。允许系统主动删除旧消息，而不是等待压缩。

**与压缩的区别**: snip 是直接删除，而 compact 是总结替换。

### CONTEXT_COLLAPSE

```typescript
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } = require('../contextCollapse/index.js')
  if (isContextCollapseEnabled()) {
    return false
  }
}
```

**作用**: 上下文折叠模式。使用不同的上下文管理策略（90% 提交 / 95% 阻塞）。

**与压缩的关系**: 当 context collapse 启用时，自动压缩被抑制，因为 collapse 系统会接管上下文管理。

## 9. Session Memory 压缩

> 📍 **源码位置**: `src/services/compact/sessionMemoryCompact.ts`

### 工作原理

Session Memory 压缩是传统 summarize-and-replace 方式的轻量替代：直接利用已有的 session memory（LLM 自动提取的会话摘要）替代生成新摘要，仅删除部分旧消息而非全量替换。

### 配置参数

> 📍 **源码位置**: `src/services/compact/sessionMemoryCompact.ts:57-60`

```typescript
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,       // 压缩后至少保留 10K tokens
  minTextBlockMessages: 5, // 或至少 5 条有文本的消息
  maxTokens: 40_000,       // 最多保留 40K tokens
}
```

### 优势

- 比传统压缩**更快**（无需生成摘要的 API 调用）
- 对 prompt cache 影响**更小**（只删除部分消息）
- 在 `autoCompactIfNeeded` 中**优先尝试**（`src/services/compact/autoCompact.ts:287-310`）

## 10. 压缩对 Prompt Cache 的影响

### Cache Sharing

> 📍 **源码位置**: `src/services/compact/compact.ts`（`promptCacheSharingEnabled` 变量）

```typescript
const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_compact_cache_prefix',
  true,
)
```

压缩请求默认复用主对话的 prompt cache，这包括：
- 系统提示词
- 工具定义
- 上下文消息前缀

### 缓存失效处理

> 📍 **源码位置**: `src/services/compact/autoCompact.ts:300-305`

```typescript
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
}
```

压缩后，系统会通知缓存检测模块，避免将压缩后的缓存读取量下降误判为缓存破坏。

**补充发现（Q&A 学习）**（`src/services/compact/autoCompact.ts:299-305`注释）：

Session Memory 压缩也必须调用 `notifyCompaction`（BQ 2026-03-01）：之前遗漏这一步导致 20% 的 `tengu_prompt_cache_break` 事件是误报（`systemPromptChanged=true, timeSinceLastAssistantMsg=-1`）。

### 压缩对缓存命中率的影响

- **传统压缩**: 会替换所有消息，导致缓存完全失效
- **Session Memory 压缩**: 只删除部分消息，对缓存影响较小
- **Cached Microcompact**: 使用 `cache_edits`，理论上不影响缓存命中率

### 缓存指标追踪

> 📍 **源码位置**: `src/services/compact/compact.ts`（`logEvent('tengu_compact', ...)` 调用处）

```typescript
logEvent('tengu_compact', {
  compactionCacheReadTokens: compactionUsage?.cache_read_input_tokens ?? 0,
  compactionCacheCreationTokens: compactionUsage?.cache_creation_input_tokens ?? 0,
  // ...
})
```

系统会记录每次压缩的缓存指标，用于监控和优化。

## 总结

Claude Code 的上下文压缩系统是一个精心设计的生产级功能，它通过多层策略（自动压缩、手动压缩、微压缩、熔断机制）确保长对话的可用性和成本效益。特别是 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 这个看似简单的常量，体现了从真实生产事故中学习的工程文化。

**关键数字汇总**：
- 有效窗口缓冲（摘要输出预留）：`min(model最大输出, 20_000)` tokens（基于 p99.99=17,387）
- 自动压缩触发阈值缓冲：13,000 tokens
- 警告/错误阈值缓冲：20,000 tokens
- 阻塞限制缓冲：3,000 tokens
- PTL 重试上限：3 次
- 熔断失败次数：3 次（BQ 2026-03-10 事故后设立）
- 文件重注入上限：5 个文件，50K tokens 预算
- Skill 重注入上限：per-skill 5K tokens，总预算 25K tokens

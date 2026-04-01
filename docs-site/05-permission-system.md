# Claude Code 权限系统详解

Claude Code 的权限系统是其安全架构的核心组件，采用多层防御机制来平衡自动化能力与安全防护。本文档深入分析其设计原理与实现细节。

## 1. 权限模型概述

Claude Code 的权限系统采用**行为-规则-来源**三维模型：

- **行为 (Behavior)**：`allow`（允许）、`deny`（拒绝）、`ask`（询问）
- **规则 (Rule)**：针对特定工具或工具内容的匹配模式
- **来源 (Source)**：规则的定义位置，影响持久化范围

> 📍 **PermissionRule 类型**: `src/types/permissions.ts:75-79`  
> 📍 **PermissionBehavior 类型**: `src/types/permissions.ts:44`  
> 📍 **PermissionRuleSource 类型**: `src/types/permissions.ts:54-63`

```typescript
// 权限规则的核心定义
type PermissionRule = {
  source: PermissionRuleSource      // 规则来源
  ruleBehavior: PermissionBehavior  // allow | deny | ask
  ruleValue: {
    toolName: string                 // 工具名称
    ruleContent?: string             // 可选内容匹配
  }
}
```

权限检查发生在每次工具调用前，通过 `hasPermissionsToUseTool()` 函数进行多阶段评估。

> 📍 **hasPermissionsToUseTool**: `src/utils/permissions/permissions.ts:473`  
> 📍 **hasPermissionsToUseToolInner**: `src/utils/permissions/permissions.ts:1158`

## 2. 权限级别与模式

Claude Code 支持多种权限模式，通过 `--permission-mode` 参数或设置文件配置：

> 📍 **EXTERNAL_PERMISSION_MODES 常量**: `src/types/permissions.ts:16-22`  
> 📍 **InternalPermissionMode 类型**: `src/types/permissions.ts:28`  
> 📍 **INTERNAL_PERMISSION_MODES**: `src/types/permissions.ts:33-36`

| 模式 | 说明 | 风险等级 |
|------|------|----------|
| `default` | 默认模式，每次危险操作都询问 | 低 |
| `acceptEdits` | 自动接受文件编辑操作 | 中 |
| `bypassPermissions` | 完全绕过权限检查 | **极高** |
| `dontAsk` | 拒绝而非询问 | 低 |
| `plan` | 计划模式，批量确认 | 中 |
| `auto` | 自动模式（`TRANSCRIPT_CLASSIFIER` feature 门控） | 中 |
| `bubble` | 内部模式（仅内部使用） | 内部 |

**补充发现（Q&A 学习）**：

- `auto` 模式是 `TRANSCRIPT_CLASSIFIER` feature 门控的（`src/types/permissions.ts:35`）：`...(feature('TRANSCRIPT_CLASSIFIER') ? (['auto'] as const) : ([] as const))`
- `bubble` 是纯内部模式，不出现在用户可配置的 `INTERNAL_PERMISSION_MODES` 中
- `dontAsk` 模式在 `hasPermissionsToUseTool` 中将 `ask` 转换为 `deny`（`src/utils/permissions/permissions.ts:505-510`）

模式配置存储于 `ToolPermissionContext` 中：

> 📍 **ToolPermissionContext 类型**: `src/Tool.ts:123-138`

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  alwaysAllowRules: ToolPermissionRulesBySource  // 全局允许规则
  alwaysDenyRules: ToolPermissionRulesBySource   // 全局拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource    // 强制询问规则
  additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean  // 无头模式使用
}
```

## 3. 危险操作拦截机制

### 3.1 多阶段检查流程

> 📍 **hasPermissionsToUseToolInner 完整实现**: `src/utils/permissions/permissions.ts:1158-1400+`

```typescript
async function hasPermissionsToUseToolInner(tool, input, context) {
  // 阶段 1a: 检查全局拒绝规则
  const denyRule = getDenyRuleForTool(context, tool)
  if (denyRule) return { behavior: 'deny', ... }
  
  // 阶段 1b: 检查强制询问规则
  const askRule = getAskRuleForTool(context, tool)
  if (askRule) return { behavior: 'ask', ... }
  
  // 阶段 1c: 工具特定权限检查
  const toolResult = await tool.checkPermissions(parsedInput, context)
  
  // 阶段 1d-1g: 处理工具返回的各种决策
  // ...
  
  // 阶段 2a: 检查 bypass 模式
  if (shouldBypassPermissions) {
    return { behavior: 'allow', decisionReason: { type: 'mode', mode } }
  }
  
  // 阶段 2b: 检查全局允许规则
  const alwaysAllowedRule = toolAlwaysAllowedRule(context, tool)
  if (alwaysAllowedRule) return { behavior: 'allow', ... }
  
  // 阶段 3: 默认转为询问
  return { behavior: 'ask', ... }
}
```

**补充发现（Q&A 学习）**：

- `SandboxManager.isAutoAllowBashIfSandboxedEnabled()` 检查（`src/utils/permissions/permissions.ts:1180-1194`）：当 Bash 命令会被沙箱化时，`ask` 规则可以被绕过，由 Bash 的 checkPermissions 处理命令级规则。
- `safetyCheck` 类型的 decisionReason 不可被 bypass 模式绕过（`src/Tool.ts:421-424`）：这些安全检查（如敏感文件路径保护）始终强制询问。
- 工具的 `inputSchema.parse(input)` 失败时（如 input 格式错误），会回退到默认的 passthrough 行为，不会直接拒绝（`src/utils/permissions/permissions.ts:1215-1225`）。

### 3.2 Bash 命令的特殊处理

Bash 工具拥有最复杂的权限检查逻辑，包括：

- **命令解析**：使用 tree-sitter 解析 shell AST
- **子命令拆分**：将复合命令拆分为独立单元分别检查
- **前缀匹配**：支持 `Bash(git commit:*)` 这类前缀规则
- **分类器评估**：使用 AI 分类器判断命令安全性

```typescript
// Bash 权限检查的核心逻辑
export async function bashToolHasPermission(
  command: string,
  context: ToolUseContext,
): Promise<PermissionResult> {
  // 1. 解析命令 AST
  const parsed = await parseCommandRaw(command)
  
  // 2. 拆分为子命令
  const subcommands = splitCommand_DEPRECATED(command)
  
  // 3. 检查每个子命令
  for (const subcmd of subcommands) {
    const result = await checkSubcommandPermission(subcmd, context)
    if (result.behavior !== 'allow') {
      return result  // 任一子命令被拒绝则整体拒绝
    }
  }
  
  // 4. 检查安全限制（如敏感目录访问）
  const safetyCheck = await checkPathConstraints(parsed, context)
  if (safetyCheck) return safetyCheck
  
  return { behavior: 'passthrough' }
}
```

**补充发现（Q&A 学习）**：

- `speculative classifier check`（`src/hooks/useCanUseTool.tsx:11`，`consumeSpeculativeClassifierCheck` 和 `peekSpeculativeClassifierCheck`）：在 BashTool 的权限检查中，允许分类器检查投机性地在用户交互前异步运行，减少等待时间。
- `pendingClassifierCheck`（`src/types/permissions.ts:220`）：`ask` 决策可以携带一个 pending 分类器检查，分类器可能在用户回答前自动批准权限。
- `isBashSecurityCheckForMisparsing`（`src/types/permissions.ts:215`）：用于标记那些 splitCommand_DEPRECATED 可能误解析（如行续符、shell 引号转换）的安全检查。

## 4. useCanUseTool Hook

React Hook `useCanUseTool` 是权限系统与 UI 的桥梁：

> 📍 **CanUseToolFn 类型定义**: `src/hooks/useCanUseTool.tsx:27`（编译后位置）  
> 📍 **useCanUseTool 函数**: `src/hooks/useCanUseTool.tsx:28`  
> 📍 **handleInteractivePermission 导入**: `src/hooks/useCanUseTool.tsx:23`  
> 📍 **handleCoordinatorPermission 导入**: `src/hooks/useCanUseTool.tsx:22`  
> 📍 **handleSwarmWorkerPermission 导入**: `src/hooks/useCanUseTool.tsx:24`

```typescript
export type CanUseToolFn = (
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision
) => Promise<PermissionDecision>
```

Hook 内部根据当前上下文选择不同的处理器：

- **交互式处理器** (`handleInteractivePermission`)：主代理使用，显示权限对话框（`src/hooks/toolPermission/handlers/interactiveHandler.ts`）
- **协调器处理器** (`handleCoordinatorPermission`)：多代理协调器使用（`src/hooks/toolPermission/handlers/coordinatorHandler.ts`）
- **Swarm 工作器处理器** (`handleSwarmWorkerPermission`)：Swarm 子代理使用（`src/hooks/toolPermission/handlers/swarmWorkerHandler.ts`）

```typescript
function useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext) {
  return async (tool, input, toolUseContext, assistantMessage, toolUseID) => {
    // 1. 调用核心权限检查
    const result = await hasPermissionsToUseTool(tool, input, toolUseContext, ...)
    
    if (result.behavior === 'allow') {
      // 记录分类器批准（如适用）
      if (result.decisionReason?.type === 'classifier') {
        setYoloClassifierApproval(toolUseID, result.decisionReason.reason)
      }
      return result
    }
    
    if (result.behavior === 'deny') {
      // 记录自动模式拒绝
      if (result.decisionReason?.type === 'classifier') {
        recordAutoModeDenial({ toolName: tool.name, ... })
      }
      return result
    }
    
    // behavior === 'ask'，需要用户交互
    // 根据上下文选择处理器...
  }
}
```

**补充发现（Q&A 学习）**：

- `forceDecision` 参数（`src/hooks/useCanUseTool.tsx:35`）：允许调用方直接传入已知的权限决策，跳过 `hasPermissionsToUseTool` 检查（用于推测执行场景）。
- `createPermissionContext` 和 `createPermissionQueueOps`（`src/hooks/toolPermission/PermissionContext.ts`）：封装了权限对话框的队列操作和上下文创建。
- `ctx.resolveIfAborted(resolve)` 在关键步骤检查中止信号，确保中止时权限请求能正确清理。
- `logPermissionDecision`（`src/hooks/toolPermission/permissionLogging.ts`）：统一记录所有权限决策（用于审计和分析）。

## 5. 权限持久化

权限规则可持久化到多个层级，按优先级排序：

> 📍 **PermissionRuleSource 枚举**: `src/types/permissions.ts:54-63`  
> 📍 **PermissionUpdateDestination 类型**: `src/types/permissions.ts:88-94`  
> 📍 **PermissionUpdate 类型**: `src/types/permissions.ts:98-131`

1. **`policySettings`**：组织策略（只读）
2. **`flagSettings`**：功能标志控制（只读）
3. **`userSettings`**：用户级设置 (`~/.claude/settings.json`)
4. **`projectSettings`**：项目级设置 (`.claude/settings.json`)
5. **`localSettings`**：本地设置
6. **`cliArg`**：命令行参数
7. **`session`**：当前会话（内存中）
8. **`command`**：命令来源（斜杠命令）

```typescript
// 应用权限更新
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'addRules':
      // 添加规则到指定来源
      return addRulesToContext(context, update)
    case 'removeRules':
      // 从指定来源移除规则
      return removeRulesFromContext(context, update)
    case 'setMode':
      // 更改权限模式
      return { ...context, mode: update.mode }
    // ...
  }
}
```

> 📍 **applyPermissionUpdate 调用**: `src/utils/permissions/permissions.ts:1342`  
> 📍 **applyPermissionUpdates 调用**: `src/utils/permissions/permissions.ts:1413`  
> 📍 **persistPermissionUpdates 调用**: `src/utils/permissions/permissions.ts:426`

**补充发现（Q&A 学习）**：

- `PermissionUpdate` 类型还包括 `addDirectories` 和 `removeDirectories`（`src/types/permissions.ts:122-130`），用于管理额外的工作目录权限范围。
- `replaceRules` 操作（`src/types/permissions.ts:105-110`）：原子替换指定来源的所有规则，常用于清理旧规则。

## 6. 权限提示 UI

权限对话框采用 React + Ink 实现，为不同工具提供定制化界面：

```typescript
// 权限请求组件映射
function permissionComponentForTool(tool: Tool): React.ComponentType {
  switch (tool) {
    case FileEditTool: return FileEditPermissionRequest
    case FileWriteTool: return FileWritePermissionRequest
    case BashTool: return BashPermissionRequest
    case PowerShellTool: return PowerShellPermissionRequest
    case WebFetchTool: return WebFetchPermissionRequest
    // ... 更多工具
    default: return FallbackPermissionRequest
  }
}
```

`PermissionDialog` 组件提供统一的对话框框架：

> 📍 **权限请求处理器目录**: `src/hooks/toolPermission/handlers/`  
> 📍 **interactiveHandler**: `src/hooks/toolPermission/handlers/interactiveHandler.ts`

```typescript
export function PermissionDialog({
  title,
  subtitle,
  color = 'permission',
  children,
}: Props) {
  return (
    <Box 
      flexDirection="column" 
      borderStyle="round" 
      borderColor={color}
      borderLeft={false} 
      borderRight={false} 
      borderBottom={false}
    >
      <PermissionRequestTitle title={title} subtitle={subtitle} />
      {children}
    </Box>
  )
}
```

## 7. --dangerously-skip-permissions 标志

这是一个**极度危险**的命令行标志，用于 CI/CD 等自动化场景：

```bash
claude --dangerously-skip-permissions "请重构这个代码库"
```

### 安全限制

该标志受到严格限制，仅在以下条件下可用：

1. **非 root 用户**：禁止以 root/sudo 运行
2. **沙箱环境**：必须在 Docker 或 Bubblewrap 沙箱中
3. **无网络访问**：沙箱必须禁用网络连接

```typescript
// 安全检查逻辑
if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
  // 检查 root 权限
  if (process.getuid?.() === 0 || process.getgid?.() === 0) {
    throw new Error('--dangerously-skip-permissions cannot be used with root/sudo')
  }
  
  // 检查沙箱环境
  const isDocker = await isRunningInDocker()
  const isBubblewrap = await isRunningInBubblewrap()
  const hasInternet = await checkInternetAccess()
  
  if (!isDocker && !isBubblewrap && !isSandbox) {
    throw new Error('Must run in Docker/sandbox container')
  }
  if (hasInternet) {
    throw new Error('Sandbox must have no internet access')
  }
}
```

### 风险警示

使用此标志意味着：
- 所有文件操作无需确认直接执行
- 任意代码可在系统上运行
- 数据丢失风险极高
- 仅应在完全隔离的临时环境中使用

## 8. Glob 模式匹配

文件路径权限使用 Glob 模式进行匹配，支持复杂的路径规则：

```typescript
// 规则示例
const rules = [
  'Read(//home/user/projects/**)',      // 允许读取项目目录
  'Edit(//src/**/*.ts)',                // 允许编辑 src 下的 TypeScript
  'Bash(npm run:*)',                    // 允许 npm run 子命令
  'Bash(git commit:*)',                 // 允许 git commit 变体
]
```

路径匹配逻辑：

```typescript
export function matchWildcardPattern(pattern: string, target: string): boolean {
  // 1. 转换为 POSIX 路径格式
  const posixPattern = toPosixPath(pattern)
  const posixTarget = toPosixPath(target)
  
  // 2. 处理 // 前缀表示绝对路径
  const isAbsolutePattern = posixPattern.startsWith('//')
  
  // 3. 使用 minimatch 进行 glob 匹配
  return minimatch(posixTarget, isAbsolutePattern 
    ? posixPattern.slice(1)  // 移除 // 前缀
    : posixPattern, 
    { matchBase: true }
  )
}
```

**补充发现（Q&A 学习）**：

- MCP 工具的权限规则支持服务器级匹配：`mcp__server1`（不含工具名）会匹配该 MCP 服务器的所有工具（`src/utils/permissions/permissions.ts:1065+`）。
- `preparePermissionMatcher?`（`src/Tool.ts:514-516`）：工具可以实现自定义匹配器，处理如 `Bash(git *)` 这类带参数的权限模式。

## 9. 网络访问控制

MCP (Model Context Protocol) 和外部网络调用受到严格管控：

### MCP 工具权限

MCP 工具使用特殊的命名格式：`mcp__serverName__toolName`

```typescript
// MCP 工具权限检查
function toolMatchesRule(tool, rule): boolean {
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)
  
  // 直接匹配完整工具名
  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }
  
  // 支持服务器级权限：mcp__server1 匹配该服务器所有工具
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)
  
  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}
```

### 网络获取限制

`WebFetchTool` 和 `WebSearchTool` 默认需要每次确认，可通过规则预授权：

```typescript
// WebFetch 权限检查
async checkPermissions(input, context) {
  // 检查是否允许访问该域名
  const domain = new URL(input.url).hostname
  
  // 检查 allow/deny 规则
  if (isDomainAllowed(domain, context)) {
    return { behavior: 'allow' }
  }
  if (isDomainDenied(domain, context)) {
    return { behavior: 'deny', message: 'Domain blocked' }
  }
  
  return { behavior: 'ask', message: `Allow access to ${domain}?` }
}
```

## 10. 权限决策原因类型

> 📍 **PermissionDecisionReason 类型**: `src/types/permissions.ts:271-324`

**补充发现（Q&A 学习）**：

`PermissionDecisionReason` 是一个区分联合类型，包含以下变体：

| 类型 | 说明 |
|------|------|
| `rule` | 匹配了 allow/deny/ask 规则 |
| `mode` | 权限模式决策（如 bypassPermissions） |
| `subcommandResults` | Bash 子命令聚合结果 |
| `permissionPromptTool` | 权限提示工具决策 |
| `hook` | PreToolUse/PostToolUse hook 决策 |
| `asyncAgent` | 异步 agent 决策 |
| `sandboxOverride` | 沙箱覆盖决策（`excludedCommand`、`dangerouslyDisableSandbox`） |
| `classifier` | AI 分类器决策（`auto-mode` 分类器） |
| `workingDir` | 工作目录权限决策 |
| `safetyCheck` | 安全检查决策（`classifierApprovable` 控制是否允许 AI 覆盖） |
| `other` | 其他原因 |

`safetyCheck.classifierApprovable`（`src/types/permissions.ts:319`）：
- `true`：针对敏感文件路径（`.claude/`、`.git/`、shell 配置），AI 分类器可以看到上下文并决定是否批准
- `false`：Windows 路径绕过尝试、跨机器 bridge 消息——这些始终强制人工确认

## 11. 安全设计哲学

Claude Code 权限系统遵循**"最小爆炸半径"**原则：

### 11.1 默认拒绝 (Default Deny)

任何未明确允许的操作都需要用户确认，不存在"隐式允许"。

### 11.2 分层防御 (Defense in Depth)

```
用户确认层 → 规则匹配层 → 模式检查层 → 工具验证层 → 沙箱执行层
```

每层都可独立拦截危险操作。

### 11.3 安全优先于便利

关键安全规则不可被覆盖：

```typescript
// 安全检查不可被 bypass 模式绕过
if (toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck') {
  return toolPermissionResult  // 强制询问
}
```

### 11.4 透明可审计

所有权限决策都记录原因：

> 📍 **PermissionDecisionReason 完整类型**: `src/types/permissions.ts:271-324`

```typescript
type PermissionDecisionReason =
  | { type: 'rule', rule: PermissionRule }
  | { type: 'mode', mode: PermissionMode }
  | { type: 'classifier', classifier: string, reason: string }
  | { type: 'safetyCheck', reason: string, classifierApprovable: boolean }
  | { type: 'hook', hookName: string, reason?: string }
  // ...
```

### 11.5 渐进式授权

用户可以选择：
- **一次性允许**：仅本次执行
- **会话允许**：当前会话有效（`destination: 'session'`）
- **永久允许**：写入设置文件持久化（`destination: 'userSettings'` 或 `'projectSettings'`）

这种设计让用户在便利性和安全性之间自主权衡。

---

## 总结

Claude Code 的权限系统是一个精心设计的**零信任**安全架构，通过多层级检查、灵活的配置选项和清晰的用户界面，在提供强大自动化能力的同时，最大限度地降低意外损害的风险。

> 📍 **权限类型汇总**: `src/types/permissions.ts:1-441`  
> 📍 **权限实现核心**: `src/utils/permissions/permissions.ts:1-1500+`  
> 📍 **UI 集成**: `src/hooks/useCanUseTool.tsx`  
> 📍 **交互式处理器**: `src/hooks/toolPermission/handlers/interactiveHandler.ts`

理解这套系统的工作原理，有助于用户做出明智的权限配置决策。

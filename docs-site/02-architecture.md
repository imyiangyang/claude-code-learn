# Claude Code 架构分析 — 整体架构

本文档基于泄露的 Claude Code 源码（2026-03-31），深入分析其整体架构设计、核心模块职责及关键技术决策。

---

## 1. 三层架构概览

Claude Code 采用清晰的分层架构，将 UI、业务逻辑和工具执行分离：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UI Layer (React/Ink)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  REPL.tsx   │  │  App.tsx    │  │ Components  │  │  Message Rendering  │ │
│  │  (主界面)    │  │ (状态容器)   │  │ (~140个)    │  │  (Markdown/Spinner) │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘ │
└─────────┼────────────────┼────────────────┼─────────────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Logic Layer (QueryEngine)                           │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     QueryEngine.ts (~1295行)                          │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                │  │
│  │  │  query.ts    │  │  context.ts  │  │  commands.ts │                │  │
│  │  │ (查询流水线)  │  │ (上下文管理)  │  │ (命令系统)    │                │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Tool Layer (Tools)                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────┐  │
│  │ BashTool   │ │ File*Tool  │ │ AgentTool  │ │  MCPTool   │ │  LSPTool  │  │
│  │ (命令执行)  │ │ (文件操作)  │ │ (子代理)    │ │(MCP服务)   │ │ (LSP集成) │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └───────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────┐  │
│  │ GrepTool   │ │ GlobTool   │ │ Web*Tool   │ │ SkillTool  │ │ Task*Tool │  │
│  │ (代码搜索)  │ │ (文件匹配)  │ │ (网络请求)  │ │ (技能执行)  │ │ (任务管理) │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └───────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心数据流

用户输入到响应的完整数据流如下：

```
用户输入
    │
    ▼
┌─────────────────┐
│   REPL.tsx      │  ← 读取用户输入，处理键盘事件
│  (交互式界面)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  commands.ts    │  ← 解析斜杠命令 (/commit, /review等)
│  (命令路由)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  QueryEngine    │  ← 核心查询引擎，管理对话状态
│  .submitMessage │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   query.ts      │────▶│  context.ts     │
│  (查询流水线)    │     │ (系统/用户上下文) │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Anthropic API  │  ← 流式请求Claude API
│  (Streaming)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Tool Calls     │────▶│   Tool.ts       │
│  (工具调用解析)  │     │ (工具类型定义)   │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Tool Execution │  ← 执行具体工具 (Bash, File, MCP等)
│  (工具执行层)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Tool Results   │  ← 工具执行结果
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Response       │  ← 生成最终响应
│  (流式输出)      │
└─────────────────┘
```

---

## 3. 主要模块及职责

### 3.1 入口与启动 (`main.tsx`)

**文件位置**: `src/main.tsx` (~4684行)

> 📍 **源码位置**: `src/main.tsx:9-20`（三副作用预取）；`src/main.tsx:232`（`isBeingDebugged`）；`src/main.tsx:388`（`startDeferredPrefetches`）；`src/main.tsx:209`（`profileCheckpoint('main_tsx_imports_loaded')`）

这是整个应用的入口点，主要职责包括：

- **并行预取优化**: 在模块加载前启动 MDM 设置读取、钥匙串预取
- **CLI 参数解析**: 使用 Commander.js 处理命令行参数
- **配置迁移**: 运行配置迁移脚本 (`runMigrations`)
- **信任检查**: 检测调试器并退出 (`isBeingDebugged`)
- **延迟预取**: 首屏渲染后启动后台预取 (`startDeferredPrefetches`)

```typescript
// main.tsx 中的关键启动优化
import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');

// 并行启动关键IO操作
startMdmRawRead();
startKeychainPrefetch();
```

### 3.2 查询引擎 (`QueryEngine.ts`)

**文件位置**: `src/QueryEngine.ts` (~1295行)

> 📍 **源码位置**: `src/QueryEngine.ts:184`（`export class QueryEngine`）；`src/QueryEngine.ts:186`（`private mutableMessages`）；`src/QueryEngine.ts:209`（`async *submitMessage`）

核心引擎类，每个对话会话对应一个 QueryEngine 实例：

- **状态管理**: 维护消息历史、文件缓存、权限拒绝记录
- **查询生命周期**: `submitMessage()` 方法处理完整的查询流程
- **工具调用循环**: 处理 Claude API 的工具调用请求和结果
- **流式响应**: 支持 SSE 流式输出
- **思考模式**: 支持自适应思考配置 (`thinkingConfig`)

```typescript
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  // ...
  
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown>
}
```

### 3.3 查询流水线 (`query.ts`)

**文件位置**: `src/query.ts` (~1729行)

处理与 Anthropic API 的交互：

- **消息规范化**: 转换消息格式以符合 API 要求
- **工具执行编排**: 调用 `StreamingToolExecutor` 执行工具
- **上下文压缩**: 自动压缩超长对话 (`autoCompact`)
- **错误处理**: 重试逻辑和错误恢复
- **Token 预算**: 跟踪和管理 token 使用量

### 3.4 工具系统 (`Tool.ts`)

**文件位置**: `src/Tool.ts` (~792行)

> 📍 **源码位置**: `src/Tool.ts:15`（`ToolInputJSONSchema` 类型）；`src/Tool.ts:123`（`ToolPermissionContext`）；`src/Tool.ts:348`（`toolMatchesName()`）；`src/Tool.ts:362`（`export type Tool<`）；`src/Tool.ts:701`（`export type Tools`）

定义所有工具的接口和类型：

- **工具类型定义**: `ToolInputJSONSchema`, `ToolUseContext`
- **权限上下文**: `ToolPermissionContext` 管理工具权限规则
- **进度状态**: 各种工具的进度类型 (BashProgress, MCPProgress等)
- **工具匹配**: `toolMatchesName()` 用于查找工具

### 3.5 上下文管理 (`context.ts`)

**文件位置**: `src/context.ts` (~189行)

> 📍 **源码位置**: `src/context.ts:116`（`export const getSystemContext = memoize(...)`）；`src/context.ts:155`（`export const getUserContext = memoize(...)`）；`src/context.ts:32-33`（`getUserContext.cache.clear`/`getSystemContext.cache.clear` 缓存清理）

收集和管理对话上下文：

- **系统上下文**: `getSystemContext()` - Git 状态、环境信息
- **用户上下文**: `getUserContext()` - Claude.md 文件、当前日期
- **缓存机制**: 使用 `lodash/memoize` 缓存上下文

```typescript
export const getSystemContext = memoize(async (): Promise<{[k: string]: string}> => {
  const gitStatus = await getGitStatus()
  return { ...(gitStatus && { gitStatus }) }
})

export const getUserContext = memoize(async (): Promise<{[k: string]: string}> => {
  const claudeMd = getClaudeMds(...)
  return { ...(claudeMd && { claudeMd }), currentDate: ... }
})
```

### 3.6 命令系统 (`commands.ts`)

**文件位置**: `src/commands.ts` (~754行)

> 📍 **源码位置**: `src/types/command.ts:205`（`export type Command = CommandBase & ...`）；`src/replLauncher.tsx:12`（`export async function launchRepl(...)`）

管理所有斜杠命令：

- **命令注册**: 约 50+ 个内置命令 (`/commit`, `/review`, `/compact` 等)
- **条件加载**: 使用 `feature()` 标志条件加载实验性功能
- **动态命令**: 支持从 skills 和 plugins 加载动态命令

```typescript
// 条件加载示例
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

---

## 4. 启动序列

从 `main.tsx` 开始的启动流程：

```
1. 性能标记
   └─ profileCheckpoint('main_tsx_entry')

2. 并行IO启动 (在重模块加载前)
   ├─ startMdmRawRead()          # MDM设置读取
   ├─ startKeychainPrefetch()    # 钥匙串预取
   └─ profileCheckpoint('main_tsx_imports_loaded')

3. 调试检测
   └─ isBeingDebugged() ? process.exit(1) : continue

4. 配置初始化
   ├─ runMigrations()            # 配置迁移
   ├─ applyConfigEnvironmentVariables()
   └─ loadSettingsFromFlag()

5. 信任检查
   └─ checkHasTrustDialogAccepted()

6. REPL启动
   ├─ launchRepl()               # 启动交互界面
   ├─ renderAndRun()             # 渲染React组件树
   └─ startDeferredPrefetches()  # 延迟预取
```

---

## 5. 关键设计决策

### 5.1 为什么选择 Bun 而非 Node.js

1. **更快的启动速度**: Bun 的启动时间显著低于 Node.js
2. **内置打包**: `bun:bundle` 提供特性标志和死代码消除
3. **原生 TypeScript 支持**: 无需转译步骤
4. **更好的性能**: 更快的模块解析和执行

```typescript
// Bun 特性标志示例
import { feature } from 'bun:bundle'
const proactive = feature('PROACTIVE') ? require('./proactive.js') : null
```

### 5.2 为什么选择 React/Ink 做终端UI

1. **声明式UI**: React 的组件模型适合复杂的终端界面
2. **状态管理**: 使用 React Context 管理应用状态
3. **组件复用**: ~140 个 UI 组件可组合使用
4. **Ink 生态**: 成熟的 React-for-terminal 解决方案

### 5.3 为什么选择单进程架构

1. **状态共享简单**: 无需 IPC 即可共享状态
2. **启动更快**: 避免进程创建开销
3. **调试容易**: 单一进程便于调试
4. **工具执行**: 子进程仅用于执行外部命令 (BashTool)

### 5.4 Streaming-First 设计

1. **流式API响应**: 使用 SSE 实时接收 Claude 的响应
2. **流式工具执行**: 工具输出实时显示
3. **增量渲染**: Ink 组件支持增量更新
4. **用户体验**: 用户无需等待完整响应

---

## 6. 模块依赖关系

```
                    ┌─────────────┐
                    │  main.tsx   │
                    │  (入口)      │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ replLauncher│ │   init()    │ │   config    │
    │   .tsx      │ │ (entrypoints)│ │   加载      │
    └──────┬──────┘ └─────────────┘ └─────────────┘
           │
           ▼
    ┌─────────────┐
    │  App.tsx    │◄──────────────────────────────┐
    │ (React容器)  │                               │
    └──────┬──────┘                               │
           │                                      │
           ▼                                      │
    ┌─────────────┐     ┌─────────────┐          │
    │   REPL.tsx  │────▶│  useAppState│──────────┘
    │  (主界面)    │     │  (状态管理)  │
    └──────┬──────┘     └─────────────┘
           │
           ▼
    ┌─────────────┐     ┌─────────────┐
    │ QueryEngine │◄───▶│  query.ts   │
    │  (核心引擎)  │     │ (查询流水线) │
    └──────┬──────┘     └─────────────┘
           │
    ┌──────┴──────┐
    │             │
    ▼             ▼
┌─────────┐ ┌─────────────┐
│ Tool.ts │ │ context.ts  │
│(工具定义)│ │ (上下文管理) │
└────┬────┘ └─────────────┘
     │
     ▼
┌────────────────────────────────────────────────────┐
│                     tools/                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │BashTool │ │File*Tool│ │AgentTool│ │  MCPTool  │ │
│  └─────────┘ └─────────┘ └─────────┘ └───────────┘ │
└────────────────────────────────────────────────────┘
```

---

## 7. 扩展点

### 7.1 工具扩展 (`src/tools/`)

每个工具都是自包含模块，实现以下接口：

> 📍 **源码位置**: `src/Tool.ts:362`（`export type Tool<...>` 泛型定义）；`src/Tool.ts:397`（`inputJSONSchema` 字段）；`src/Tool.ts:390`（`toolPermissionContext` 参数）

```typescript
// Tool.ts 中的核心类型
export type Tool = {
  name: string
  description: string
  inputJSONSchema: ToolInputJSONSchema
  execute: (input: unknown, context: ToolUseContext) => Promise<ToolResult>
  // ...
}
```

**已有工具**: BashTool, FileReadTool, FileWriteTool, FileEditTool, GrepTool, GlobTool, WebFetchTool, WebSearchTool, AgentTool, MCPTool, LSPTool 等。

### 7.2 命令扩展 (`src/commands/`)

斜杠命令通过 `Command` 类型定义：

> 📍 **源码位置**: `src/types/command.ts:205`（`export type Command = CommandBase & ...`）

```typescript
export type Command = 
  | { type: 'local'; name: string; handler: () => void }
  | { type: 'prompt'; name: string; getPromptForCommand: (...) => string }
```

### 7.3 MCP (Model Context Protocol)

**位置**: `src/services/mcp/`

MCP 允许连接外部服务器扩展功能：

- **服务器管理**: 添加/删除/配置 MCP 服务器
- **工具暴露**: MCP 服务器的工具可被 Claude 调用
- **资源访问**: 访问 MCP 服务器提供的资源

### 7.4 技能系统 (`src/skills/`)

可复用的工作流定义：

- **内置技能**: `src/skills/bundled/`
- **用户技能**: 从 `CLAUDE.md` 或技能目录加载
- **动态加载**: 运行时加载和缓存

### 7.5 插件系统 (`src/plugins/`)

第三方扩展机制：

- **内置插件**: `src/plugins/bundled/`
- **插件命令**: 插件可注册自定义命令
- **插件技能**: 插件可提供技能定义

---

## 8. 总结

Claude Code 的架构设计体现了以下核心理念：

1. **分层清晰**: UI、逻辑、工具三层分离，职责明确
2. **性能优先**: 并行预取、延迟加载、流式处理
3. **可扩展性**: 工具、命令、MCP、技能、插件多维度扩展
4. **类型安全**: TypeScript 严格模式，全面的类型定义
5. **单进程高效**: 避免 IPC 开销，状态管理简单

这种架构使得 Claude Code 能够在保持代码可维护性的同时，提供流畅的用户体验和强大的扩展能力。

---

## 9. 补充发现（Q&A 自我学习）

> 📍 **源码验证基础**: 本节所有发现均有对应源码行号支撑

**Q1**: `QueryEngine` 的 `mutableMessages` 为什么命名为 "mutable"？这与 React 不可变状态的惯例相矛盾吗？

**A1**: 这是刻意的命名选择。`mutableMessages` 是 **QueryEngine 内部维护的消息历史数组**，在工具调用循环中需要就地追加新消息（`this.mutableMessages.push(...)`，`src/QueryEngine.ts:431`）。如果每次追加都创建新数组，在长对话（数百条消息）中会产生显著的 GC 压力。与 React 组件状态不同，这里的对象不参与渲染系统的引用比较，因此可变性是安全且高效的。命名 "mutable" 是一种**意图注释**——提醒维护者这里有意打破了函数式纯净原则。
> 📍 `src/QueryEngine.ts:186`（`private mutableMessages: Message[]`）；`src/QueryEngine.ts:194-195`（注释解释了 mutable 的语义）

**Q2**: `getSystemContext` 和 `getUserContext` 都用了 `lodash/memoize`，但 `context.ts:32-33` 又暴露了手动清除缓存的方法——什么时候需要清除？

**A2**: 两种缓存的失效时机不同：`getSystemContext` 包含 Git 状态（`gitStatus`），在用户执行 `git commit` 或文件操作后，缓存的 Git 状态就过期了，需要在下次对话前清除。`getUserContext` 包含当前日期和 `CLAUDE.md` 内容，日期缓存会在跨午夜的长会话中过期，而 `CLAUDE.md` 在用户 `/memory` 命令修改后需要清除。因此 `src/context.ts:32-33` 的清除逻辑在 `submitMessage` 开始时被调用，确保每轮对话用到最新上下文。
> 📍 `src/context.ts:32-33`（`getUserContext.cache.clear?.()` / `getSystemContext.cache.clear?.()`）

**Q3**: 为什么 `QueryEngine.ts` 只有约 1295 行，而注释说 ~46K 行？

**A3**: 这是文档中的笔误/混淆——1295 行是类定义本身的行数，"~46K 行"可能指的是**包含所有导入模块的总计**，或是早期草稿的数字。通过 `grep -c ""` 统计，`src/QueryEngine.ts` 实际为约 1295 行。而整个 `query.ts`（查询流水线）约 1729 行。两个文件合计约 3000 行，不是 46K。建议修正文档。
> 📍 `src/QueryEngine.ts:184`（class 定义开始）；`src/query.ts`（流水线，~1729 行）

**Q4**: `startDeferredPrefetches`（`src/main.tsx:388`）与启动时的三个并行副作用有什么区别？它延迟预取了什么？

**A4**: 启动时三个副作用（`profileCheckpoint`、`startMdmRawRead`、`startKeychainPrefetch`）在**模块图加载期间**触发，目标是 IO 密集型任务（MDM 子进程、keychain 读取）。`startDeferredPrefetches`（在首屏渲染后调用）预取的是**依赖启动配置才能确定的资源**：系统上下文（`prefetchSystemContextIfSafe`，需要知道是否在 git 仓库中）、API 预连接（需要知道 API endpoint 配置）。这两类任务在启动配置确定前无法安全启动，因此延迟到渲染后。
> 📍 `src/main.tsx:388`（`startDeferredPrefetches` 函数定义）；`src/main.tsx:1968-1982`（调用位置及注释，解释了为何需要在 `applyConfigEnvironmentVariables` 之后）

**Q5**: 单进程架构（5.3节）如何处理 BashTool 等可能长时间运行的子进程？主进程会被阻塞吗？

**A5**: 不会阻塞。BashTool 使用 Node.js/Bun 的异步子进程 API（`child_process.spawn`/`Bun.spawn`），通过 `AsyncGenerator` 流式返回输出，主进程 Event Loop 不被阻塞。`QueryEngine.ts` 中的工具调用循环也是 `async/await` 驱动，工具执行期间 Ink 的渲染循环继续运行（用于显示 spinner 和实时输出）。Ink 的 React reconciler 运行在同一个线程里，通过 `setImmediate`/`queueMicrotask` 交错执行，保证 UI 响应性。
> 📍 `src/QueryEngine.ts:209`（`async *submitMessage` — AsyncGenerator 模式）；`src/ink/reconciler.ts:1`（自定义 reconciler，与工具执行共享 Event Loop）

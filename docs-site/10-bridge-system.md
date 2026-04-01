# Claude Code Bridge 系统详解

> 📍 **核心源文件**: `src/bridge/bridgeEnabled.ts`（启用条件检查）, `src/bridge/replBridge.ts`（REPL桥接核心，2406行）, `src/bridge/sessionRunner.ts`（子进程会话管理，550行）, `src/bridge/jwtUtils.ts`（JWT 刷新调度，256行）

## 1. Bridge 系统定位

Bridge（桥接）系统是 Claude Code CLI 与 IDE 扩展（如 VS Code、JetBrains 系列）之间的双向通信层。它使得用户可以在 IDE 中直接与 Claude Code 交互，实现远程控制、文件同步、光标位置感知等功能。

Bridge 系统的核心目标是：
- 让 Claude Code 能够作为后台服务运行，接收来自 IDE 或 Web 界面的指令
- 实现本地 CLI 与云端 Claude.ai 的无缝连接
- 支持多会话管理，允许同时处理多个独立的对话上下文

## 2. BRIDGE_MODE 功能标志

> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:28-36`（isBridgeEnabled 实现）
> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:50-55`（isBridgeEnabledBlocking 阻塞版）
> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:70-87`（getBridgeDisabledReason 诊断消息）

`BRIDGE_MODE` 是一个编译时功能标志（feature flag），通过 Bun 的 `bun:bundle` 系统控制：

```typescript
import { feature } from 'bun:bundle'

export function isBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}
```

### 启用条件

1. **编译时**：必须在构建时启用 `BRIDGE_MODE` 标志
2. **运行时**：需要满足以下条件：
   - 用户拥有 Claude.ai 订阅（OAuth 登录）
   - GrowthBook 功能开关 `tengu_ccr_bridge` 为 true
   - 不是 Bedrock/Vertex/Foundry 等第三方 API 部署

**补充发现（Q&A 学习）**：
- `isBridgeEnabledBlocking()` 是阻塞版：快路径直接返回缓存 `true`，慢路径需要等待 GrowthBook 初始化（最多~5s）
- `getBridgeDisabledReason()` 返回细粒度错误消息：区分"无订阅"、"token 缺少 profile scope"、"无法确定 orgUUID"、"gate 未开启"四种情况
- 使用正向三元 `feature('BRIDGE_MODE') ? ... : false` 而非 `if (!feature(...))` 是刻意设计：后者无法在外部 build 中消除字符串字面量（dead code elimination 语义差异）

### 相关功能标志

> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:126-130`（isEnvLessBridgeEnabled / tengu_bridge_repl_v2）
> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:141-148`（isCseShimEnabled / CSE → session_* 兼容 shim）
> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:185-189`（getCcrAutoConnectDefault / tengu_cobalt_harbor 自动连接）
> 📍 **源码位置**: `src/bridge/bridgeEnabled.ts:197-201`（isCcrMirrorEnabled / CCR 镜像模式）

- `tengu_ccr_bridge`：主开关，控制 Bridge 功能是否可用
- `tengu_bridge_repl_v2`：启用无环境变量的 REPL Bridge 路径（v2）
- `tengu_ccr_bridge_multi_session`：允许多会话模式
- `CCR_AUTO_CONNECT`：`tengu_cobalt_harbor` gate 控制是否所有 ant 用户默认自动连接 CCR
- `CCR_MIRROR`：单向镜像模式（outbound-only），每个本地 session 自动 spawn 一个镜像 Remote Control session

## 3. 通信协议

Bridge 系统采用分层通信架构：

### 3.1 传输层协议

> 📍 **源码位置**: `src/bridge/replBridge.ts:70-82`（ReplBridgeHandle 接口定义）
> 📍 **源码位置**: `src/bridge/replBridge.ts:83`（BridgeState：'ready' | 'connected' | 'reconnecting' | 'failed'）

**v1 协议（HybridTransport）**：
- WebSocket 用于读取服务器消息
- HTTP POST 用于向服务器写入消息
- 使用 OAuth Token 进行身份验证

**v2 协议（CCR v2）**：
- SSE（Server-Sent Events）用于读取
- HTTP POST 到 `/worker/*` 端点用于写入
- 使用 JWT（JSON Web Token）进行身份验证
- 支持 worker epoch 机制处理并发

### 3.2 消息类型

```typescript
type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}

type WorkResponse = {
  id: string
  type: 'work'
  environment_id: string
  state: string
  data: WorkData
  secret: string // base64url 编码的 JSON
  created_at: string
}
```

### 3.3 控制消息

服务器可以发送控制请求：
- `initialize`：初始化会话
- `set_model`：切换模型
- `set_max_thinking_tokens`：设置最大思考令牌数
- `set_permission_mode`：设置权限模式
- `interrupt`：中断当前操作

## 4. IDE 扩展架构

### 4.1 架构关系

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   IDE 扩展      │◄───►│   Claude Code    │◄───►│  Claude.ai 云端  │
│ (VS Code/IDEA)  │     │   Bridge 系统     │     │   服务           │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### 4.2 核心组件

> 📍 **源码位置**: `src/bridge/replBridge.ts`（REPL Bridge 核心，2406行）
> 📍 **源码位置**: `src/bridge/sessionRunner.ts`（子进程管理，MAX_ACTIVITIES=10）
> 📍 **源码位置**: `src/bridge/bridgeApi.ts`（Claude.ai API 通信）

**bridgeMain.ts**：Bridge 主循环，处理多会话的调度和管理

**replBridge.ts**：REPL 会话的 Bridge 核心实现，包括：
- 环境注册与发现
- 工作项轮询（poll loop）
- 传输层管理（WebSocket/SSE）
- 会话生命周期管理

**sessionRunner.ts**：子进程会话管理器，负责：
- 生成 Claude Code 子进程
- 解析 NDJSON 输出
- 提取工具活动信息（MAX_ACTIVITIES=10，MAX_STDERR_LINES=10）
- 处理权限请求

**bridgeApi.ts**：与 Claude.ai API 通信的客户端：
- 注册/注销环境
- 轮询工作项
- 确认工作
- 心跳保活

**补充发现（Q&A 学习）**：
- `sessionRunner.ts` 的 `TOOL_VERBS` map 将工具名转换为人类可读动词：`Read→Reading`, `Bash→Running`, `Glob→Searching` 等，用于 Bridge UI 状态显示
- `safeFilenameId()` 将 session ID 中非 `[a-zA-Z0-9_-]` 字符替换为 `_`，防止路径穿越攻击

## 5. 文件同步机制

Bridge 系统通过以下方式实现文件上下文同步：

### 5.1 Git 上下文

> 📍 **源码位置**: `src/bridge/replBridge.ts:91-120`（BridgeCoreParams 接口：dir, branch, gitRepoUrl 等）

在注册 Bridge 环境时，系统会收集 Git 信息：

```typescript
type BridgeConfig = {
  dir: string              // 工作目录
  machineName: string      // 机器名称
  branch: string          // 当前分支
  gitRepoUrl: string | null // Git 仓库 URL
  // ...
}
```

### 5.2 文件变更检测

当 Claude Code 在 Bridge 模式下执行文件操作时：
1. 工具调用（FileWriteTool、FileEditTool 等）会生成活动事件
2. 事件通过 Bridge 传输到服务器
3. IDE 扩展可以订阅这些事件并更新界面

### 5.3 Worktree 模式

在多会话场景下，支持 Git Worktree 隔离：
- 每个会话获得独立的 Git Worktree
- 防止并发会话之间的文件冲突
- 自动创建和清理 Worktree

## 6. 光标位置感知

Bridge 系统通过 Display Tags 机制感知 IDE 中的光标位置：

```typescript
// 当用户在 IDE 中打开文件时，会注入上下文
const ideContext = `<ide_opened_file path="${filePath}" cursor_line="${line}" cursor_column="${column}">`
```

这些标签会被：
1. IDE 扩展注入到用户消息中
2. Bridge 系统提取并传输到服务器
3. Claude 在回复时参考这些信息

## 7. 差异应用（Diff Application）

Bridge 系统支持将 Claude 生成的编辑应用回 IDE：

### 7.1 编辑工具流程

1. Claude 生成 `FileEditTool` 或 `FileWriteTool` 调用
2. 工具执行后产生结果消息
3. Bridge 将结果通过 WebSocket/SSE 发送到服务器
4. IDE 扩展接收并应用变更

### 7.2 权限控制

> 📍 **源码位置**: `src/bridge/sessionRunner.ts:33-43`（PermissionRequest 类型：can_use_tool subtype）

编辑操作需要用户授权：

```typescript
type PermissionRequest = {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
    tool_use_id: string
  }
}
```

## 8. 诊断集成

Bridge 系统与 LSP（Language Server Protocol）集成：

### 8.1 诊断信息流向

```
IDE LSP 客户端 → Bridge → Claude Code → 模型上下文
```

### 8.2 被动反馈

`passiveFeedback.ts` 收集 IDE 提供的诊断信息：
- 编译错误
- 类型检查错误
- Lint 警告
- 代码风格问题

这些信息会作为上下文提供给 Claude，帮助其理解代码问题。

## 9. 终端集成

Bridge 模式下的终端输出处理：

### 9.1 输出捕获

`sessionRunner.ts` 捕获子进程的输出：
- stdout：NDJSON 格式的结构化消息
- stderr：错误日志和调试信息

### 9.2 活动追踪

> 📍 **源码位置**: `src/bridge/sessionRunner.ts:16-17`（MAX_ACTIVITIES=10, MAX_STDERR_LINES=10）
> 📍 **源码位置**: `src/bridge/sessionRunner.ts:70-80`（TOOL_VERBS map）

系统会提取并显示当前活动：

```typescript
type SessionActivity = {
  type: 'tool_start' | 'text' | 'result' | 'error'
  summary: string  // 例如："Editing src/foo.ts"
  timestamp: number
}
```

### 9.3 状态显示

Bridge UI 会显示：
- 当前活动状态
- 会话数量
- 连接状态
- 仓库和分支信息

## 10. DAEMON 模式

DAEMON 模式允许 Bridge 作为后台进程运行：

### 10.1 启动方式

```bash
claude remote-control  # 启动 Bridge 守护进程
```

### 10.2 特性

- **持久化**：会话在 CLI 退出后保持活跃
- **崩溃恢复**：通过 `bridge-pointer.json` 文件恢复会话
- **多会话支持**：可以同时处理多个会话
- **心跳保活**：定期发送心跳维持连接

### 10.3 会话生命周期

```
创建 → 注册环境 → 轮询工作 → 连接传输 → 处理消息 → 归档
```

## 11. 安全考虑

### 11.1 本地通信

Bridge 系统遵循**仅本地通信**原则：
- 所有与 IDE 的通信都在本地进行
- 不开放外部网络端口
- 使用本地文件和进程间通信

### 11.2 身份验证

> 📍 **源码位置**: `src/bridge/jwtUtils.ts:21-32`（decodeJwtPayload：支持 sk-ant-si- 前缀剥离）
> 📍 **源码位置**: `src/bridge/jwtUtils.ts:52-62`（TOKEN_REFRESH_BUFFER_MS=5min, FALLBACK_REFRESH_INTERVAL_MS=30min, MAX_REFRESH_FAILURES=3）
> 📍 **源码位置**: `src/bridge/jwtUtils.ts:72-255`（createTokenRefreshScheduler：generation counter 防孤儿定时器）

**OAuth 流程**：
1. 用户通过 `claude auth login` 登录
2. 获取 OAuth Token 存储在系统密钥链
3. Bridge 使用 Token 与 Claude.ai 通信

**JWT 机制**（v2）：
- 每个会话获得独立的 JWT
- Token 包含 session_id 声明
- 支持 Token 刷新和重新分发

**补充发现（Q&A 学习）**：
- JWT 刷新在到期前 **5分钟** 提前触发（`TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000`）
- 失败降级：`FALLBACK_REFRESH_INTERVAL_MS = 30min`（Token 不是可解码 JWT 时的兜底间隔）
- `MAX_REFRESH_FAILURES = 3`：连续3次失败后放弃刷新链
- `generation counter` 机制：每次 `schedule()`/`cancel()` 递增世代号，`doRefresh()` 异步完成后检查世代号是否变化，避免孤儿定时器重复触发
- `decodeJwtPayload()` 自动剥离 `sk-ant-si-` session ingress 前缀，支持两种 token 格式

### 11.3 权限控制

- 工具调用需要用户明确授权
- 支持自动模式、计划模式等多种权限模式
- 组织策略可以禁用远程控制功能

### 11.4 数据隐私

- 会话数据仅在用户设备和 Claude.ai 之间传输
- 支持 `outboundOnly` 模式（仅出站，不接收远程指令）
- 诊断日志中排除 PII（个人身份信息）

## 12. 配置与调试

### 12.1 环境变量

```bash
# 启用调试日志
CLAUDE_BRIDGE_DEBUG=1

# 强制使用 CCR v2
CLAUDE_BRIDGE_USE_CCR_V2=1

# 自定义 Session Ingress URL
CLAUDE_BRIDGE_SESSION_INGRESS_URL=https://...

# 强制沙盒模式
CLAUDE_CODE_FORCE_SANDBOX=1
```

### 12.2 调试文件

Bridge 会话的调试日志默认存储在：
```
/tmp/claude/bridge-session-{sessionId}.log
```

### 12.3 故障排查

常见问题及解决：
- **连接失败**：检查 OAuth Token 是否过期，运行 `claude auth login`
- **会话超时**：Bridge 会话默认 24 小时超时
- **环境丢失**：网络中断后自动重连，最多重试 3 次

## 13. 总结

Bridge 系统是 Claude Code 与 IDE 生态集成的关键基础设施。它通过分层架构实现了：

1. **松耦合**：CLI 与 IDE 通过标准协议通信
2. **高可用**：支持重连、恢复和多会话
3. **安全性**：本地通信、OAuth 认证、权限控制
4. **可扩展**：支持 v1/v2 协议，便于未来扩展

理解 Bridge 系统有助于开发者更好地利用 Claude Code 的远程控制能力，以及开发自定义的 IDE 集成方案。

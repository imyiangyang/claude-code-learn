# Claude Code 泄露源码分析 — MCP 集成

> 📍 **核心源文件**: `src/services/mcp/client.ts`（连接管理，~1700行）, `src/services/mcp/config.ts`（配置管理，~1578行）, `src/services/mcp/types.ts`（类型定义，258行）

## 什么是 MCP

**MCP (Model Context Protocol)** 是 Anthropic 推出的开放协议，用于标准化 AI 助手与外部工具、资源和服务的集成方式。它定义了一套统一的接口规范，让 Claude 等 AI 模型能够无缝调用各种外部功能，无需为每个服务编写定制化集成代码。

MCP 的核心价值在于：
- **标准化接口**：统一的工具发现、调用和资源访问协议
- **可扩展性**：第三方开发者可以为 Claude 提供新能力
- **安全性**：所有工具调用都经过权限系统管控
- **灵活性**：支持多种传输方式（stdio、SSE、HTTP、WebSocket）

## Claude Code 中的 MCP 角色

在 Claude Code 中，MCP 服务器扮演着**能力扩展插件**的角色。它们让 Claude 能够：

1. **访问外部 API**：如 Slack、GitHub、数据库等
2. **执行特定任务**：如代码审查、测试运行、部署操作
3. **读取外部资源**：如文档、配置文件、日志
4. **使用预定义提示**：如标准化的代码审查模板

MCP 服务器与 Claude Code 内置工具（如 BashTool、FileReadTool）并列工作，通过统一的工具注册机制暴露给 LLM。

## MCP 客户端实现

> 📍 **源码位置**: `src/services/mcp/client.ts:595`（connectToServer memoize）

Claude Code 的 MCP 客户端核心位于 `src/services/mcp/client.ts`，其主要职责包括：

### 连接管理

> 📍 **源码位置**: `src/services/mcp/client.ts:595`（connectToServer = memoize(...)，key=`${name}-${jsonStringify(serverRef)}`）
> 📍 **源码位置**: `src/services/mcp/client.ts:457`（getConnectionTimeoutMs：MCP_TIMEOUT env var 或默认 30000ms）
> 📍 **源码位置**: `src/services/mcp/client.ts:463`（MCP_REQUEST_TIMEOUT_MS = 60000，单次请求超时）
> 📍 **源码位置**: `src/services/mcp/client.ts:471`（MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'）
> 📍 **源码位置**: `src/services/mcp/client.ts:492-550`（wrapFetchWithTimeout：GET 跳过超时保 SSE 长连接，POST 加60s）
> 📍 **源码位置**: `src/services/mcp/client.ts:985-1001`（Client 创建，声明 roots + elicitation capabilities）

```typescript
// 连接到 MCP 服务器的核心函数
export const connectToServer = memoize(async (
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<MCPServerConnection> => {
  // 根据配置类型创建对应传输层
  let transport
  
  if (serverRef.type === 'sse') {
    transport = new SSEClientTransport(new URL(serverRef.url), transportOptions)
  } else if (serverRef.type === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(serverRef.url), transportOptions)
  } else if (serverRef.type === 'ws') {
    transport = new WebSocketTransport(wsClient)
  } else {
    // 默认 stdio 类型
    transport = new StdioClientTransport({
      command: serverRef.command,
      args: serverRef.args,
      env: serverRef.env,
    })
  }
  
  const client = new Client({
    name: 'claude-code',
    version: MACRO.VERSION,
  })
  
  await client.connect(transport)
  // ...
})
```

**补充发现（Q&A 学习）**：
- `connectToServer` 使用 `memoize` 缓存，key 为 `${name}-${jsonStringify(serverRef)}`，确保相同配置不重复建立连接
- 连接超时由 `MCP_TIMEOUT` 环境变量控制，默认 30000ms（30秒）
- 单次请求超时 `MCP_REQUEST_TIMEOUT_MS = 60000`（60秒），独立于连接超时
- `wrapFetchWithTimeout` 对 GET 请求不加超时（保护 SSE 长连接），对 POST 请求添加 60s 超时
- 超时实现用 `setTimeout+clearTimeout` 而非 `AbortSignal.timeout()`，原因是 Bun 的 GC 懒惰会导致 AbortSignal 提前被回收
- Client 声明 `roots`（项目路径感知）和 `elicitation`（用户输入请求）两种 capability

**并发批次控制**：
> 📍 **源码位置**: `src/services/mcp/client.ts:552-554`（getMcpServerConnectionBatchSize：local 默认3并发）
> 📍 **源码位置**: `src/services/mcp/client.ts:556-560`（remote 默认20并发）

- 本地 stdio server 启动批大小默认 3（防止同时产生过多子进程）
- 远程 server 连接批大小默认 20（网络连接开销低，可并发更多）

### 工具发现与注册

> 📍 **源码位置**: `src/services/mcp/client.ts:218`（MAX_MCP_DESCRIPTION_LENGTH = 2048）
> 📍 **源码位置**: `src/services/mcp/client.ts:568`（ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']）
> 📍 **源码位置**: `src/services/mcp/client.ts:1159`（server instructions 截断逻辑，超出加 '… [truncated]'）

连接成功后，客户端会：
1. 查询服务器能力（tools、resources、prompts）
2. 将 MCP 工具转换为 Claude Code 内部 Tool 对象
3. 注册到工具系统中，供 LLM 调用

**补充发现（Q&A 学习）**：
- `MAX_MCP_DESCRIPTION_LENGTH = 2048`：严格限制工具描述长度，防止 OpenAPI 类服务器塞入 15-60KB 的 OpenAPI 文档
- IDE 工具白名单 `ALLOWED_IDE_TOOLS`：仅 `mcp__ide__executeCode` 和 `mcp__ide__getDiagnostics` 被允许（安全限制）
- Server instructions 超过长度限制时自动截断并加 `… [truncated]` 后缀
- 工具名格式：`mcp__{serverName}__{toolName}`，特殊字符通过 `normalizeNameForMCP` 转义

### 工具超时

> 📍 **源码位置**: `src/services/mcp/client.ts:211`（DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000，约27.8小时）

```typescript
// 工具调用超时近似"无限"——让工具自然完成
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000 // ~27.8 小时
```

**补充发现（Q&A 学习）**：
- `DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000`（~27.8小时），实际上是"近似无限"的设计
- 这体现了 MCP 工具可能执行长时间任务（如大型代码分析、数据库迁移）的设计哲学
- 与连接超时（30s）和请求超时（60s）形成三层独立的超时机制

## MCP 服务器类型

> 📍 **源码位置**: `src/services/mcp/types.ts:10-20`（ConfigScope：local | user | project | dynamic | enterprise | claudeai | managed）
> 📍 **源码位置**: `src/services/mcp/types.ts:221-226`（MCPServerConnection 五种状态：connected | failed | needs-auth | pending | disabled）

Claude Code 支持多种 MCP 服务器类型（共7种 transport）：

### 1. stdio 服务器（子进程）

> 📍 **源码位置**: `src/services/mcp/client.ts`（StdioClientTransport 创建，子进程管理）

通过启动本地子进程运行 MCP 服务器，适用于本地工具。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### 2. SSE 服务器（HTTP Server-Sent Events）

通过 SSE 协议连接远程 MCP 服务器，支持实时双向通信。

```json
{
  "mcpServers": {
    "remote-api": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

### 3. HTTP 服务器（Streamable HTTP）

基于 HTTP POST/GET 的请求/响应模式，符合 MCP Streamable HTTP 规范。

```json
{
  "mcpServers": {
    "http-service": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "oauth": {
        "clientId": "client-id",
        "authServerMetadataUrl": "https://auth.example.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

### 4. WebSocket 服务器

通过 WebSocket 协议连接，支持 IDE 集成等场景。

```json
{
  "mcpServers": {
    "ide-bridge": {
      "type": "ws",
      "url": "ws://localhost:8080/mcp"
    }
  }
}
```

### 5. claude.ai 代理服务器

> 📍 **源码位置**: `src/services/mcp/config.ts:171-193`（CCR_PROXY_PATH_MARKERS、unwrapCcrProxyUrl 提取原始 vendor URL）

通过 claude.ai 的 MCP 代理服务连接，用于远程会话场景。

```json
{
  "mcpServers": {
    "claude-ai-connector": {
      "type": "claudeai-proxy",
      "id": "connector-id",
      "url": "https://proxy.claude.ai/mcp/connector-id"
    }
  }
}
```

**补充发现（Q&A 学习）**：
- CCR proxy URL 会被 `unwrapCcrProxyUrl()` 解包，提取原始 vendor URL 用于去重比较
- `CCR_PROXY_PATH_MARKERS` 识别 claude.ai 代理 URL 的路径特征

### 6. SDK 服务器

由 IDE 扩展（VS Code、JetBrains）通过 SDK 直接管理。

```json
{
  "mcpServers": {
    "claude-vscode": {
      "type": "sdk",
      "name": "claude-vscode"
    }
  }
}
```

### 7. in-process 服务器（进程内）

**补充发现（Q&A 学习）**：
- 部分特殊服务器（如 Chrome 浏览器集成、ComputerUse 屏幕控制）以 `in-process` 方式运行，直接在 Claude Code 进程内通信
- 无需 stdio/网络开销，延迟极低

### 服务器连接状态

> 📍 **源码位置**: `src/services/mcp/types.ts:221-226`（MCPServerConnection 五种状态）

```typescript
type ConnectionStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
```

| 状态 | 含义 |
|---|---|
| `connected` | 已成功连接并可用 |
| `failed` | 连接失败（网络错误、进程崩溃等） |
| `needs-auth` | OAuth 认证失败，需要用户重新授权 |
| `pending` | 连接中（初始化阶段） |
| `disabled` | 被用户或配置明确禁用 |

## MCP 工具注册

> 📍 **源码位置**: `src/services/mcp/client.ts`（buildMcpToolName，工具名 normalizeNameForMCP）

MCP 工具的注册流程：

1. **发现阶段**：连接服务器后，调用 `client.listTools()` 获取可用工具列表
2. **转换阶段**：将 MCP 工具定义转换为 Claude Code 的 `Tool` 对象
3. **命名空间**：工具名格式为 `mcp__{serverName}__{toolName}`
4. **注册阶段**：添加到工具注册表，与内置工具统一处理

```typescript
// 工具名构建示例
function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`
}
// 结果如: mcp__filesystem__read_file
```

## MCP 资源

MCP 资源允许服务器暴露可读取的数据源：

- **文件资源**：如配置文件、日志文件
- **API 资源**：如 REST API 端点返回的数据
- **动态资源**：如数据库查询结果

Claude Code 通过 `ListMcpResourcesTool` 和 `ReadMcpResourceTool` 提供资源访问能力。

## MCP 提示

MCP 提示（Prompts）是服务器预定义的提示模板：

```typescript
// 提示发现
const prompts: ListPromptsResult = await client.listPrompts()

// 提示使用
const result = await client.getPrompt({
  name: 'code-review',
  arguments: { language: 'typescript' }
})
```

提示可用于标准化常见任务，如代码审查、重构建议等。

## MCP 配置

> 📍 **源码位置**: `src/services/mcp/config.ts:1232-1238`（配置合并顺序：plugin < user < project < local）
> 📍 **源码位置**: `src/services/mcp/config.ts:1083-1096`（enterprise config 排他控制）
> 📍 **源码位置**: `src/services/mcp/config.ts:1470`（doesEnterpriseMcpConfigExist = memoize(...)）

MCP 服务器配置存储在多个位置，按优先级合并：

### 配置文件位置

1. **项目级**：`.mcp.json`（当前目录及父目录）
2. **用户级**：`~/.claude/config.json` 中的 `mcpServers`
3. **本地级**：`.claude/config.json`（项目本地配置）
4. **企业级**：`~/.claude/managed/managed-mcp.json`
5. **动态配置**：通过 `--mcp-config` 参数传入
6. **claude.ai**：从 claude.ai 获取的连接器配置

### 配置示例

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"]
    },
    "github": {
      "type": "sse",
      "url": "https://mcp.github.com/sse",
      "oauth": {
        "clientId": "github-mcp-client",
        "authServerMetadataUrl": "https://github.com/.well-known/oauth-authorization-server"
      }
    },
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/db"]
    }
  }
}
```

### 配置优先级

> 📍 **源码位置**: `src/services/mcp/config.ts:1232-1238`

配置按以下顺序合并（后加载的覆盖先加载的）：

1. 插件提供的 MCP 服务器（最低优先级）
2. 用户级配置
3. 项目级配置（从根目录到当前目录）
4. 本地级配置（最高优先级）

**补充发现（Q&A 学习）**：
- 正确合并顺序是 `plugin < user < project < local`（源码注释文档之前有误，claude.ai 连接器是独立处理的）
- 配置合并用 Map 按 key 覆盖，后加载的 scope 覆盖先加载的同名 server

### Enterprise 排他控制

> 📍 **源码位置**: `src/services/mcp/config.ts:1083-1096`（enterprise config 存在时完全跳过其他来源）
> 📍 **源码位置**: `src/services/mcp/config.ts:1485-1489`（shouldAllowManagedMcpServersOnly）

**补充发现（Q&A 学习）**：
- 当 `~/.claude/managed/managed-mcp.json` 存在时，**完全跳过** plugin、user、project、local 所有其他配置来源
- `shouldAllowManagedMcpServersOnly()` 检查是否只允许 managed server
- `doesEnterpriseMcpConfigExist` 使用 `memoize` 缓存文件存在检查结果

### 去重逻辑

> 📍 **源码位置**: `src/services/mcp/config.ts:202-212`（getMcpServerSignature：stdio用`stdio:${cmd}`，remote用`url:${url}`）
> 📍 **源码位置**: `src/services/mcp/config.ts:223-266`（dedupPluginMcpServers：manual 优先 plugin，plugin 间 first-loaded 获胜）
> 📍 **源码位置**: `src/services/mcp/config.ts:281-310`（dedupClaudeAiMcpServers：manual 优先 claudeai，disabled manual 不算去重目标）

**补充发现（Q&A 学习）**：
- `getMcpServerSignature()` 为每个 server 生成唯一签名：stdio 类型用命令路径，remote 类型用 URL
- `dedupPluginMcpServers()`：manual 配置优先于 plugin，plugin 间以 first-loaded 获胜
- `dedupClaudeAiMcpServers()`：manual 优先于 claude.ai；被 disabled 的 manual server **不参与**去重（不会屏蔽 claude.ai 的同名 server）

## MCP 权限

> 📍 **源码位置**: `src/services/mcp/config.ts:1485-1489`（shouldAllowManagedMcpServersOnly、filterMcpServersByPolicy）

MCP 工具调用同样受 Claude Code 权限系统管控：

```typescript
// MCPTool 的权限检查
async checkPermissions(): Promise<PermissionResult> {
  return {
    behavior: 'passthrough',
    message: 'MCPTool requires permission.',
  }
}
```

用户可以在以下模式中选择：
- **默认模式**：每次调用都询问
- **计划模式**：在计划阶段批量授权
- **自动模式**：信任后自动批准
- **绕过权限**：完全绕过（不推荐）

**补充发现（Q&A 学习）**：
- `allowedMcpServers` / `deniedMcpServers` 配置项允许按 server 名称设置白/黑名单
- `filterMcpServersByPolicy()` 在加载时过滤不符合企业策略的 server
- `shouldAllowManagedMcpServersOnly()` 为 true 时，非 managed server 全部被拒绝加载

## CONNECTOR_TEXT Feature Flag

`CONNECTOR_TEXT` 是一个与 MCP 连接器相关的功能标志：

```typescript
export const SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER = feature('CONNECTOR_TEXT')
  ? 'summarize-connector-text-2026-03-13'
  : ''
```

当启用时，Claude Code 会对 MCP 连接器返回的大量文本内容进行智能摘要，减少 token 消耗。

## 错误处理

### 连接错误

> 📍 **源码位置**: `src/services/mcp/client.ts:457`（getConnectionTimeoutMs）

```typescript
// 连接超时检测
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error(`MCP server "${name}" connection timed out`))
  }, getConnectionTimeoutMs())
})

await Promise.race([connectPromise, timeoutPromise])
```

### 会话过期

> 📍 **源码位置**: `src/services/mcp/client.ts:193-206`（isMcpSessionExpiredError：HTTP 404 AND JSON-RPC -32001）

HTTP 传输支持会话过期检测（404 + JSON-RPC -32001）：

```typescript
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus = 'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) return false
  return error.message.includes('"code":-32001')
}
```

**补充发现（Q&A 学习）**：
- **双条件检测**：必须同时满足 HTTP 404 状态码 AND JSON-RPC 错误码 -32001
- 单独 404 可能是网络错误；单独 -32001 是通用 JSON-RPC 错误，不代表 session 过期
- 检测到 session 过期后，清除 memoize 缓存，下次请求时自动重建连接

### 重连机制

> 📍 **源码位置**: `src/services/mcp/client.ts:1228`（MAX_ERRORS_BEFORE_RECONNECT = 3）

- 自动检测连接断开（ECONNRESET、ETIMEDOUT 等）
- 清除连接缓存，下次调用时重新连接
- `MAX_ERRORS_BEFORE_RECONNECT = 3`：连续 3 次错误后触发重连（重置 memoize 缓存）

**补充发现（Q&A 学习）**：
- `MAX_ERRORS_BEFORE_RECONNECT = 3`：不是无限重连，而是计数后清理缓存触发重新建立
- 错误计数器在成功调用时重置，只有**连续**3次失败才触发

### 认证失败

OAuth 认证失败时会进入 `needs-auth` 状态，提示用户重新授权。

## 实际使用示例

### 数据库 MCP 服务器

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/mydb"]
    }
  }
}
```

使用方式：
```
Claude: 查询数据库中所有用户表的结构
```

### GitHub MCP 服务器

```json
{
  "mcpServers": {
    "github": {
      "type": "sse",
      "url": "https://mcp.github.com/sse",
      "oauth": {
        "authServerMetadataUrl": "https://github.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

使用方式：
```
Claude: 查看我的最近提交的 PR 列表
```

### 文件系统 MCP 服务器

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
```

使用方式：
```
Claude: 列出项目目录下的所有 TypeScript 文件
```

### 自定义工具 MCP 服务器

开发者可以编写自定义 MCP 服务器：

```typescript
// 自定义 MCP 服务器示例
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server({
  name: 'my-custom-server',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},
  },
})

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [{
      name: 'custom_analysis',
      description: '执行自定义代码分析',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    }]
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

配置：
```json
{
  "mcpServers": {
    "custom": {
      "command": "node",
      "args": ["/path/to/custom-server.js"]
    }
  }
}
```

---

MCP 集成是 Claude Code 扩展能力的核心机制。通过标准化的协议，它让 Claude 能够安全、灵活地调用各种外部工具和服务，大大增强了 AI 助手的实用性。

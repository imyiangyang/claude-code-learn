# Claude Code 认证系统分析

> 📍 **核心源文件**: `src/services/oauth/index.ts`（OAuthService 主类）, `src/services/oauth/client.ts`（OAuth 客户端逻辑，566行）, `src/services/oauth/crypto.ts`（PKCE 加密，23行）, `src/services/oauth/auth-code-listener.ts`（本地回调服务器，211行）

## 概述

Claude Code 支持多种认证方式，包括 OAuth 2.0、API Key、以及第三方云服务提供商（Bedrock、Vertex AI、Foundry）的认证。默认情况下，Claude Code 优先使用 OAuth 认证，但在特定场景下会自动回退到 API Key 模式。

---

## 1. 认证方式对比

### 1.1 OAuth 认证（默认）

Claude Code 默认使用 OAuth 2.0 授权码流程进行认证。这种方式支持两种登录入口：

- **Claude.ai 订阅用户**：适用于 Pro、Max、Team、Enterprise 订阅用户
- **Anthropic Console 用户**：适用于按 API 使用量付费的用户

### 1.2 API Key 认证

在以下情况下，系统会使用 API Key 认证：

- 用户通过 `ANTHROPIC_API_KEY` 环境变量提供 API Key
- 使用 `--bare` 模式启动（仅支持 API Key）
- 配置文件中设置了 `apiKeyHelper` 脚本
- 使用第三方云服务（Bedrock、Vertex、Foundry）

### 1.3 第三方云服务认证

支持通过环境变量启用：

- `CLAUDE_CODE_USE_BEDROCK=1` — Amazon Bedrock
- `CLAUDE_CODE_USE_VERTEX=1` — Google Vertex AI
- `CLAUDE_CODE_USE_FOUNDRY=1` — Microsoft Foundry

---

## 2. OAuth 实现详解

### 2.1 授权流程

> 📍 **源码位置**: `src/services/oauth/index.ts`（OAuthService 主类，startOAuthFlow 方法）
> 📍 **源码位置**: `src/services/oauth/crypto.ts:11-22`（generateCodeVerifier, generateCodeChallenge, generateState：32字节随机+base64url）

OAuth 实现位于 `src/services/oauth/` 目录，核心组件包括：

```
src/services/oauth/
├── index.ts           # OAuthService 主类
├── client.ts          # OAuth 客户端逻辑
├── crypto.ts          # PKCE 加密工具
├── auth-code-listener.ts  # 本地回调服务器
└── getOauthProfile.ts # 用户信息获取
```

**补充发现（Q&A 学习）**：
- `generateCodeVerifier()` 使用 `randomBytes(32)` 生成 32 字节随机数，转 base64url
- `generateCodeChallenge()` 使用 SHA-256 对 verifier 哈希，符合 PKCE 规范（RFC 7636）
- `generateState()` 同样 32 字节随机 base64url，用于 CSRF 防护
- `code_challenge_method` 固定为 `S256`（SHA-256）

### 2.2 授权 URL 构造

> 📍 **源码位置**: `src/services/oauth/client.ts:46-105`（buildAuthUrl：构造 PKCE OAuth URL）

授权 URL 通过 `buildAuthUrl()` 函数构造，支持以下参数：

- `codeChallenge` — PKCE 代码挑战
- `state` — CSRF 防护状态参数
- `redirect_uri` — 回调地址（自动或手动模式）
- `scope` — 请求的权限范围
- `login_hint` — 预填充邮箱地址
- `login_method` — 指定登录方式（sso、magic_link、google）

**补充发现（Q&A 学习）**：
- URL 中固定附加 `code=true` 参数，告诉登录页面显示 Claude Max 升级提示
- `inferenceOnly` 模式只请求 `CLAUDE_AI_INFERENCE_SCOPE` 一个 scope（长期推理 token，用于 setup-token / CLAUDE_CODE_OAUTH_TOKEN 场景）
- 普通登录请求 `ALL_OAUTH_SCOPES`（所有完整权限）
- Claude.ai 和 Console 使用不同的授权 URL（`getOauthConfig()` 返回环境对应的端点）

### 2.3 双模式回调处理

> 📍 **源码位置**: `src/services/oauth/auth-code-listener.ts:18-211`（AuthCodeListener：临时 HTTP 服务器监听回调）
> 📍 **源码位置**: `src/services/oauth/auth-code-listener.ts:37-52`（start(port?)：绑定端口0让 OS 分配可用端口）
> 📍 **源码位置**: `src/services/oauth/auth-code-listener.ts:152-175`（validateAndRespond：state 验证 CSRF）
> 📍 **源码位置**: `src/services/oauth/index.ts:70-90`（同时监听自动和手动，isAutomaticFlow 通过 hasPendingResponse() 判断）

Claude Code 支持两种授权码获取方式：

**自动模式**：
- 启动本地 HTTP 服务器监听回调
- 自动打开浏览器完成授权
- 授权码通过 `http://localhost:{port}/callback` 自动接收
- 服务器绑定端口 `0`，让 OS 分配一个空闲端口（避免端口冲突）

**手动模式**：
- 用户复制浏览器中的授权码
- 在终端粘贴授权码完成认证
- 适用于无浏览器环境或远程会话

**补充发现（Q&A 学习）**：
- 回调服务器先 `start()` 后才 `onReady()`，确保端口绑定完成后才打开浏览器（避免竞争）
- `hasPendingResponse()` 通过检查 `pendingResponse` 是否有值判断是否走了自动流程（自动模式下浏览器会发来 callback 请求，服务器保留响应对象）
- state 不匹配时立即返回 HTTP 400 并 reject promise
- `skipBrowserOpen` 选项：用于 SDK 控制协议（`claude_authenticate`），让 SDK 客户端自己决定如何打开浏览器

### 2.4 Token 存储与刷新

> 📍 **源码位置**: `src/services/oauth/client.ts:146-250`（refreshOAuthToken：刷新逻辑 + 跳过 profile 请求优化）

**存储位置**：
- macOS：系统 Keychain（`Claude Code-credentials` 服务）
- 其他平台：明文配置文件（`~/.claude/.credentials.json`）

**Token 刷新机制**：
- 自动检测 Token 过期（提前 5 分钟缓冲）
- 使用 `refresh_token` 获取新的 `access_token`
- 支持并发请求的刷新去重（通过文件锁实现）
- 最大重试次数：5 次

**补充发现（Q&A 学习）**：
- **profile 请求跳过优化**：刷新时检查 `config.oauthAccount` 和现有 token 是否已有完整 profile 数据，有则跳过 `/api/oauth/profile` 请求，**可减少约 700万次/天的 API 请求**
- 跳过条件：`billingType`、`accountCreatedAt`、`subscriptionCreatedAt`、`subscriptionType`、`rateLimitTier` 全部存在
- 即使跳过 profile 请求，displayName 和 hasExtraUsageEnabled 等字段仍会在有新值时更新
- `refreshToken` 如果后端没有返回新的，复用旧的（`newRefreshToken = refreshToken`）

### 2.5 OAuth Scope 定义

```typescript
// Claude.ai 用户 Scope
const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',           // 用户信息
  'user:inference',         // 推理权限
  'user:sessions:claude_code', // Claude Code 会话
  'user:mcp_servers',       // MCP 服务器管理
  'user:file_upload',       // 文件上传
]

// Console 用户 Scope
const CONSOLE_OAUTH_SCOPES = [
  'org:create_api_key',     // 创建 API Key
  'user:profile',
]
```

---

## 3. Keychain 集成与启动优化

### 3.1 `startKeychainPrefetch()` 函数

为了优化启动速度，Claude Code 在 `main.tsx` 初始化阶段并行预读取 Keychain：

```typescript
// main.tsx — 在模块导入前启动
startKeychainPrefetch()
```

**预读取内容**：
- OAuth Token（`Claude Code-credentials`）— 约 32ms
- 传统 API Key（`Claude Code`）— 约 33ms

**性能优化**：
- 并行执行两个 Keychain 读取操作
- 与模块导入过程重叠执行
- 缓存结果供后续同步读取使用

### 3.2 macOS Keychain 存储实现

位于 `src/utils/secureStorage/macOsKeychainStorage.ts`：

**安全特性**：
- 使用 `security` 命令行工具与 Keychain 交互
- 数据以十六进制编码存储，避免命令行参数泄露
- 优先使用 `security -i` 交互模式（防止进程监控工具捕获密码）
- 超过 4096 字节时回退到命令行参数模式

**缓存策略**：
- 30 秒 TTL 缓存减少 Keychain 访问频率
- 错误时返回缓存数据（stale-while-error）
- 支持异步读取避免阻塞渲染线程

### 3.3 跨平台回退方案

非 macOS 平台使用明文存储：

```typescript
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  return plainTextStorage
}
```

---

## 4. API Key 存储机制

### 4.1 存储位置优先级

1. **macOS Keychain** — 首选存储位置
2. **全局配置文件** — `~/.claude/settings.json` 中的 `primaryApiKey`
3. **环境变量** — `ANTHROPIC_API_KEY`

### 4.2 安全存储流程

```typescript
export async function saveApiKey(apiKey: string): Promise<void> {
  // 1. 验证 API Key 格式
  if (!isValidApiKey(apiKey)) {
    throw new Error('Invalid API key format')
  }

  // 2. 尝试写入 Keychain
  if (process.platform === 'darwin') {
    const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')
    const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`
    await execa('security', ['-i'], { input: command })
  }

  // 3. 更新配置文件
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
    customApiKeyResponses: { approved: [...approved, normalizedKey] }
  }))
}
```

### 4.3 API Key 验证

API Key 格式验证规则：
- 仅允许字母数字、连字符、下划线
- 正则表达式：`/^[a-zA-Z0-9-_]+$/`

---

## 5. 多账户支持

### 5.1 当前限制

Claude Code 设计上**不支持同时登录多个账户**。每次登录会：

1. 清除现有认证状态（`performLogout`）
2. 保存新的认证凭据
3. 重置所有与账户相关的缓存

### 5.2 账户切换流程

```typescript
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // 1. 清除旧状态
  await performLogout({ clearOnboarding: false })

  // 2. 保存新 Token
  saveOAuthTokensIfNeeded(tokens)

  // 3. 获取用户信息
  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  storeOAuthAccountInfo({
    accountUuid: profile.account.uuid,
    emailAddress: profile.account.email,
    organizationUuid: profile.organization.uuid,
  })
}
```

### 5.3 组织强制登录

企业环境可通过 `forceLoginOrgUUID` 设置强制用户登录到指定组织：

```typescript
export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  const requiredOrgUuid = getSettingsForSource('policySettings')?.forceLoginOrgUUID
  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)

  if (tokenOrgUuid !== requiredOrgUuid) {
    return {
      valid: false,
      message: `Your authentication token belongs to organization ${tokenOrgUuid},
but this machine requires organization ${requiredOrgUuid}.`
    }
  }
}
```

---

## 6. 企业 SSO 支持

### 6.1 SSO 登录方式

> 📍 **源码位置**: `src/services/oauth/client.ts:100-102`（login_method 参数注入）

Claude Code 支持通过 `--sso` 标志触发 SSO 登录：

```bash
claude auth login --sso
```

这会在授权 URL 中添加 `login_method=sso` 参数，引导用户通过企业身份提供商登录。

### 6.2 XAA（跨应用访问）

XAA 允许企业用户使用单一 IdP 登录访问多个 MCP 服务器：

```typescript
// 配置 XAA
claude mcp xaa setup --issuer <url> --client-id <id> --client-secret
```

**工作流程**：
1. 从 IdP 获取 `id_token`（浏览器登录一次）
2. 使用 RFC 8693 Token Exchange 获取各 MCP 服务器的访问令牌
3. 令牌存储在 Keychain 中，后续自动刷新

---

## 7. 认证状态持久化

### 7.1 持久化数据

认证状态持久化在以下位置：

**macOS**：
- Keychain：`Claude Code-credentials`（OAuth Token）
- Keychain：`Claude Code`（传统 API Key）
- 配置文件：`~/.claude/settings.json`（账户元数据）

**其他平台**：
- 凭证文件：`~/.claude/.credentials.json`
- 配置文件：`~/.claude/settings.json`

### 7.2 跨进程同步

为避免多进程并发修改凭证，Claude Code 使用文件锁：

```typescript
const release = await lockfile.lock(claudeDir)
try {
  // 读取并更新 Token
} finally {
  await release()
}
```

### 7.3 缓存失效策略

- **内存缓存**：使用 `memoize` 缓存 Token 读取结果
- **文件修改检测**：通过比较 `mtimeMs` 检测凭证文件变更
- **401 错误处理**：收到 401 响应时自动清除缓存并尝试刷新

---

## 8. 认证 UI 流程

### 8.1 `/login` 命令

登录命令实现位于 `src/commands/login/login.tsx`：

**UI 状态机**：
1. `idle` — 等待用户选择登录方式
2. `ready_to_start` — 准备启动 OAuth 流程
3. `waiting_for_login` — 等待浏览器授权完成
4. `success` — 登录成功
5. `error` — 登录失败

**登录选项**：
- Claude 订阅账户（Pro、Max、Team、Enterprise）
- Anthropic Console 账户（API 计费）
- 第三方平台（Bedrock、Foundry、Vertex AI）

### 8.2 `/logout` 命令

登出命令实现位于 `src/commands/logout/logout.tsx`：

**清理操作**：
1. 刷新并清空遥测数据
2. 删除 API Key
3. 清除 Keychain 中的凭证
4. 清除所有认证相关缓存
5. 重置 GrowthBook 特性标志

### 8.3 终端界面组件

> 📍 **源码位置**: `src/services/oauth/auth-code-listener.ts:80-105`（handleSuccessRedirect：根据 scope 跳转不同成功页面）

`ConsoleOAuthFlow` 组件提供完整的终端 OAuth 体验：

- 显示登录方式选择菜单
- 自动打开浏览器并显示等待状态
- 支持手动复制粘贴授权码
- 错误提示和重试机制
- 登录成功通知

**补充发现（Q&A 学习）**：
- 成功重定向页面根据 scope 区分：Claude.ai scope → `CLAUDEAI_SUCCESS_URL`，Console scope → `CONSOLE_SUCCESS_URL`
- 支持 `customHandler` 注入自定义成功响应（SDK 控制协议场景）
- 回调服务器在收到 code 后不立即关闭，保留 `pendingResponse` 等待上层完成 token 交换后再重定向浏览器

---

## 9. 安全考量

### 9.1 Token 安全

**传输安全**：
- 所有 OAuth 通信使用 HTTPS
- PKCE 防止授权码拦截攻击
- State 参数防止 CSRF 攻击

**存储安全**：
- macOS 使用系统 Keychain 加密存储
- 其他平台使用文件系统权限保护
- Token 不输出到日志或终端

**Token 轮换**：
- Access Token 有效期较短（默认 1 小时）
- Refresh Token 用于获取新的 Access Token
- 支持 Token 撤销（RFC 7009）

### 9.2 防泄露措施

**命令行保护**：
- API Key 从不作为命令行参数传递
- 使用 `security -i` 交互模式避免进程监控
- 十六进制编码防止简单字符串匹配

**日志脱敏**：
- 授权码、Token 等敏感信息不记录
- URL 参数中的敏感字段被替换为 `[REDACTED]`
- 错误信息中过滤 Token 内容

### 9.3 信任检查

对于项目级配置（如 `apiKeyHelper`），执行前检查工作区信任状态：

```typescript
if (isApiKeyHelperFromProjectOrLocalSettings()) {
  const hasTrust = checkHasTrustDialogAccepted()
  if (!hasTrust && !getIsNonInteractiveSession()) {
    throw new Error('Security: apiKeyHelper executed before workspace trust is confirmed')
  }
}
```

---

## 10. 命令行接口

### 10.1 `claude auth login`

```bash
# 标准登录（自动选择登录方式）
claude auth login

# 强制使用 Claude.ai 登录
claude auth login --claudeai

# 强制使用 Console 登录
claude auth login --console

# 使用 SSO 登录
claude auth login --sso

# 预填充邮箱
claude auth login --email user@example.com
```

### 10.2 `claude auth logout`

```bash
# 登出并清除所有凭证
claude auth logout
```

### 10.3 `claude auth status`

```bash
# 文本格式输出
claude auth status --text

# JSON 格式输出
claude auth status --json
```

输出示例：
```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "user@example.com",
  "orgId": "org-xxx",
  "orgName": "Acme Corp",
  "subscriptionType": "enterprise"
}
```

---

## 总结

Claude Code 的认证系统设计兼顾了安全性与用户体验：

- **默认 OAuth**：提供流畅的浏览器登录体验
- **多方式支持**：适应不同用户需求（订阅用户、API 用户、企业用户）
- **安全存储**：macOS Keychain 集成，其他平台明文回退
- **启动优化**：并行预读取减少启动延迟
- **企业就绪**：支持 SSO、XAA、组织强制登录等企业特性

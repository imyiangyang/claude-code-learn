# Claude Code Feature Flags 系统详解

## 概述

Claude Code 采用了一套精密的 Feature Flag 系统来管理实验性功能。这套系统结合了**编译时死代码消除**和**运行时动态控制**两种机制，使得开发团队能够灵活地控制功能发布节奏，同时保持代码库的整洁。

---

## Feature Flag 机制

### bun:bundle 的 `feature()` 函数

Claude Code 使用 Bun 构建工具提供的 `bun:bundle` 模块中的 `feature()` 函���实现编译时特性开关：

> 📍 **源码位置**: `src/main.tsx:21`（`import { feature } from 'bun:bundle'`）；`src/main.tsx:1-20`（`startMdmRawRead` 和 `startKeychainPrefetch` 在 feature 导入之前的副作用注释）

```typescript
import { feature } from 'bun:bundle'

// 编译时死代码消除示例
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

**工作原理**：
- 当 `feature('FLAG_NAME')` 返回 `false` 时，Bun 的打包器会在构建时完全剔除相关代码块
- 这不同于传统的运行时 `if` 判断，未启用的功能不会进入最终产物
- 有效减小了 bundle 体积，避免实验性代码污染生产环境

---

## 运行时 vs 编译时

| 类型 | 机制 | 控制方式 | 适用场景 |
|------|------|----------|----------|
| **编译时 Flag** | `bun:bundle` 的 `feature()` | 构建配置 | 大型实验性功能、架构改动 |
| **运行时 Flag** | GrowthBook / Statsig | 环境变量、远程配置 | 渐进式发布、A/B 测试 |
| **Beta Headers** | API 请求头 | Anthropic API 层 | 模型能力、API 新功能 |

### 运行时 Flag 示例

> 📍 **源码位置**: `src/services/analytics/growthbook.ts:804`（`checkStatsigFeatureGate_CACHED_MAY_BE_STALE`，已废弃，建议用 `getFeatureValue_CACHED_MAY_BE_STALE`）；`src/services/analytics/growthbook.ts:734`（`getFeatureValue_CACHED_MAY_BE_STALE<T>`，主要 GrowthBook flag 查询 API）

```typescript
// GrowthBook 运行时控制
if (checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')) {
  // 功能逻辑
}

// 环境变量控制
if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
  // 协调者模式逻辑
}
```

---

## 完整 Feature Flag 清单

| Flag | 描述 | 状态 |
|------|------|------|
| `COORDINATOR_MODE` | 协调者模式，支持多智能体并行协调 | 实验性 |
| `PROACTIVE` | 主动触发模式，允许智能体主动发起操作 | 实验性 |
| `KAIROS` | Kairos 时机感知系统，智能判断行动时机 | 实验性 |
| `KAIROS_BRIEF` | Kairos 简报模式，定时生成工作摘要 | 实验性 |
| `KAIROS_DREAM` | Kairos 梦境模式，自动整理和归档 | 实验性 |
| `KAIROS_CHANNELS` | Kairos 频道通知系统 | 实验性 |
| `KAIROS_PUSH_NOTIFICATION` | Kairos 推送通知 | 实验性 |
| `KAIROS_GITHUB_WEBHOOKS` | Kairos GitHub Webhook 订阅 | 实验性 |
| `BRIDGE_MODE` | IDE 桥接模式，连接 VS Code / JetBrains | 实验性 |
| `DAEMON` | 后台守护进程模式 | 实验性 |
| `VOICE_MODE` | 语音输入模式 | 实验性 |
| `AGENT_TRIGGERS` | 智能体定时触发器（Cron） | 实验性 |
| `AGENT_TRIGGERS_REMOTE` | 远程智能体触发器 | 实验性 |
| `MONITOR_TOOL` | 监控工具，用于追踪智能体状态 | 实验性 |
| `HISTORY_SNIP` | 历史截断，压缩对话历史 | 实验性 |
| `REACTIVE_COMPACT` | 响应式压缩，动态管理上下文 | 实验性 |
| `CONTEXT_COLLAPSE` | 上下文折叠，智能隐藏次要信息 | 实验性 |
| `TRANSCRIPT_CLASSIFIER` | 对话分类器，自动识别用户意图 | 实验性 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性技能搜索 | 实验性 |
| `TEMPLATES` | 模板系统，支持任务模板 | 实验性 |
| `TEAMMEM` | 团队记忆，共享记忆空间 | 实验性 |
| `CACHED_MICROCOMPACT` | 缓存微压缩，优化 token 使用 | 实验性 |
| `WORKFLOW_SCRIPTS` | 工作流脚本系统 | 实验性 |
| `CONNECTOR_TEXT` | 连接器文本摘要（反蒸馏） | 实验性 |
| `CHICAGO_MCP` | Chicago MCP 服务器支持 | 实验性 |
| `MCP_SKILLS` | MCP 技能集成 | 实验性 |
| `BG_SESSIONS` | 后台会话管理 | 实验性 |
| `TOKEN_BUDGET` | Token 预算追踪 | 实验性 |
| `BASH_CLASSIFIER` | Bash 命令分类器 | 实验性 |
| `EXTRACT_MEMORIES` | 自动提取记忆 | 实验性 |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 | 内部 |
| `TERMINAL_PANEL` | 终端面板捕获 | 实验性 |
| `WEB_BROWSER_TOOL` | 网页浏览器工具 | 实验性 |
| `UDS_INBOX` | Unix Domain Socket 收件箱 | 实验性 |
| `COWORKER_TYPE_TELEMETRY` | 协作者类型遥测 | 实验性 |
| `IS_LIBC_MUSL` / `IS_LIBC_GLIBC` | libc 类型检测 | 编译时 |
| `PROMPT_CACHE_BREAK_DETECTION` | 提示缓存中断检测 | 实验性 |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 | 实验性 |
| `UPLOAD_USER_SETTINGS` | 用户设置上传 | 实验性 |
| `DOWNLOAD_USER_SETTINGS` | 用户设置下载 | 实验性 |
| `COMMIT_ATTRIBUTION` | 提交归属追踪 | 实验性 |
| `STREAMLINED_OUTPUT` | 精简输出模式 | 实验性 |
| `AWAY_SUMMARY` | 离开摘要 | 实验性 |
| `BUILDING_CLAUDE_APPS` | Claude 应用构建 | 实验性 |
| `RUN_SKILL_GENERATOR` | 技能生成器 | 实验性 |
| `REVIEW_ARTIFACT` | 产物审查 | 实验性 |

---

## Beta API Flags

Claude Code 通过 API Beta Headers 启用 Anthropic 的后端实验功能：

| Beta Header | 描述 | 适用模型 |
|-------------|------|----------|
| `claude-code-20250219` | Claude Code 核心功能 | 非 Haiku |
| `interleaved-thinking-2025-05-14` | 交错思考模式 | Claude 4+ |
| `context-1m-2025-08-07` | 100万 token 上下文 | 支持模型 |
| `context-management-2025-06-27` | 上下文管理 | Claude 4+ |
| `structured-outputs-2025-12-15` | 结构化输出 | Claude 4 Sonnet/Opus |
| `web-search-2025-03-05` | 网页搜索 | Vertex/Foundry |
| `advanced-tool-use-2025-11-20` | 高级工具使用（1P/Foundry） | Claude 4 |
| `tool-search-tool-2025-10-19` | 工具搜索（3P） | Claude 4 |
| `effort-2025-11-24` | 努力度控制 | - |
| `task-budgets-2026-03-13` | 任务预算 | - |
| `prompt-caching-scope-2026-01-05` | 提示缓存范围 | 1P |
| `fast-mode-2026-02-01` | 快速模式 | - |
| `redact-thinking-2026-02-12` | 思考内容脱敏 | 1P |
| `token-efficient-tools-2026-03-28` | Token 高效工具格式 | Ant 内部 |
| `summarize-connector-text-2026-03-13` | 连接器文本摘要 | Ant 内部 |
| `afk-mode-2026-01-31` | 离开模式 | Ant 内部 |
| `cli-internal-2026-02-09` | CLI 内部功能 | Ant 内部 |
| `advisor-tool-2026-03-01` | 顾问工具 | - |
| `oauth-2025-04-20` | OAuth 认证 | 订阅用户 |

---

## Flag 启用方式

### 1. 编译时 Flag（开发者）

编译时 Flag 在构建阶段通过 Bun 的配置控制，普通用户无法修改：

```bash
# 构建时传入 feature 配置
bun build --define:FEATURE_VOICE_MODE=true
```

### 2. 运行时环境变量

部分功能可通过环境变量控制：

```bash
# 启用协调者模式
export CLAUDE_CODE_COORDINATOR_MODE=1

# 启用实验性 Betas
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=0

# 自定义 Beta Headers（API Key 用户受限）
export ANTHROPIC_BETAS="beta-header-1,beta-header-2"

# 启用 API 上下文管理（Ant 内部）
export USE_API_CONTEXT_MANAGEMENT=1

# 启用连接器文本摘要（Ant 内部）
export USE_CONNECTOR_TEXT_SUMMARIZATION=1
```

### 3. GrowthBook / Statsig 远程控制

> 📍 **源码位置**: `src/services/analytics/growthbook.ts:1-1155`（GrowthBook 客户端全部实现；`onGrowthBookRefresh` 订阅机制：`createSignal`、catch-up microtask；`CLAUDE_INTERNAL_FC_OVERRIDES` env override；`experimentDataByFeature` Map 存 exposure 数据）

Ant 内部用户通过 GrowthBook 功能门控：

- `tengu_scratch` - 草稿板功能
- `tengu_auto_mode_config` - 自动模式配置
- `tengu_slate_prism` - 连接器文本摘要
- `tengu_tool_pear` - 严格工具使用
- `tengu_amber_json_tools` - JSON 工具格式

---

## 什么是 KAIROS

**KAIROS**（希腊语"时机"之意）是 Claude Code 中最神秘的实验性功能之一，代表了一套**时机感知系统**。

### 核心能力

1. **时机感知决策**：KAIROS 能够智能判断何时采取行动、何时等待，而非被动响应用户输入
2. **主动简报**：通过 `KAIROS_BRIEF` 定时生成工作进展摘要
3. **频道通知**：通过 `KAIROS_CHANNELS` 接收 Discord、Slack 等外部消息
4. **梦境归档**：`KAIROS_DREAM` 自动整理和归档会话内容

### 技术实现

```typescript
// Kairos 激活检测
if (feature('KAIROS') && getKairosActive()) {
  // 启用时机感知逻辑
}

// 频道通知系统（需 OAuth 认证）
if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
  // 注册 MCP 频道通知处理器
}
```

### 使用场景

- **异步工作流**：Kairos 可以在用户离开时继续监控任务，并在适当时机汇报
- **多通道集成**：通过 MCP 服务器接收来自 Slack、Discord 的消息并响应
- **智能提醒**：根据上下文判断何时提醒用户查看重要信息

---

## COORDINATOR_MODE 详解

**COORDINATOR_MODE**（协调者模式）是 Claude Code 的多智能体协调系统，允许一个"协调者"智能体管理多个"工作者"智能体并行工作。

### 架构设计

```
用户 <---> 协调者 (Coordinator) <---> 工作者 A
                               <---> 工作者 B
                               <---> 工作者 C
```

### 工作流程

1. **研究阶段**：协调者并行启动多个工作者进行代码调研
2. **综合阶段**：协调者分析所有工作者的发现，制定实施方案
3. **实现阶段**：协调者指派工作者执行具体修改
4. **验证阶段**：协调者启动验证工作者检查修改结果

### 核心工具

- **`AgentTool`** - 启动新工作者
- **`SendMessageTool`** - 向现有工作者发送消息（继续任务）
- **`TaskStopTool`** - 停止运行中的工作者

### 启用方式

```bash
export CLAUDE_CODE_COORDINATOR_MODE=1
```

### 系统提示词

协调者模式使用专门的系统提示词（见 `src/coordinator/coordinatorMode.ts`），包含：
- 角色定义：明确协调者的职责边界
- 工具使用规范：如何正确委派任务
- 并发管理：何时并行、何时串行
- 提示词编写指南：如何给工作者写清晰的指令

---

## 设计哲学

### 为什么有这么多实验性 Flag？

Claude Code 采用**渐进式发布策略**（Gradual Rollout）：

1. **降低风险**：新功能默认关闭，通过 Flag 逐步开放
2. **A/B 测试**：同一功能的不同实现可并行测试
3. **快速迭代**：无需等待完整发布周期即可验证想法
4. **用户分层**：Ant 内部用户优先体验，稳定后再开放

### 代码组织原则

```typescript
// 好的实践：编译时隔离
const featureModule = feature('EXPERIMENTAL_FLAG')
  ? require('./experimentalModule').default
  : null

// 避免：运行时检查导致死代码无法消除
import { experimentalFunction } from './experimentalModule'
if (feature('EXPERIMENTAL_FLAG')) {
  experimentalFunction() // 函数仍会被打包
}
```

### 发布流程

```
编译时 Flag (内部测试)
    ↓
运行时 Flag (员工测试)
    ↓
Beta Header (受限用户)
    ↓
全面发布 (移除 Flag)
```

---

## 总结

Claude Code 的 Feature Flag 系统是其能够快速迭代、安全实验的核心基础设施。通过编译时死代码消除与运行时动态控制的结合，开发团队可以在保证代码质量的同时，持续探索 AI 辅助编程的新可能。

对于普通用户，大部分实验性功能需要通过环境变量或等待官方开放；对于 Ant 内部开发者，GrowthBook 提供了细粒度的功能控制能力。这种分层设计确保了不同用户群体都能获得适合自身体验阶段的功能集。

---

## 补充发现（Q&A 学习）

**Q1: GrowthBook 客户端如何处理 remoteEval 模式的 SDK 缺陷？**
A: SDK 的 `setForcedFeatures` 在 remoteEval 模式下不可靠，故用模块级 `remoteEvalFeatureValues: Map<string, unknown>` 缓存远端返回值，`getFeatureValue_CACHED_MAY_BE_STALE` 优先查这个 Map 而非 SDK 内部状态。
> 📍 **源码位置**: `src/services/analytics/growthbook.ts:80-81`（`remoteEvalFeatureValues` Map 注释）

**Q2: GrowthBook refresh 的订阅系统如何防止订阅竞态？**
A: `onGrowthBookRefresh` 注册时，若 `remoteEvalFeatureValues.size > 0`（已经完成初始化），用 `queueMicrotask` 触发一次 catch-up 调用，防止 REPL mount 比 GB 网络请求慢的情况下错过首次 refresh。
> 📍 **源码位置**: `src/services/analytics/growthbook.ts:139-157`（`onGrowthBookRefresh` 实现）

**Q3: Ant 内部工程师如何在 eval 环境中覆盖 flag 值？**
A: 设置 `CLAUDE_INTERNAL_FC_OVERRIDES` env var（仅 `USER_TYPE=ant` 有效），值为 JSON 对象映射 feature key → value，绕过远端 eval 和磁盘缓存。
> 📍 **源码位置**: `src/services/analytics/growthbook.ts:162-179`（`getEnvOverrides` 函数）

**Q4: exposure 去重如何实现？**
A: 模块级 `loggedExposures: Set<string>` 记录已上报的 feature key，`pendingExposures: Set<string>` 记录 init 前访问的 key。热路径（如渲染循环中重复调用 `isAutoMemoryEnabled`）不会重复触发 exposure 事件。
> 📍 **源码位置**: `src/services/analytics/growthbook.ts:83-89`（`pendingExposures` 和 `loggedExposures` 注释）

**Q5: `feature()` 编译时 DCE 和运行时 GrowthBook flag 有什么本质区别？**
A: `feature()` 在构建时由 Bun bundler 解析为常量 `true/false`，未启用分支的代码完全不进入 bundle（攻击面更小、体积更小）。GrowthBook flag 是运行时网络请求返回的动态值，代码仍在 bundle 中，只是逻辑分支不执行——适合 A/B 测试和渐进发布。
> 📍 **源码位置**: `src/main.tsx:21`（编译时 feature import）；`src/services/analytics/growthbook.ts:734`（运行时 getFeatureValue）

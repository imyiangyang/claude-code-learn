# Claude Code 遥测与分析系统

## 1. 遥测系统概述

Claude Code 内置了一套完整的遥测与分析系统，用于收集产品使用数据、性能指标和错误信息。这些数据帮助 Anthropic 了解用户如何与产品交互，识别潜在问题，并指导产品决策。

遥测系统的核心目标是在收集有价值的分析数据的同时，严格保护用户隐私。系统采用"隐私优先"的设计理念，确保不会泄露用户的代码内容、文件路径或其他敏感信息。

## 2. AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS 类型

这是 Claude Code 源码中最引人注目的类型名称之一。这个冗长而明确的类型名并非偶然，而是 Anthropic 工程师刻意设计的隐私保护机制。

> 📍 **源码位置**: `src/services/analytics/index.ts:19`（公共 API 中的 `never` 类型定义）；`src/services/analytics/metadata.ts:57`（metadata 模块中的同名类型定义，含完整注释）

### 为什么使用如此长的类型名？

```typescript
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
```

这个类型的设计意图非常明确：

1. **强制人工审核**：每当开发者需要将字符串数据发送到遥测系统时，必须显式地进行类型转换。这个转换操作本身就是一种"签名"，表示开发者已确认该数据不包含代码片段或文件路径。

2. **代码审查友好**：在代码审查中，任何出现这个类型名的位置都会立即引起注意。审查者可以检查是否真的进行了适当的敏感信息过滤。

3. **自我文档化**：类型名本身就是一个完整的说明文档。新加入团队的工程师无需阅读额外的文档就能理解其用途。

4. **编译时保护**：由于该类型的实际定义是 `never`，它不能直接持有值。这确保了所有使用都必须通过显式的类型断言，无法意外绕过。

### 使用示例

```typescript
// 正确：显式声明已验证数据安全
return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

// 错误：无法直接赋值
const metadata: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = toolName // 编译错误
```

这种设计体现了"隐私即代码"的理念，将隐私保护从文档要求转化为编译器可检查的代码约束。

## 3. 收集的数据类型

Claude Code 收集以下几类遥测数据：

### 使用指标
- 命令使用频率（如 `/commit`、`/review` 等）
- 工具调用统计（Bash、FileRead、FileEdit 等）
- 会话时长和交互次数
- 功能启用状态（如语音模式、计划模式等）

### 性能指标
- API 响应时间和成功率
- 工具执行耗时
- 内存使用情况（RSS、堆内存、外部内存）
- CPU 使用率

### 错误与异常
- API 错误类型和频率
- 工具执行失败情况
- 未捕获的异常
- OAuth 认证问题

### 环境与配置
- 操作系统平台（Windows、macOS、Linux、WSL）
- 运行时版本（Node.js、Bun）
- 终端类型
- 包管理器和运行时环境

### 功能实验数据
- GrowthBook A/B 实验分配
- 功能标志启用状态
- 模型配置和 Beta 功能使用情况

## 4. 明确不收集的数据

Claude Code 明确承诺不收集以下敏感信息：

### 代码相关内容
- **源代码内容**：不会发送任何用户代码到遥测系统
- **代码仓库结构**：不收集文件树或目录结构
- **代码片段**：错误日志中不包含代码片段

### 文件路径
- **完整文件路径**：所有路径在记录前都会被处理
- **文件名**：仅收集文件扩展名（用于分析语言使用情况）
- **工作目录信息**：本地路径不会上传

### MCP 工具详情保护
对于用户自定义的 MCP（Model Context Protocol）服务器：
- 工具名称会被归一化为通用的 `mcp_tool`
- 服务器名称仅在官方白名单中时才记录
- 用户配置的自定义 MCP 信息被视为中等 PII，默认不收集

### 用户输入
- 用户提示词默认被脱敏为 `<REDACTED>`
- 仅当显式设置 `OTEL_LOG_USER_PROMPTS=1` 时才会记录

## 5. 隐私保护机制

### 类型系统级别的保护
通过 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 类型，在编译阶段就强制要求开发者确认数据安全。

### 数据脱敏函数

> 📍 **源码位置**: `src/services/analytics/metadata.ts:70-77`（`sanitizeToolNameForAnalytics`：`mcp__` 前缀 → `'mcp_tool'` 归一化）

```typescript
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
```

### 文件扩展名提取
```typescript
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  // 超过 10 个字符的扩展名被视为敏感（可能是哈希值）
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other'
  }
  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
```

### 工具输入截断
工具输入数据会被截断处理：
- 字符串超过 512 字符会被截断
- 嵌套深度限制为 2 层
- 数组和对象元素数量限制为 20 个
- 内部标记键（以 `_` 开头）会被过滤

## 6. Opt-out 机制

用户可以通过以下方式禁用遥测：

### 环境变量方式
```bash
# 完全禁用遥测
export DISABLE_TELEMETRY=1

# 禁用所有非必要网络流量（包括遥测、自动更新等）
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

### 隐私级别设置
系统支持三个隐私级别：
- `default`：启用所有功能
- `no-telemetry`：禁用遥测和分析
- `essential-traffic`：仅保留必要的网络流量

### 第三方云服务
当使用 Bedrock、Vertex 或 Foundry 等第三方云服务时，遥测会自动禁用，确保符合企业合规要求。

### 交互式设置
用户可以通过 `/privacy-settings` 命令在应用中直接管理隐私设置，包括"帮助改进 Claude"选项的开关。

## 7. 数据发送机制

### 双后端架构

> 📍 **源码位置**: `src/services/analytics/index.ts:72-78`（`AnalyticsSink` 接口：`logEvent` 同步 + `logEventAsync` 异步）；`src/services/analytics/index.ts:95-123`（`attachAnalyticsSink`：幂等、`queueMicrotask` 排空队列）；`src/services/analytics/datadog.ts:12-17`（`DATADOG_LOGS_ENDPOINT`、`DEFAULT_FLUSH_INTERVAL_MS=15000`、`MAX_BATCH_SIZE=100`、`NETWORK_TIMEOUT_MS=5000`）；`src/services/analytics/firstPartyEventLogger.ts:1-449`（OpenTelemetry `BatchLogRecordProcessor`）

遥测数据同时发送到两个后端：

1. **Datadog**：用于实时监控和告警
   - 仅发送允许列表中的事件
   - 生产环境专用
   - 采样率可配置

2. **Anthropic 第一方事件系统**：用于产品分析
   - 通过 `/api/event_logging/batch` 端点
   - 使用 OpenTelemetry 标准
   - 支持离线重试

### 批量发送
- 事件被批量收集，默认每 10 秒或达到 200 条时发送
- 失败的事件会存储在本地，稍后重试
- 最大重试次数为 8 次，采用二次退避策略

### 采样控制

> 📍 **源码位置**: `src/services/analytics/firstPartyEventLogger.ts:38-80`（`EVENT_SAMPLING_CONFIG_NAME='tengu_event_sampling_config'`；`getEventSamplingConfig`；`shouldSampleEvent` 返回 null 表示不采样、返回 0 表示丢弃）

通过 `tengu_event_sampling_config` 动态配置，可以为不同事件类型设置不同的采样率（0-1 之间），在高流量场景下控制数据量。

## 8. 本地存储

### 失败事件存储
发送失败的事件存储在：
```
~/.claude/telemetry/1p_failed_events.{sessionId}.{uuid}.json
```

### 存储策略
- 使用 JSON Lines 格式，每行一个事件
- 文件按会话 ID 和批次 UUID 组织
- 成功发送后自动清理
- 最大重试次数达到后丢弃

### 磁盘持久化
即使应用崩溃或网络中断，未发送的事件也会保留在磁盘上，下次启动时会尝试重新发送。

## 9. GDPR 与隐私法规合规

### 数据最小化原则
- 仅收集产品改进所需的最少数据
- 所有字符串数据必须经过显式验证
- 默认脱敏用户输入

### 用户控制权
- 提供简单的 opt-out 机制
- 隐私设置可在应用中直接访问
- 环境变量支持自动化部署场景

### PII 分级处理
- 低 PII：平台信息、版本号等
- 中 PII：MCP 服务器名称（用户配置）
- 高 PII：用户提示词（默认不收集）

### 数据保留
- 遥测数据保留期限遵循 Anthropic 数据政策
- 用户可通过删除 `~/.claude` 目录清除本地存储

## 10. 与 Anthropic 业务目标的关系

遥测数据服务于以下业务目标：

### 产品改进
- 识别最常用的功能，优先优化
- 发现性能瓶颈，提升用户体验
- 分析错误模式，提高稳定性

### A/B 测试
- GrowthBook 集成支持功能实验
- 测量新功能对用户行为的影响
- 数据驱动的功能发布决策

### 用户细分
- 了解不同平台（WSL、macOS、Linux）的使用模式
- 分析企业用户与个人用户的差异
- 根据订阅类型（Pro、Max、Enterprise）优化服务

### 容量规划
- 监控 API 使用趋势
- 预测基础设施需求
- 优化成本结构

### 安全监控
- 检测异常使用模式
- 识别潜在的滥用行为
- 监控认证和授权问题

---

通过这套精心设计的遥测系统，Claude Code 在保护用户隐私的同时，获得了持续改进产品所需的数据洞察。`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 类型正是这种平衡的完美体现，它将隐私保护责任落实到每一行代码中。

---

## 补充发现（Q&A 学习）

**Q1: `attachAnalyticsSink` 为什么用 `queueMicrotask` 而非直接 drain？**
A: 用 `queueMicrotask` 异步排空队列，避免在启动路径上增加同步延迟。即使队列中有事件，`attachAnalyticsSink` 的调用也是零阻塞返回，queued events 在微任务队列中延迟处理。
> 📍 **源码位置**: `src/services/analytics/index.ts:95-123`（`attachAnalyticsSink` queueMicrotask 注释）

**Q2: Datadog 只发送白名单事件，那其他事件去哪了？**
A: 其他事件只通过第一方事件系统（OpenTelemetry → `/api/event_logging/batch`）发送到 Anthropic 内部 BigQuery，Datadog 白名单（`DATADOG_ALLOWED_EVENTS`）是为了控制成本和限制发送到第三方的数据范围。
> 📍 **源码位置**: `src/services/analytics/datadog.ts:19-50`（`DATADOG_ALLOWED_EVENTS` Set）

**Q3: `_PROTO_*` key 前缀的设计意图是什么？**
A: 带 `_PROTO_` 前缀的 metadata key 表示该值要路由到 BigQuery 中有 PII 访问控制的 proto 列，`stripProtoFields` 会在发送给 Datadog 前移除这些 key，保证 PII 数据不进入第三方系统。
> 📍 **源码位置**: `src/services/analytics/index.ts:36-58`（`stripProtoFields` 函数及其注释）

**Q4: 遥测系统如何保证在 sink 附加前的事件不丢失？**
A: 模块级 `eventQueue: QueuedEvent[]` 数组在 sink 为 null 时缓存所有事件，`attachAnalyticsSink` 被调用时通过 `queueMicrotask` 排空队列，幂等设计保证多次调用不重复 drain。
> 📍 **源码位置**: `src/services/analytics/index.ts:80-84`（queue 定义）；`src/services/analytics/index.ts:133-144`（`logEvent` 入队逻辑）

**Q5: PII 标记系统除了工具名还保护哪些数据？**
A: `AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED` 用于必须进入 PII 访问控制列但不能完全省略的数据（如用户邮箱），仅 1P exporter 能看到，Datadog fanout 前 `stripProtoFields` 已移除。`sanitizeToolNameForAnalytics` 是 MCP 工具名的具体保护。文件操作只保留扩展名（>10字符视为哈希，返回 `'other'`）。
> 📍 **源码位置**: `src/services/analytics/index.ts:32-33`（`AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`）；`src/services/analytics/metadata.ts:70-77`（工具名脱敏）

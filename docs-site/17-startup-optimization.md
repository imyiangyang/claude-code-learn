# Claude Code 启动优化

Claude Code 作为一款命令行工具，启动速度直接影响用户体验。本文深入分析其启动优化策略，揭示如何通过并行预取、懒加载和 Bundle 优化等技术实现亚秒级启动。

## 1. 启动优化的重要性

对于 CLI 工具而言，启动时间是用户体验的第一道门槛。用户期望输入命令后能立即获得响应，任何明显的延迟都会打断工作流。Claude Code 通过精细的启动优化，将冷启动时间控制在数百毫秒以内，确保用户感受到"即时响应"的流畅体验。

## 2. startMdmRawRead() —— MDM 设置并行读取

### 什么是 MDM

MDM（Mobile Device Management，移动设备管理）是企业 IT 部门用来集中管理设备的系统。Claude Code 需要读取 MDM 配置来确定企业策略设置。

### 为什么放在 main.tsx 最顶部

> 📍 **源码位置**: `src/main.tsx:1-20`（文件头注释完整解释了3个早期副作用的原因；`startMdmRawRead()` 第16行，`startKeychainPrefetch()` 第20行）

在 `main.tsx` 的第 1-20 行，`startMdmRawRead()` 被放在所有其他导入之前执行：

```typescript
// main.tsx 第 1-20 行
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();  // 立即启动，不等待

import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();

// ... 后续约 135ms 的模块导入
```

这种"fire-and-forget"模式让 MDM 子进程（macOS 上的 `plutil` 或 Windows 上的 `reg query`）与后续模块加载并行执行。

### 性能收益

MDM 读取涉及子进程调用，通常需要约 65ms。通过并行化，这段等待时间被隐藏在模块加载过程中，实现"零成本"获取。

## 3. startKeychainPrefetch() —— 钥匙串凭证预取

### 钥匙串访问的性能问题

> 📍 **源码位置**: `src/utils/secureStorage/keychainPrefetch.ts`（`startKeychainPrefetch`：两个并发 `spawnSecurity`；`getLegacyApiKeyPrefetchResult`；`ensureKeychainPrefetchCompleted`）

macOS 钥匙串（Keychain）是系统级安全存储，每次访问都需要与 `security` 守护进程进行 IPC 通信。同步读取时，OAuth 凭证和 legacy API key 需要串行执行：

- OAuth 凭证读取：约 32ms
- Legacy API key 读取：约 33ms
- **总计：约 65ms**

### 并行预取策略

`startKeychainPrefetch()` 在 `main.tsx` 第 17-20 行启动，立即触发两个并发的 `security find-generic-password` 子进程：

```typescript
// keychainPrefetch.ts 核心逻辑
export function startKeychainPrefetch(): void {
  const oauthSpawn = spawnSecurity(
    getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
  );
  const legacySpawn = spawnSecurity(getMacOsKeychainStorageServiceName());

  prefetchPromise = Promise.all([oauthSpawn, legacySpawn]).then(...);
}
```

### 缓存机制

预取结果会被缓存，后续同步读取代码会优先检查缓存，避免重复调用：

```typescript
export function getLegacyApiKeyPrefetchResult() {
  return legacyApiKeyPrefetch;  // 返回预取结果或 null
}
```

## 4. 并行初始化策略

Claude Code 采用"fire-and-forget"模式处理所有昂贵的异步初始化：

1. **立即触发**：在模块加载阶段就启动子进程
2. **延迟等待**：在 `preAction` 钩子中通过 `Promise.all` 等待完成
3. **零阻塞**：子进程在后台运行，主线程继续执行其他初始化

```typescript
// main.tsx preAction 钩子
program.hook('preAction', async () => {
  // 等待 MDM 和钥匙串预取完成 —— 此时子进程已基本完成
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
  await init();  // 继续其他初始化
});
```

## 5. Bun 的启动优势

Claude Code 选择 Bun 而非 Node.js 作为运行时，带来了显著的启动性能提升：

| 特性 | Bun | Node.js |
|------|-----|---------|
| 启动时间 | 无需 JIT 预热 | 需要 V8 JIT 编译 |
| 原生打包 | 内置 bundler | 需要外部工具 |
| 模块加载 | 优化过的 ESM/CJS | 传统模块系统 |

Bun 的启动速度比 Node.js 快 2-4 倍，这对于 CLI 工具的冷启动至关重要。

## 6. 懒加载策略

为避免一次性加载所有模块，Claude Code 广泛采用动态导入：

```typescript
// main.tsx 中的懒加载示例
const getTeammateUtils = () => require('./utils/teammate.js');
const coordinatorModeModule = feature('COORDINATOR_MODE') 
  ? require('./coordinator/coordinatorMode.js') 
  : null;
const assistantModule = feature('KAIROS') 
  ? require('./assistant/index.js') 
  : null;
```

懒加载适用于：
- 大型功能模块（如 Coordinator、Assistant）
- 特定平台代码
- 可选功能（被 feature flag 控制）

## 7. Bundle 优化 —— bun:bundle 与 feature()

Claude Code 使用 Bun 的 `bun:bundle` 功能进行构建时死代码消除（DCE）：

```typescript
import { feature } from 'bun:bundle';

// 如果 TRANSCRIPT_CLASSIFIER 特性未启用，整个模块会被移除
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') 
  ? require('./utils/permissions/autoModeState.js') 
  : null;
```

`feature()` 在构建时解析为常量布尔值，Bun 的 tree-shaking 会完全移除未使用的代码路径，显著减小 Bundle 体积。

## 8. 缓存策略

Claude Code 在多个层面使用缓存加速启动：

### 8.1 钥匙串预取缓存
- 预取结果缓存在内存中
- 避免重复 IPC 调用

### 8.2 设置缓存
- `settingsCache.ts` 管理设置文件的内存缓存
- 避免重复磁盘读取

### 8.3 插件缓存
- 插件元数据缓存加速加载
- `loadAllPluginsCacheOnly()` 提供快速访问

## 9. 性能测量

Claude Code 内置了精细的启动性能分析工具：

> 📍 **源码位置**: `src/utils/startupProfiler.ts`（`profileCheckpoint`、`profileReport`、`PHASE_DEFINITIONS`；`CLAUDE_CODE_PROFILE_STARTUP=1` 控制）

### 9.1 环境变量控制
- `CLAUDE_CODE_PROFILE_STARTUP=1`：启用详细性能报告
- `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1`：性能测试模式，首屏渲染后退出

### 9.2 采样上报
- 内部用户：100% 采样率
- 外部用户：0.5% 采样率
- 数据上报至 Statsig 进行分析

### 9.3 关键检查点

```typescript
// 定义在 startupProfiler.ts
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
};
```

## 10. 实测启动时间

根据代码注释和架构设计，Claude Code 的启动时间大致分布如下：

| 阶段 | 耗时 | 说明 |
|------|------|------|
| MDM 预取 | ~65ms | 并行执行，实际感知接近 0ms |
| 钥匙串预取 | ~65ms | 并行执行，实际感知接近 0ms |
| 模块导入 | ~135ms | main.tsx 的静态导入 |
| init() 初始化 | 可变 | 配置加载、插件初始化等 |
| **总启动时间** | **200-400ms** | 取决于系统性能和配置 |

通过并行预取策略，原本需要约 130ms 的串行等待时间被完全隐藏在模块加载过程中，实现了启动性能的显著提升。

## 总结

Claude Code 的启动优化体现了"并行化一切可并行"的设计理念：

1. **顶层预取**：在模块加载前就启动昂贵的 I/O 操作
2. **零阻塞等待**：子进程与主线程并行执行
3. **智能缓存**：多层缓存避免重复计算
4. **构建时优化**：利用 Bun 的 DCE 减小 Bundle 体积

这些优化策略使 Claude Code 能够在数百毫秒内完成启动，为用户提供流畅的命令行体验。

---

## 补充发现（Q&A 学习）

**Q1: `profileCheckpoint` 为什么在最顶部的第一行？**
A: 它标记 `'main_tsx_entry'` 检查点，这是所有其他导入开始之前的最早时刻。如果放到后面，模块评估的时间就无法准确测量。`profileReport` 在最后对比检查点时间，精确还原每个启动阶段耗时。
> 📍 **源码位置**: `src/main.tsx:9-12`（`profileCheckpoint('main_tsx_entry')` 第12行）

**Q2: `startMdmRawRead` 和 `startKeychainPrefetch` 为什么用 `eslint-disable-next-line no-top-level-side-effects`？**
A: 在 ESM 模块中顶层副作用（直接调用函数、不是 export）通常被 eslint 规则禁止，因为它们可能导致导入顺序问题。这两处是故意设计的例外——其价值（并行 I/O）超过了规则存在的理由，故用注释豁免并保留说明。
> 📍 **源码位置**: `src/main.tsx:11,15,19`（三处 `eslint-disable-next-line` 注释）

**Q3: `preAction` 钩子中为什么用 `Promise.all` 而非顺序 await？**
A: `ensureMdmSettingsLoaded()` 和 `ensureKeychainPrefetchCompleted()` 是等待已经启动的后台任务（非新启任务），两者完全独立，`Promise.all` 让 preAction 钩子在两者中较慢的那个完成时才继续，不引入额外串行开销。
> 📍 **源码位置**: `src/main.tsx`（`program.hook('preAction', ...)` 中的 `Promise.all` 调用）

**Q4: 启动性能数据如何上报给 Anthropic？**
A: 内部用户 100% 采样，外部用户 0.5% 采样，数据通过 `logEvent` 上报到 analytics sink（1P 事件系统），用于追踪不同版本的启动时间回归。`CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1` 是专门的性能测试模式，首屏渲染后直接退出，方便 CI 测量。
> 📍 **源码位置**: `src/utils/startupProfiler.ts`（采样率和上报逻辑）

**Q5: Bun 比 Node.js 快的根本原因是什么？**
A: Bun 使用 JavaScriptCore（Safari 的 JS 引擎）而非 V8，启动时不需要预热 JIT。Bun 还内置了 bundler、test runner 和原生 npm 兼容层，减少了依赖树深度。对于 CLI 工具这类短命进程，"无 JIT 预热"是最关键的优势。
> 📍 **源码位置**: `src/main.tsx`（Bun 运行时）；相关性能分析见 `src/utils/startupProfiler.ts`

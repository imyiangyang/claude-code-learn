# Claude Code 泄露源码分析 — 总览与技术栈

> **泄露日期**: 2026年3月31日  
> **发现者**: Chaofan Shou (@Fried_rice)  
> **源码位置**: `/Users/yang/githubProj/claude-code/src/`

---

## 一、泄露事件背景

### 1.1 泄露方式

2026年3月31日，安全研究员 Chaofan Shou（@Fried_rice）在 Twitter 上公开披露：Claude Code 的 npm 包中包含的 `.map`（Source Map）文件暴露了完整源码。这些 source map 文件的 `sourceRoot` 字段指向了 Anthropic 的 Cloudflare R2 存储桶，攻击者可直接下载包含全部 TypeScript 源码的 zip 压缩包。

泄露路径如下：

```
npm 包中的 .map 文件
    ↓
sourceRoot: https://r2.anthropic.com/...
    ↓
下载完整源码压缩包
```

### 1.2 事件意义

这是 AI 编程助手领域迄今最大规模的源码泄露事件。Claude Code 作为 Anthropic 官方 CLI 工具，其架构设计、模型调用策略、工具实现细节全部暴露，为研究 AI Agent 架构提供了珍贵的第一手资料。

---

## 二、项目定性

Claude Code 是 **Anthropic 官方推出的终端 AI 编程助手**，定位为开发者的命令行伙伴。核心功能包括：

- **代码编辑**: 文件读写、部分修改、批量重构
- **命令执行**: 在终端中安全地运行 shell 命令
- **代码搜索**: 基于 ripgrep 的内容搜索和文件匹配
- **Git 工作流**: 提交、分支管理、PR 评论查看
- **多 Agent 协作**: 支持子 Agent 和团队级并行任务
- **MCP 集成**: Model Context Protocol 服务器生态支持

与 GitHub Copilot（编辑器插件）、Cursor（独立 IDE）不同，Claude Code 选择 **纯终端环境** 作为战场，通过 React + Ink 在命令行中渲染交互式 UI。

---

## 三、技术栈概览

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **运行时** | Bun | 非 Node.js，利用 Bun 的高性能和内置打包能力 |
| **语言** | TypeScript (strict) | 严格模式，约 51.2 万行代码 |
| **终端 UI** | React + Ink | React 组件在终端中渲染，支持交互式界面 |
| **CLI 解析** | Commander.js | `@commander-js/extra-typings` 提供类型安全 |
| **Schema 校验** | Zod v4 | 全项目统一使用 `zod/v4` 进行运行时类型校验 |
| **构建系统** | `bun:bundle` | 利用 `feature()` 实现编译期死代码消除 |
| **React 优化** | React Compiler | 源码中可见 `import { c as _c } from "react/compiler-runtime"` |

### 3.1 Bun 运行时特性

项目深度依赖 Bun 的特有 API：

> 📍 **源码位置**: `src/main.tsx:21`（`import { feature } from 'bun:bundle'`）；`src/constants/betas.ts`（`AFK_MODE_BETA_HEADER` 等编译时 feature flag 示例）

```typescript
// src/constants/betas.ts
import { feature } from 'bun:bundle'

// 编译期特性开关，未启用的代码在构建时完全剔除
export const AFK_MODE_BETA_HEADER = feature('TRANSCRIPT_CLASSIFIER')
  ? 'afk-mode-2026-01-31'
  : ''
```

### 3.2 React Compiler 证据

在多个组件文件中可见 React Compiler 的运行时导入：

> 📍 **源码位置**: `src/screens/Doctor.tsx:1`、`src/screens/REPL.tsx:1`（两个全屏界面文件首行均为 React Compiler 运行时导入）

```typescript
// src/screens/Doctor.tsx:1, src/screens/REPL.tsx:1
import { c as _c } from "react/compiler-runtime"
```

这表明 Anthropic 已启用 React Compiler 进行自动记忆化优化。

### 3.3 Zod v4 验证

> 📍 **源码位置**: `src/schemas/hooks.ts:12`（`import { z } from 'zod/v4'`）；`promptHookSchema` 定义在同文件稍后

```typescript
// src/schemas/hooks.ts:12
import { z } from 'zod/v4'

export const promptHookSchema = z.object({
  // ... schema definition
})
```

---

## 四、代码规模

根据 `src/` 目录统计：

- **TypeScript 文件**: 约 1,884 个
- **总代码行数**: 约 512,000+ 行
- **核心文件规模**:
  - `QueryEngine.ts`: ~46K 行（LLM 调用核心引擎）
  - `Tool.ts`: ~29K 行（工具类型定义）
  - `commands.ts`: ~25K 行（命令注册管理）

---

## 五、最新模型支持

根据 `src/skills/bundled/claudeApiContent.ts` 中的定义：

> 📍 **源码位置**: `src/skills/bundled/claudeApiContent.ts:36-44`（`SKILL_MODEL_VARS` 导出常量，各模型 ID 硬编码在此）

```typescript
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'claude-opus-4-6',
  OPUS_NAME: 'Claude Opus 4.6',
  SONNET_ID: 'claude-sonnet-4-6',
  SONNET_NAME: 'Claude Sonnet 4.6',
  HAIKU_ID: 'claude-haiku-4-5',
  HAIKU_NAME: 'Claude Haiku 4.5',
  PREV_SONNET_ID: 'claude-sonnet-4-5',
} as const
```

当前支持的模型版本：

| 模型 | ID | 定位 |
|------|-----|------|
| Claude Opus 4.6 | `claude-opus-4-6` | 最强推理，复杂任务 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 均衡选择，日常使用 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 快速响应，轻量任务 |

---

## 六、顶层目录结构

```
src/
├── main.tsx                    # 入口：Commander.js CLI 解析 + Ink 渲染器初始化
├── commands.ts                 # 命令注册中心
├── tools.ts                    # 工具注册中心
├── Tool.ts                     # 工具类型定义基类
├── QueryEngine.ts              # LLM 查询引擎（核心 Anthropic API 调用）
├── context.ts                  # 系统/用户上下文收集
├── cost-tracker.ts             # Token 成本追踪
│
├── commands/                   # 斜杠命令实现（~50 个命令）
├── tools/                      # Agent 工具实现（~40 个工具）
├── components/                 # Ink UI 组件（~140 个组件）
├── hooks/                      # React Hooks
├── services/                   # 外部服务集成（API、MCP、LSP、分析等）
├── screens/                    # 全屏界面（Doctor、REPL、Resume）
├── types/                      # TypeScript 类型定义
├── utils/                      # 工具函数
│
├── bridge/                     # IDE 集成桥接（VS Code、JetBrains）
├── coordinator/                # 多 Agent 协调器
├── plugins/                    # 插件系统
├── skills/                     # Skill 系统
├── keybindings/                # 快捷键配置
├── vim/                        # Vim 模式
├── voice/                      # 语音输入
├── remote/                     # 远程会话
├── server/                     # 服务器模式
├── memdir/                     # 持久化记忆目录
├── tasks/                      # 任务管理
├── state/                      # 状态管理
├── migrations/                 # 配置迁移
├── schemas/                    # 配置 Schema（Zod）
├── entrypoints/                # 初始化逻辑
├── ink/                        # Ink 渲染器封装
├── buddy/                      # 陪伴精灵（彩蛋）
├── native-ts/                  # 原生 TypeScript 工具
├── outputStyles/               # 输出样式
├── query/                      # 查询管道
└── upstreamproxy/              # 代理配置
```

### 6.1 关键目录说明

- **`tools/`**: 每个工具都是独立模块，定义输入 Schema、权限模型和执行逻辑。包括 BashTool、FileReadTool、AgentTool、MCPTool 等约 40 个工具。

- **`commands/`**: 用户通过 `/` 前缀调用的命令，如 `/commit`、`/review`、`/compact`、`/mcp` 等约 50 个命令。

- **`services/`**: 外部服务集成层，包括 Anthropic API 客户端、MCP 服务器管理、LSP 语言服务器、GrowthBook 特性开关等。

- **`bridge/`**: 与 IDE 扩展的双向通信层，支持 VS Code 和 JetBrains 系列 IDE。

- **`coordinator/`**: 多 Agent 协调器，处理子 Agent 和团队级并行任务调度。

---

## 七、与竞品对比

| 特性 | Claude Code | GitHub Copilot | Cursor |
|------|-------------|----------------|--------|
| **形态** | CLI 工具 | IDE 插件 | 独立 IDE |
| **运行环境** | 终端 | VS Code/JetBrains/Neovim | 专用编辑器 |
| **架构** | React + Ink 终端 UI | 编辑器内联补全 | 完整 IDE 替代 |
| **工具调用** | 40+ 内置工具 | 有限（Copilot Chat） | 内置工具 |
| **MCP 支持** | 完整支持 | 部分支持 | 支持 |
| **多 Agent** | Agent Swarms | 不支持 | Composer |
| **权限系统** | 细粒度权限控制 | 基于编辑器权限 | 用户确认 |
| **开源** | 泄露前闭源 | 闭源 | 闭源（基于 VS Code） |

Claude Code 的独特之处在于：

1. **终端原生**: 不依赖 GUI，通过 SSH 即可使用
2. **Agent 优先**: 从设计之初就支持多 Agent 协作
3. **工具丰富**: 40+ 工具覆盖开发全流程
4. **权限精细**: 每个工具调用都可配置权限策略

---

## 八、架构亮点

### 8.1 启动优化

`main.tsx` 中采用并行预取策略：

> 📍 **源码位置**: `src/main.tsx:9-20`（`profileCheckpoint`→`startMdmRawRead`→`startKeychainPrefetch` 三副作用按序、在所有重量级模块导入前触发）

```typescript
// 这些副作用必须在其他导入前执行
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
startMdmRawRead()  // 并行启动 MDM 读取

import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js'
startKeychainPrefetch()  // 并行预取 Keychain
```

### 8.2 死代码消除

利用 Bun 的 `feature()` 实现编译期条件编译：

> 📍 **源码位置**: `src/main.tsx:74-76`（`COORDINATOR_MODE` feature flag 的 DCE 条件导入示例）

```typescript
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js')
  : null
```

未启用的特性在构建时完全剔除，减小包体积。

---

## 九、总结

Claude Code 的泄露源码展现了一个成熟的 AI Agent CLI 工具应有的样子：

- **技术选型激进**: 全面拥抱 Bun、React Compiler、Zod v4 等前沿技术
- **架构设计精良**: 工具系统、命令系统、服务层分层清晰
- **工程实践到位**: 严格的 TypeScript、并行优化、死代码消除
- **功能边界清晰**: 专注终端场景，不与 IDE 正面竞争

这次泄露为 AI 工程界提供了研究顶级 AI Agent 实现的宝贵机会，其架构设计值得所有构建类似工具的开发者深入学习。

---

## 十、补充发现（Q&A 自我学习）

> 📍 **源码验证基础**: 本节所有发现均有对应源码行号支撑

**Q1**: `main.tsx` 入口文件的三个副作用（profileCheckpoint、startMdmRawRead、startKeychainPrefetch）为什么必须放在所有 `import` 语句之前？

**A1**: Bun/Node.js 的 ES Module 执行顺序是：先串行解析并执行所有 `import`，再执行模块主体代码。若等到所有 heavy module（如 React、Ink、Anthropic SDK）都加载完才启动这些异步任务，就浪费了数百毫秒的并行窗口。通过将副作用插入在 `import` 链之间（`src/main.tsx:9-20`），这三个任务在模块图加载期间已经在后台并发运行，实现零等待启动。
> 📍 `src/main.tsx:2-6`（注释明确解释了三处副作用的时序原因）

**Q2**: React Compiler 的 `_c(N)` 槽缓存机制具体如何工作？`N` 是如何决定的？

**A2**: `_c(N)` 创建一个长度为 N 的数组作为缓存槽，每个槽对应一个需要被记忆化的值（props、计算结果、子树等）。N 由 React Compiler 在编译时静态分析组件的依赖图决定——每个可能变化的"记忆化边界"消耗一个槽。`App.tsx` 的 `_c(9)` 表示编译器识别出 9 个独立的记忆化点。与手写 `useMemo`/`useCallback` 相比，编译器能做更细粒度的追踪。
> 📍 `src/components/App.tsx:1`（`_c(9)` 调用）；`src/screens/REPL.tsx:1`（同样模式）

**Q3**: Zod v4（`zod/v4`）相比 Zod v3 有什么架构级别的变化，值得整个项目迁移？

**A3**: Zod v4 引入了多项 breaking change：①树摇（tree-shaking）支持大幅改善，未使用的 Schema 类型不再打包进输出；②性能提升约 14×（内部重写了解析引擎）；③新增 `z.pipe()` 组合器、改进的错误 formatting API；④与 TypeScript 5.x 的类型推断更精确。对于像 Claude Code 这样有严格性能要求、大量 Schema 定义（`src/schemas/` 目录）的项目，迁移成本值得。
> 📍 `src/schemas/hooks.ts:12`（`import { z } from 'zod/v4'`）

**Q4**: `bun:bundle` 的 `feature()` 与 webpack 的 `DefinePlugin` 或 rollup 的 `replace` 插件有何本质区别？

**A4**: `webpack DefinePlugin` / `rollup replace` 是文本级替换——在打包时将字符串替换为字面量，依赖 minifier 做后续 DCE。`bun:bundle feature()` 是语义级 DCE——Bun 的打包器在 AST 层面识别 `feature()` 调用，直接在代码生成阶段跳过未激活分支，连死代码的 AST 节点都不会生成，不依赖 minifier，效率更高且更可靠。这也意味着 Claude Code 的不同构建版本（是否启用 `PROACTIVE`、`BRIDGE_MODE`、`VOICE_MODE`）的 bundle 体积可以差异显著。
> 📍 `src/main.tsx:21`（`import { feature } from 'bun:bundle'`）；`src/main.tsx:74-76`（DCE 示例）

**Q5**: 为什么 Claude Code 选择 React + Ink 而非 blessed、chalk + readline、或直接写 ANSI escape codes？

**A5**: ①**组件化复用**: Ink 让终端 UI 像 Web 一样按组件组织，便于维护 140+ 组件；②**Flexbox 布局**: Ink 底层集成 Yoga（Facebook 的 Flexbox 引擎），无需手工计算列宽换行，支持复杂布局；③**React 生态**: 可直接用 React Hooks、Context、Suspense 等管理异步状态；④**React Compiler 加成**: 可利用 Compiler 自动记忆化优化渲染性能，这在 blessed 等方案中不可用。代价是运行时依赖重（React + Ink），但 Bun 的快速启动和 DCE 降低了这一成本。
> 📍 `src/ink/layout/yoga.ts:1`（Yoga 引擎封装）；`src/ink/reconciler.ts:1`（自定义 reconciler）

---

*免责声明：本文仅用于技术研究和教育目的。源码归 Anthropic 所有。*

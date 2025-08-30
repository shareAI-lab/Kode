# Step 0: Foundation Type System Fix (MUST COMPLETE FIRST - SERIAL)

## 项目背景
本项目是 Kode CLI 工具，基于 TypeScript + React (Ink 6) 构建的命令行界面。最近升级到 React 19 和 Ink 6 后出现了 127 个 TypeScript 编译错误。本任务是修复基础类型系统，为后续并行修复打下基础。

## 任务目标
修复核心类型定义，使得其他所有模块可以基于正确的类型定义进行修复。

## 系统架构概览
```
Kode CLI
├── src/
│   ├── messages.ts          - 消息类型定义
│   ├── Tool.ts              - 工具基类接口
│   ├── types/               - 类型定义目录
│   ├── query.ts             - 查询系统
│   ├── utils/               - 工具函数
│   │   └── messageContextManager.ts
│   └── hooks/               - React hooks
│       └── useTextInput.ts
```

## 施工步骤

### Phase 1: 安装缺失依赖 (5分钟)

#### Step 1.1: 安装 sharp 图像处理库
**文件**: package.json
**执行命令**:
```bash
bun add sharp
bun add -d @types/sharp
```
**验证**: 运行 `bun install` 确认无错误

### Phase 2: 创建类型增强文件 (10分钟)

#### Step 2.1: 创建 Ink 类型增强
**创建文件**: `src/types/ink-augmentation.d.ts`
**精确内容**:
```typescript
// Ink Key 类型增强 - 添加缺失的键盘属性
declare module 'ink' {
  interface Key {
    fn?: boolean;
    home?: boolean;
    end?: boolean;
    space?: boolean;
  }
}
```

#### Step 2.2: 创建通用类型定义
**创建文件**: `src/types/common.d.ts`
**精确内容**:
```typescript
// UUID 类型定义
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

// 扩展的工具上下文
export interface ExtendedToolUseContext extends ToolUseContext {
  setToolJSX: (jsx: React.ReactElement) => void;
}
```

### Phase 3: 修复消息类型系统 (20分钟)

#### Step 3.1: 修复 Message 类型定义
**修改文件**: `src/messages.ts`
**查找内容** (大约在 50-100 行之间):
```typescript
export interface ProgressMessage {
  type: 'progress'
  // ... existing properties
}
```
**替换为**:
```typescript
export interface ProgressMessage {
  type: 'progress'
  message?: any  // 添加可选的 message 属性以兼容旧代码
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool<any, any>[]
  toolUseID: string
  uuid: UUID
}
```

#### Step 3.2: 修复 query.ts 中的消息访问
**修改文件**: `src/query.ts`
**查找内容** (第 203-210 行):
```typescript
message: msg.message
```
**替换为**:
```typescript
// 使用类型守卫安全访问
...(msg.type !== 'progress' && 'message' in msg ? { message: msg.message } : {})
```

#### Step 3.3: 修复 messageContextManager.ts
**修改文件**: `src/utils/messageContextManager.ts`
**查找内容** (第 136 行附近):
```typescript
return {
  type: "assistant",
  message: { role: "assistant", content: [...] }
}
```
**替换为**:
```typescript
return {
  type: "assistant",
  message: { role: "assistant", content: [...] },
  costUSD: 0,
  durationMs: 0,
  uuid: crypto.randomUUID() as UUID
}
```
**注意**: 需要在文件顶部添加导入:
```typescript
import type { UUID } from '../types/common';
```

### Phase 4: 修复 Tool 接口定义 (15分钟)

#### Step 4.1: 更新 Tool 基础接口
**修改文件**: `src/Tool.ts`
**查找内容**:
```typescript
export interface Tool<TInput, TOutput> {
  renderResultForAssistant(output: TOutput): string;
  renderToolUseRejectedMessage(): React.ReactElement;
  // ...
}
```
**替换为**:
```typescript
export interface Tool<TInput, TOutput> {
  renderResultForAssistant(output: TOutput): string | any[];
  renderToolUseRejectedMessage?(...args: any[]): React.ReactElement;
  // ...其他属性保持不变
}
```

#### Step 4.2: 更新 ToolUseContext
**修改文件**: `src/Tool.ts` (或者在同一文件中查找 ToolUseContext)
**查找内容**:
```typescript
export interface ToolUseContext {
  // existing properties
}
```
**替换为**:
```typescript
export interface ToolUseContext {
  // ...existing properties
  setToolJSX?: (jsx: React.ReactElement) => void;
  messageId?: string;
  agentId?: string;
}
```

### Phase 5: 修复其他基础类型问题 (10分钟)

#### Step 5.1: 修复 thinking.ts 枚举值
**修改文件**: `src/utils/thinking.ts`
**查找内容** (第 115 行):
```typescript
"low" | "medium" | "high" | "minimal"
```
**替换为**:
```typescript
"low" | "medium" | "high"
```

#### Step 5.2: 移除无用的 @ts-expect-error
**修改文件列表及行号**:
1. `src/entrypoints/cli.tsx` - 删除第 318 行
2. `src/hooks/useDoublePress.ts` - 删除第 33 行
3. `src/hooks/useTextInput.ts` - 删除第 143 行
4. `src/utils/messages.tsx` - 删除第 301 行

**操作**: 直接删除包含 `// @ts-expect-error` 的整行

### Phase 6: 验证基础修复 (5分钟)

#### Step 6.1: 运行类型检查
```bash
npx tsc --noEmit 2>&1 | wc -l
```
**预期结果**: 错误数量应该从 127 减少到 70-80 左右

#### Step 6.2: 检查特定文件错误
```bash
npx tsc --noEmit 2>&1 | grep "src/messages.ts"
npx tsc --noEmit 2>&1 | grep "src/query.ts"
npx tsc --noEmit 2>&1 | grep "src/Tool.ts"
```
**预期结果**: 这些文件不应再有错误

#### Step 6.3: 测试运行时
```bash
bun run dev
# 输入 /help 测试基础功能
```
**预期结果**: CLI 应该能启动，基础命令能运行

## 完成标志
- [ ] sharp 依赖已安装
- [ ] ink-augmentation.d.ts 已创建
- [ ] Message 类型错误已修复
- [ ] Tool 接口已更新
- [ ] 无用的 @ts-expect-error 已移除
- [ ] TypeScript 错误减少 40% 以上
- [ ] 基础 CLI 功能可运行

## 注意事项
1. **不要修改功能逻辑**，只修复类型定义
2. **保留原有注释**，只添加必要的类型注释
3. **使用 git diff 检查改动**，确保没有意外修改
4. **每个文件修改后立即保存**，避免丢失工作

## 如果遇到问题
1. 检查文件路径是否正确
2. 确认 bun 和 npm 都已安装
3. 如果找不到指定代码，使用 grep 搜索：
   ```bash
   grep -n "ProgressMessage" src/messages.ts
   ```
4. 保存修改前的文件备份：
   ```bash
   cp src/messages.ts src/messages.ts.backup
   ```

## 完成后
将此文档标记为完成，然后可以开始 Step 1 的并行任务。
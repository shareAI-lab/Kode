# Step 1 - Worker 2: TaskTool & MultiEditTool 修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
TaskTool 是 Kode CLI 的核心调度工具，负责创建子任务和代理。MultiEditTool 允许批量编辑文件。这两个工具都涉及复杂的异步操作。

## 系统架构上下文
```
src/tools/
├── TaskTool/
│   ├── TaskTool.tsx          - 任务调度工具
│   └── prompt.ts             - 工具提示词
├── MultiEditTool/
│   ├── MultiEditTool.tsx     - 批量编辑工具
│   └── prompt.ts             - 工具提示词
```

## 任务目标
1. 修复 TaskTool 的 AsyncGenerator 类型不匹配
2. 修复 ExtendedToolUseContext 缺失属性
3. 修复 MultiEditTool 的参数和返回值问题

## 详细施工步骤

### Phase 1: 修复 TaskTool (40分钟)

#### Step 1.1: 修复 AsyncGenerator 返回类型
**文件**: `src/tools/TaskTool/TaskTool.tsx`
**定位**: 搜索 `call:` 方法 (大约第 68 行)
**当前问题**: AsyncGenerator 返回类型包含 progress 和 result，但接口只期望 result

**当前代码结构**:
```typescript
async *call(
  { description, prompt, model_name, subagent_type },
  context
): AsyncGenerator<
  | { type: "result"; data: { error: string }; resultForAssistant: string }
  | { type: "progress"; content: any; normalizedMessages: any[]; tools: any[] }
  | { type: "result"; data: any; normalizedMessages: any[]; resultForAssistant: any }
> {
  // 实现
}
```

**修复方案 1 - 简化返回类型**:
```typescript
async *call(
  { description, prompt, model_name, subagent_type }: any,
  context: ToolUseContext
): AsyncGenerator<{ type: "result"; data: any; resultForAssistant?: string }> {
  // 修改实现，只 yield result 类型
  // 将 progress 类型改为内部处理或日志
  
  try {
    // ... 执行逻辑
    
    // 不再 yield progress，改为：
    // console.log('Progress:', progressData);
    
    // 只 yield result
    yield {
      type: "result",
      data: resultData,
      resultForAssistant: "Task completed"
    };
  } catch (error) {
    yield {
      type: "result",
      data: { error: error.message },
      resultForAssistant: `Error: ${error.message}`
    };
  }
}
```

**修复方案 2 - 使用类型断言**:
```typescript
async *call(
  input: any,
  context: ToolUseContext
) {
  // 保持原有逻辑，但在导出时断言
} as Tool<any, any>['call']
```

#### Step 1.2: 修复 ExtendedToolUseContext 问题
**文件**: `src/tools/TaskTool/TaskTool.tsx`
**定位**: 搜索使用 ExtendedToolUseContext 的地方 (大约第 191 行)
**错误**: 缺少 setToolJSX 属性

**查找代码**:
```typescript
const extendedContext: ExtendedToolUseContext = {
  abortController: ...,
  options: ...,
  messageId: ...,
  agentId: ...,
  readFileTimestamps: ...
  // 缺少 setToolJSX
};
```

**修复为**:
```typescript
const extendedContext: ExtendedToolUseContext = {
  abortController: context.abortController,
  options: {
    ...context.options,
    // 确保包含所需属性
  },
  messageId: context.messageId || '',
  agentId: context.agentId || '',
  readFileTimestamps: context.readFileTimestamps || {},
  setToolJSX: context.setToolJSX || (() => {}) // 添加默认实现
};
```

#### Step 1.3: 导入 ExtendedToolUseContext 类型
**文件**: `src/tools/TaskTool/TaskTool.tsx`
**在文件顶部添加**:
```typescript
import type { Tool, ToolUseContext } from '../../Tool';
import type { ExtendedToolUseContext } from '../../types/common';
```

#### Step 1.4: 修复 TextBlock 类型
**文件**: `src/tools/TaskTool/TaskTool.tsx`
**添加类型定义**:
```typescript
// 在文件顶部
type TextBlock = {
  type: 'text';
  text: string;
};
```

### Phase 2: 修复 MultiEditTool (30分钟)

#### Step 2.1: 修复 applyEdit 调用参数
**文件**: `src/tools/MultiEditTool/MultiEditTool.tsx`
**定位**: 搜索 `applyEdit` 调用 (大约第 281 行)
**错误**: 期望 3 个参数，但传了 4 个

**查找代码**:
```typescript
const result = applyEdit(currentContent, old_string, new_string, replace_all);
```

**修复方案 1 - 检查 applyEdit 函数签名**:
```typescript
// 查找 applyEdit 的定义
// 如果它确实只接受 3 个参数，修改调用：
const result = applyEdit(currentContent, old_string, new_string);
// 单独处理 replace_all 逻辑
```

**修复方案 2 - 更新 applyEdit 函数**:
```typescript
// 如果 applyEdit 应该接受 4 个参数，更新其定义：
function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
) {
  // 实现
}
```

#### Step 2.2: 修复返回值属性
**文件**: `src/tools/MultiEditTool/MultiEditTool.tsx`
**定位**: 使用 result.newContent 和 result.occurrences 的地方 (第 283, 289 行)
**错误**: 属性不存在

**查找代码**:
```typescript
currentContent = result.newContent;
// 和
if (result.occurrences === 0) {
```

**修复为**:
```typescript
// 确保 applyEdit 返回正确的结构
interface EditResult {
  updatedFile: string;    // 或 newContent
  patch: any[];
  occurrences?: number;   // 添加此属性
}

// 使用时：
currentContent = result.updatedFile || result.newContent;
if ((result.occurrences || 0) === 0) {
```

#### Step 2.3: 修复函数参数数量
**文件**: `src/tools/MultiEditTool/MultiEditTool.tsx`
**定位**: 第 306 行的函数调用
**错误**: 期望 4 个参数，提供了 3 个

**可能的修复**:
```typescript
// 查找函数定义，添加缺失的参数
// 或者提供默认值
someFunction(arg1, arg2, arg3, undefined);
```

### Phase 3: 创建或修复辅助类型 (15分钟)

#### Step 3.1: 创建 types 文件（如果不存在）
**创建文件**: `src/tools/types.ts`
```typescript
// 工具系统的共享类型定义

export interface EditResult {
  updatedFile: string;
  newContent?: string;
  patch: any[];
  occurrences: number;
}

export interface TaskProgress {
  type: 'progress';
  content: any;
  normalizedMessages: any[];
  tools: any[];
}

export interface TaskResult {
  type: 'result';
  data: any;
  resultForAssistant?: string;
}

export type TaskOutput = TaskProgress | TaskResult;
```

#### Step 3.2: 更新工具导入
**在两个工具文件中添加**:
```typescript
import type { EditResult, TaskResult } from '../types';
```

### Phase 4: 验证和测试 (15分钟)

#### Step 4.1: 检查 TaskTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "TaskTool"
```

#### Step 4.2: 检查 MultiEditTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "MultiEditTool"
```

#### Step 4.3: 功能测试
```bash
# 启动 CLI
bun run dev

# 测试任务创建（如果有相关命令）
# 输入: task "Create a simple function"

# 测试批量编辑（创建测试文件）
echo "old text\nold text\nold text" > test.txt
# 输入: multiedit test.txt "old" "new"
rm test.txt
```

### Phase 5: 处理复杂情况 (10分钟)

#### Step 5.1: 如果 AsyncGenerator 太复杂
使用包装函数：
```typescript
const taskToolCall = async function* (input: any, context: any) {
  // 原始复杂逻辑
} as any;

export const TaskTool: Tool<any, any> = {
  name: "task",
  call: taskToolCall,
  // ... 其他属性
};
```

#### Step 5.2: 如果类型冲突无法解决
创建适配器：
```typescript
class TaskToolAdapter {
  static adaptOutput(output: any): { type: "result"; data: any } {
    if (output.type === "progress") {
      // 转换 progress 为某种 result 格式
      return {
        type: "result",
        data: { progress: output }
      };
    }
    return output;
  }
}
```

## 完成标志
- [ ] TaskTool AsyncGenerator 类型匹配
- [ ] ExtendedToolUseContext 完整
- [ ] MultiEditTool 参数正确
- [ ] 返回值属性存在
- [ ] 两个工具都能编译
- [ ] TypeScript 错误减少至少 15 个

## 注意事项
1. **保持异步逻辑** - 不要改变 async/await 模式
2. **保留错误处理** - 确保 try/catch 完整
3. **测试并发场景** - TaskTool 可能同时运行多个任务
4. **注意内存泄漏** - AsyncGenerator 需要正确清理

## 调试建议

### 追踪 AsyncGenerator 问题
```typescript
async *debugGenerator() {
  console.log('Generator started');
  try {
    yield { type: "result", data: "test" };
    console.log('Yielded result');
  } finally {
    console.log('Generator cleanup');
  }
}
```

### 类型检查技巧
```typescript
// 获取函数的返回类型
type ReturnTypeOf<T> = T extends (...args: any[]) => infer R ? R : never;
type CallReturnType = ReturnTypeOf<typeof TaskTool.call>;
```

## 常见错误解决

### AsyncGenerator 类型不兼容
1. 检查所有 yield 语句
2. 确保都返回相同的类型结构
3. 使用联合类型时要一致

### 属性不存在
1. 检查对象的实际结构
2. 添加可选链操作符 `?.`
3. 使用类型守卫

## 完成后
记录任何未解决的复杂问题，特别是关于 AsyncGenerator 的类型问题，供高级开发者后续优化。
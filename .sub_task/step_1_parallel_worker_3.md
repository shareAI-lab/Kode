# Step 1 - Worker 3: Other Tools 修复 (StickerRequestTool, NotebookReadTool, AskExpertModelTool)

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
这组工具包含特殊功能：StickerRequestTool 处理贴纸请求，NotebookReadTool 读取 Jupyter 笔记本，AskExpertModelTool 调用专家模型。

## 系统架构上下文
```
src/tools/
├── StickerRequestTool/
│   └── StickerRequestTool.tsx
├── NotebookReadTool/
│   └── NotebookReadTool.tsx
├── AskExpertModelTool/
│   └── AskExpertModelTool.tsx
```

## 任务目标
1. 修复 StickerRequestTool 的 setToolJSX 属性问题
2. 修复 NotebookReadTool 的类型转换问题
3. 修复 AskExpertModelTool 的 debugLogger 调用问题

## 详细施工步骤

### Phase 1: 修复 StickerRequestTool (20分钟)

#### Step 1.1: 处理 setToolJSX 缺失问题
**文件**: `src/tools/StickerRequestTool/StickerRequestTool.tsx`
**定位**: 搜索 `setToolJSX` (第 41, 51, 57 行)
**问题**: ToolUseContext 不包含 setToolJSX

**查找代码**:
```typescript
context.setToolJSX(<StickerUI .../>);
```

**修复方案 1 - 条件调用**:
```typescript
// 检查属性是否存在
if (context.setToolJSX) {
  context.setToolJSX(<StickerUI .../>);
} else {
  // 备用方案：记录日志或使用其他方式
  console.log('Sticker UI would be displayed here');
}
```

**修复方案 2 - 类型守卫**:
```typescript
// 在文件顶部添加类型守卫
function hasSetToolJSX(ctx: any): ctx is ExtendedToolUseContext {
  return 'setToolJSX' in ctx && typeof ctx.setToolJSX === 'function';
}

// 使用时
if (hasSetToolJSX(context)) {
  context.setToolJSX(<StickerUI .../>);
}
```

#### Step 1.2: 修复 renderToolUseRejectedMessage
**文件**: `src/tools/StickerRequestTool/StickerRequestTool.tsx`
**定位**: 第 85 行
**问题**: 签名不匹配

**查找代码**:
```typescript
renderToolUseRejectedMessage(_input: any) {
  return <Text>...</Text>;
}
```

**修复为**:
```typescript
renderToolUseRejectedMessage() {
  // 移除参数或设为可选
  return <Text color="red">Sticker request rejected</Text>;
}
```

#### Step 1.3: 确保组件导入正确
**文件**: `src/tools/StickerRequestTool/StickerRequestTool.tsx`
**检查导入**:
```typescript
import React from 'react';
import { Text, Box } from 'ink';
import type { Tool, ToolUseContext } from '../../Tool';
```

### Phase 2: 修复 NotebookReadTool (20分钟)

#### Step 2.1: 修复类型转换问题
**文件**: `src/tools/NotebookReadTool/NotebookReadTool.tsx`
**定位**: 第 179 行
**问题**: unknown 不能赋值给 string | string[]

**查找代码**:
```typescript
someFunction(unknownValue);
```

**修复方案 1 - 类型断言**:
```typescript
someFunction(unknownValue as string);
// 或者如果可能是数组
someFunction(unknownValue as string | string[]);
```

**修复方案 2 - 类型检查**:
```typescript
// 安全的类型检查
if (typeof unknownValue === 'string') {
  someFunction(unknownValue);
} else if (Array.isArray(unknownValue)) {
  someFunction(unknownValue);
} else {
  // 处理其他情况
  someFunction(String(unknownValue));
}
```

#### Step 2.2: 处理 Jupyter 笔记本类型
**文件**: `src/tools/NotebookReadTool/NotebookReadTool.tsx`
**添加类型定义**:
```typescript
// 在文件顶部
interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string | string[];
  outputs?: any[];
}

interface NotebookData {
  cells: NotebookCell[];
  metadata?: any;
}
```

#### Step 2.3: 修复解析逻辑
**确保正确处理 source 字段**:
```typescript
function parseSource(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    return source.join('');
  }
  return String(source);
}

// 使用
const content = parseSource(cell.source);
```

### Phase 3: 修复 AskExpertModelTool (25分钟)

#### Step 3.1: 修复 debugLogger 调用
**文件**: `src/tools/AskExpertModelTool/AskExpertModelTool.tsx`
**定位**: 第 149, 172, 306, 319, 327, 344, 358, 417, 499, 508, 533 行
**问题**: debugLogger 不是函数或参数数量错误

**查找 debugLogger 的使用**:
```typescript
debugLogger('phase', 'data', 'requestId');
```

**修复方案 1 - 检查导入**:
```typescript
// 确保正确导入
import { debugLogger } from '../../utils/debugLogger';

// 如果 debugLogger 是对象，使用正确的方法
debugLogger.log('phase', 'data');
// 或
debugLogger.info('phase', { data, requestId });
```

**修复方案 2 - 创建包装函数**:
```typescript
// 如果 debugLogger 结构复杂
const log = (phase: string, data: any, requestId?: string) => {
  if (typeof debugLogger === 'function') {
    debugLogger(phase, data, requestId);
  } else if (debugLogger && debugLogger.log) {
    debugLogger.log(phase, { data, requestId });
  } else {
    console.log(`[${phase}]`, data, requestId);
  }
};

// 替换所有 debugLogger 调用为 log
log('api-call', responseData, requestId);
```

#### Step 3.2: 修复每个 debugLogger 调用
**系统性替换所有出错的行**:

1. **第 149 行**:
```typescript
// 原始：debugLogger(...)
// 修改为：
log('expert-model-start', { input }, requestId);
```

2. **第 172 行** (2 参数变 1 参数):
```typescript
// 原始：debugLogger.something(arg1, arg2)
// 修改为：
debugLogger.api?.('phase', data) || console.log('API:', data);
```

3. **继续修复其他行**，使用相同模式

#### Step 3.3: 处理模型调用逻辑
**确保异步调用正确**:
```typescript
async function callExpertModel(prompt: string, model: string) {
  try {
    log('model-call-start', { prompt, model });
    
    const response = await modelService.complete({
      prompt,
      model,
    });
    
    log('model-call-success', response);
    return response;
  } catch (error) {
    log('model-call-error', error);
    throw error;
  }
}
```

### Phase 4: 通用修复和优化 (10分钟)

#### Step 4.1: 添加通用类型定义
**创建文件**: `src/tools/utils/types.ts`
```typescript
// 工具系统的辅助类型
export type DebugLogger = {
  log: (phase: string, data: any) => void;
  info: (phase: string, data: any) => void;
  warn: (phase: string, data: any) => void;
  error: (phase: string, data: any) => void;
  api?: (phase: string, data: any, requestId?: string) => void;
  flow?: (phase: string, data: any, requestId?: string) => void;
};

export interface ToolContext extends ToolUseContext {
  setToolJSX?: (jsx: React.ReactElement) => void;
}
```

#### Step 4.2: 统一导入语句
**在所有三个工具文件的顶部**:
```typescript
import type { Tool } from '../../Tool';
import type { ToolContext } from '../utils/types';
```

### Phase 5: 验证和测试 (15分钟)

#### Step 5.1: 检查各工具错误
```bash
# StickerRequestTool
npx tsc --noEmit 2>&1 | grep "StickerRequestTool"

# NotebookReadTool  
npx tsc --noEmit 2>&1 | grep "NotebookReadTool"

# AskExpertModelTool
npx tsc --noEmit 2>&1 | grep "AskExpertModelTool"
```

#### Step 5.2: 功能测试
```bash
# 启动 CLI
bun run dev

# 测试笔记本读取（如果有 .ipynb 文件）
# 输入: read notebook.ipynb

# 测试专家模型（如果配置了）
# 输入: ask "What is TypeScript?"
```

## 完成标志
- [ ] StickerRequestTool 编译无错误
- [ ] NotebookReadTool 类型转换正确
- [ ] AskExpertModelTool debugLogger 调用修复
- [ ] 所有工具都能加载
- [ ] TypeScript 错误减少至少 20 个

## 注意事项
1. **保持功能完整** - 不要删除功能代码
2. **日志很重要** - 保留或改进日志记录
3. **处理边缘情况** - 考虑 undefined/null 值
4. **测试特殊文件** - 如 .ipynb 文件的解析

## 调试技巧

### 检查对象结构
```typescript
console.log('debugLogger type:', typeof debugLogger);
console.log('debugLogger keys:', Object.keys(debugLogger || {}));
```

### 类型调试
```typescript
// 临时添加以查看类型
type DebugType = typeof debugLogger;
const checkType: DebugType = null!;
```

### 运行时检查
```typescript
if (!context.setToolJSX) {
  console.warn('setToolJSX not available in context');
}
```

## 常见问题

### Q: debugLogger 的正确用法？
```bash
# 查找其他使用示例
grep -r "debugLogger" src --include="*.ts" --include="*.tsx" | head -20
```

### Q: setToolJSX 在哪里定义？
```bash
# 查找定义
grep -r "setToolJSX" src --include="*.ts" --include="*.tsx"
```

### Q: Notebook 类型定义？
```bash
# 查找 Jupyter 相关类型
find src -name "*.d.ts" | xargs grep -l "notebook\|jupyter"
```

## 完成后
这是 Step 1 的最后一个并行任务。完成后，可以进入 Step 2 的并行任务（React 组件、Hooks、Services 的修复）。
# Step 2 - Worker 1: Hook 系统修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
Kode CLI 使用自定义 React Hooks 处理终端输入和用户交互。主要问题是 Ink 的 Key 类型缺少某些属性，以及一些未使用的 @ts-expect-error 指令。

## 系统架构上下文
```
src/hooks/
├── useDoublePress.ts       - 双击检测
├── useTextInput.ts         - 文本输入处理
├── useUnifiedCompletion.ts - 自动完成功能
└── ...其他 hooks
```

## 任务目标
1. 修复 Key 类型属性缺失问题
2. 移除未使用的 @ts-expect-error 指令
3. 确保所有输入处理正常工作

## 详细施工步骤

### Phase 1: 修复 Key 类型问题 (25分钟)

#### Step 1.1: 修复 useTextInput.ts
**文件**: `src/hooks/useTextInput.ts`
**问题位置**: 第 143, 266, 268, 272, 274 行

**第 143 行 - 移除未使用的指令**:
```typescript
// 删除这一行
// @ts-expect-error
```

**第 266, 268 行 - fn 属性不存在**:
```typescript
// 原始代码
if (input.fn) {
  // 处理功能键
}

// 修复方案 1 - 类型断言
if ((input as any).fn) {
  // 处理功能键
}

// 修复方案 2 - 属性检查
if ('fn' in input && input.fn) {
  // 处理功能键
}

// 修复方案 3 - 扩展类型（如果 step_0 已创建类型增强）
// 确保导入了增强类型
import type { Key } from 'ink';
// Key 类型应该已经包含 fn 属性
```

**第 272, 274 行 - home 和 end 属性**:
```typescript
// 原始代码
if (input.home) {
  // 光标移到开始
}
if (input.end) {
  // 光标移到结束
}

// 修复 - 使用扩展的 Key 类型或类型守卫
if ('home' in input && input.home) {
  setCursorPosition(0);
}
if ('end' in input && input.end) {
  setCursorPosition(value.length);
}
```

#### Step 1.2: 创建 Key 类型辅助函数
**在 useTextInput.ts 顶部添加**:
```typescript
// Key 类型辅助函数
interface ExtendedKey extends Key {
  fn?: boolean;
  home?: boolean;
  end?: boolean;
}

function isExtendedKey(key: Key): key is ExtendedKey {
  return true; // 因为我们已经扩展了类型
}

// 或者更安全的检查
function hasProperty<T extends object, K extends PropertyKey>(
  obj: T,
  key: K
): obj is T & Record<K, unknown> {
  return key in obj;
}
```

#### Step 1.3: 重构键盘处理逻辑
**优化键盘输入处理**:
```typescript
const handleKeyPress = (input: string, key: Key) => {
  // 功能键处理
  if (hasProperty(key, 'fn') && key.fn) {
    handleFunctionKey(input);
    return;
  }
  
  // Home 键
  if (hasProperty(key, 'home') && key.home) {
    setCursorPosition(0);
    return;
  }
  
  // End 键
  if (hasProperty(key, 'end') && key.end) {
    setCursorPosition(value.length);
    return;
  }
  
  // 普通按键处理
  if (key.return) {
    handleSubmit();
  } else if (key.backspace) {
    handleBackspace();
  } else if (key.delete) {
    handleDelete();
  } else if (key.leftArrow) {
    moveCursorLeft();
  } else if (key.rightArrow) {
    moveCursorRight();
  } else {
    insertText(input);
  }
};
```

### Phase 2: 修复 useUnifiedCompletion.ts (20分钟)

#### Step 2.1: 修复 space 属性
**文件**: `src/hooks/useUnifiedCompletion.ts`
**定位**: 第 1151 行
**问题**: space 属性不存在

**查找代码**:
```typescript
if (key.space) {
  // 处理空格键
}
```

**修复为**:
```typescript
// 方案 1 - 检查输入字符
if (input === ' ') {
  // 处理空格键
}

// 方案 2 - 扩展属性检查
if ('space' in key && key.space) {
  // 处理空格键
}

// 方案 3 - 组合检查
if (input === ' ' || (hasProperty(key, 'space') && key.space)) {
  // 处理空格键
}
```

#### Step 2.2: 优化自动完成逻辑
**改进类型安全**:
```typescript
interface CompletionKey extends Key {
  space?: boolean;
  tab?: boolean;
}

const handleCompletionKey = (input: string, key: Key) => {
  const extKey = key as CompletionKey;
  
  // Tab 完成
  if (key.tab) {
    return performCompletion();
  }
  
  // 空格触发
  if (input === ' ' || extKey.space) {
    return checkForCompletion();
  }
  
  // Escape 取消
  if (key.escape) {
    return cancelCompletion();
  }
};
```

### Phase 3: 修复 useDoublePress.ts (10分钟)

#### Step 3.1: 移除未使用的指令
**文件**: `src/hooks/useDoublePress.ts`
**定位**: 第 33 行

**操作**:
```typescript
// 删除这一行
// @ts-expect-error
```

#### Step 3.2: 检查相关代码
**确保删除指令后代码仍然正确**:
```typescript
// 检查第 33 行附近的代码
// 如果有类型问题，正确修复而不是使用 @ts-expect-error
```

### Phase 4: 创建通用 Hook 工具函数 (15分钟)

#### Step 4.1: 创建 hook 工具文件
**创建文件**: `src/hooks/utils.ts`
```typescript
import type { Key } from 'ink';

// 扩展的 Key 类型
export interface ExtendedKey extends Key {
  fn?: boolean;
  home?: boolean;
  end?: boolean;
  space?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

// 类型守卫
export function isExtendedKey(key: Key): key is ExtendedKey {
  return true;
}

// 属性检查
export function hasKeyProperty<K extends keyof ExtendedKey>(
  key: Key,
  property: K
): key is Key & Record<K, ExtendedKey[K]> {
  return property in key;
}

// 键盘事件标准化
export function normalizeKey(input: string, key: Key): ExtendedKey {
  return {
    ...key,
    space: input === ' ',
    // 添加其他标准化逻辑
  } as ExtendedKey;
}
```

#### Step 4.2: 更新 hooks 使用工具函数
**在需要的 hooks 中导入**:
```typescript
import { hasKeyProperty, normalizeKey } from './utils';

// 使用
const normalizedKey = normalizeKey(input, key);
if (normalizedKey.space) {
  // 处理空格
}
```

### Phase 5: 验证和测试 (15分钟)

#### Step 5.1: 检查 Hook 错误
```bash
# useTextInput
npx tsc --noEmit 2>&1 | grep "useTextInput"

# useUnifiedCompletion
npx tsc --noEmit 2>&1 | grep "useUnifiedCompletion"

# useDoublePress
npx tsc --noEmit 2>&1 | grep "useDoublePress"

# 所有 hooks
npx tsc --noEmit 2>&1 | grep "src/hooks/"
```

#### Step 5.2: 功能测试
```bash
# 启动 CLI
bun run dev

# 测试文本输入
# 输入一些文本，测试：
# - 光标移动 (箭头键)
# - Home/End 键
# - 退格/删除
# - 自动完成 (Tab)

# 测试双击
# 快速按两次相同的键
```

#### Step 5.3: 创建测试脚本
**创建文件**: `test-hooks.js`
```javascript
// 简单的键盘输入测试
const readline = require('readline');

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

console.log('Press keys to test (Ctrl+C to exit):');

process.stdin.on('keypress', (str, key) => {
  console.log('Input:', str, 'Key:', key);
  
  if (key && key.ctrl && key.name === 'c') {
    process.exit();
  }
});
```

## 完成标志
- [ ] useTextInput.ts 无类型错误
- [ ] useUnifiedCompletion.ts 无类型错误
- [ ] useDoublePress.ts 无未使用指令
- [ ] 所有键盘输入正常工作
- [ ] 自动完成功能正常
- [ ] TypeScript 错误减少至少 10 个

## 注意事项
1. **保持输入响应** - 不要引入延迟
2. **处理边缘情况** - 考虑特殊键组合
3. **保留快捷键** - 确保所有快捷键仍然工作
4. **浏览器兼容性** - 如果有 web 版本，考虑兼容性

## 调试技巧

### 监控键盘输入
```typescript
useInput((input, key) => {
  console.log('Raw input:', { input, key });
  console.log('Key properties:', Object.keys(key));
});
```

### 测试特殊键
```typescript
const testKeys = {
  'Ctrl+C': { ctrl: true, name: 'c' },
  'Home': { home: true },
  'End': { end: true },
  'F1': { fn: true, name: 'f1' },
};
```

### 性能监控
```typescript
const handleInput = (input: string, key: Key) => {
  const start = performance.now();
  // 处理逻辑
  const end = performance.now();
  if (end - start > 16) { // 超过一帧
    console.warn('Slow input handling:', end - start);
  }
};
```

## 常见问题

### Q: Key 类型从哪里来？
```bash
# 查看 ink 的类型定义
cat node_modules/ink/build/index.d.ts | grep "interface Key"
```

### Q: 如何处理组合键？
```typescript
if (key.ctrl && key.name === 'a') {
  // Ctrl+A: 全选
}
if (key.meta && key.name === 'v') {
  // Cmd+V (Mac) / Win+V: 粘贴
}
```

### Q: 输入延迟问题？
```typescript
// 使用防抖
const debouncedHandler = useMemo(
  () => debounce(handleInput, 50),
  []
);
```

## 完成后
Hook 系统修复完成后，用户输入处理应该完全正常。这是用户体验的关键部分，确保充分测试。
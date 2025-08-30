# Step 2 - Worker 0: React 19 / Ink 6 组件修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
React 19 和 Ink 6 引入了破坏性更改，特别是关于 props 的处理。主要问题是 `children` prop 现在是必需的，以及 `key` prop 不能作为组件 props 传递。

## 系统架构上下文
```
src/
├── commands/
│   └── agents.tsx           - 代理命令界面
├── components/
│   └── messages/
│       └── AssistantToolUseMessage.tsx
├── screens/
│   ├── REPL.tsx            - 主交互界面
│   └── Doctor.tsx          - 诊断界面
```

## 任务目标
1. 修复所有 React 19 的 children prop 问题
2. 修复 key prop 传递问题
3. 修复导入路径问题
4. 确保所有组件正确渲染

## 详细施工步骤

### Phase 1: 修复 key prop 问题 (20分钟)

#### Step 1.1: 修复 agents.tsx 中的 key prop
**文件**: `src/commands/agents.tsx`
**定位**: 第 2357, 2832, 3137, 3266 行
**问题**: key 作为 props 传递而不是 JSX 属性

**查找模式**:
```typescript
<Text {...{key: index, color: 'gray'}}>
```

**修复为**:
```typescript
<Text key={index} color="gray">
```

**具体修复**:

1. **第 2357 行**:
```typescript
// 原始
<Text {...{key: index, color: 'gray'}}>
// 修复
<Text key={index} color="gray">
```

2. **第 3137 行**:
```typescript
// 原始
<Text {...{key: someKey, color: 'blue'}}>
// 修复
<Text key={someKey} color="blue">
```

3. **第 3266 行**:
```typescript
// 原始
<Text {...{key: i, color: 'green'}}>
// 修复
<Text key={i} color="green">
```

#### Step 1.2: 修复 isContinue 属性访问
**文件**: `src/commands/agents.tsx`
**定位**: 第 2832 行
**问题**: 属性在某些类型上不存在

**查找代码**:
```typescript
if (option.isContinue) {
```

**修复为**:
```typescript
if ('isContinue' in option && option.isContinue) {
  // 处理 continue 选项
}
```

### Phase 2: 修复 children prop 问题 (25分钟)

#### Step 2.1: AssistantToolUseMessage 组件
**文件**: `src/components/messages/AssistantToolUseMessage.tsx`
**定位**: 第 65, 91 行

**第 65 行 - 函数调用参数**:
```typescript
// 查找
someFunction(argument)
// 如果函数不期望参数，修改为
someFunction()
```

**第 91 行 - 缺少 children**:
```typescript
// 原始
<Text agentType={agentType} bold />
// 修复
<Text bold>
  {agentType ? `[${agentType}]` : 'Processing...'}
</Text>
```

#### Step 2.2: REPL.tsx 组件
**文件**: `src/screens/REPL.tsx`
**定位**: 第 526, 621, 625 行

**第 526 行 - TodoProvider**:
```typescript
// 原始
<TodoProvider />
// 修复
<TodoProvider>
  {/* 子组件内容 */}
  <Box>{/* 实际的 TODO 界面 */}</Box>
</TodoProvider>
```

**第 621 行 - PermissionProvider**:
```typescript
// 原始
<PermissionProvider isBypassPermissionsModeAvailable={...} />
// 修复
<PermissionProvider isBypassPermissionsModeAvailable={...}>
  {children}
</PermissionProvider>
```

**第 625 行 - Generic Provider**:
```typescript
// 原始
<SomeProvider items={items} />
// 修复
<SomeProvider items={items}>
  {/* 查找原始代码中应该包含的子元素 */}
  {renderContent()}
</SomeProvider>
```

### Phase 3: 修复导入路径问题 (10分钟)

#### Step 3.1: Doctor.tsx 导入路径
**文件**: `src/screens/Doctor.tsx`
**定位**: 第 5 行
**问题**: TypeScript 不允许 .tsx 扩展名

**查找代码**:
```typescript
import Something from '../path/to/file.tsx'
```

**修复为**:
```typescript
import Something from '../path/to/file'
```

### Phase 4: 修复 React 19 特定问题 (15分钟)

#### Step 4.1: 检查所有 Text 组件
**全局搜索并修复**:
```bash
# 查找所有可能缺少 children 的 Text 组件
grep -n "<Text.*\/>" src/commands/agents.tsx
```

**修复模式**:
```typescript
// 如果发现自闭合的 Text 没有内容
<Text color="gray" />
// 修复为
<Text color="gray">{' '}</Text>
// 或
<Text color="gray">​</Text> // 零宽空格
```

#### Step 4.2: 检查所有 Box 组件
```typescript
// 确保 Box 组件有内容或明确表示为空
<Box />
// 修复为
<Box>{/* intentionally empty */}</Box>
```

### Phase 5: 处理 React 19 严格模式 (10分钟)

#### Step 5.1: 添加类型声明（如果需要）
**创建文件**: `src/types/react-overrides.d.ts`
```typescript
import 'react';

declare module 'react' {
  interface PropsWithChildren {
    children?: React.ReactNode;
  }
}
```

#### Step 5.2: 更新组件接口
**对于自定义组件，确保 props 类型正确**:
```typescript
interface MyComponentProps {
  children: React.ReactNode; // 如果需要 children
  // 或
  children?: React.ReactNode; // 如果 children 可选
}
```

### Phase 6: 验证和测试 (20分钟)

#### Step 6.1: 检查组件错误
```bash
# 检查 agents.tsx
npx tsc --noEmit 2>&1 | grep "agents.tsx"

# 检查消息组件
npx tsc --noEmit 2>&1 | grep "AssistantToolUseMessage"

# 检查 REPL
npx tsc --noEmit 2>&1 | grep "REPL.tsx"

# 检查 Doctor
npx tsc --noEmit 2>&1 | grep "Doctor.tsx"
```

#### Step 6.2: 运行时测试
```bash
# 启动 CLI
bun run dev

# 测试代理命令
/agents

# 测试帮助
/help

# 测试诊断
/doctor
```

#### Step 6.3: 视觉检查
确保：
- 文本正确显示
- 列表项有正确的 key
- 没有 React 警告在控制台

## 完成标志
- [ ] 所有 key prop 正确传递
- [ ] 所有组件都有必需的 children
- [ ] 导入路径没有 .tsx 扩展名
- [ ] agents.tsx 无类型错误
- [ ] REPL.tsx 无类型错误
- [ ] 所有组件正确渲染
- [ ] TypeScript 错误减少至少 15 个

## 注意事项
1. **保持布局** - 不要改变组件的视觉布局
2. **保留功能** - 确保交互功能正常
3. **React 19 兼容** - 遵循新的严格规则
4. **Ink 6 特性** - 利用新的 Ink 特性如果适用

## 调试技巧

### 查找缺少 children 的组件
```typescript
// 添加临时 linter 规则
/* eslint-disable react/no-children-prop */
```

### 调试 key prop
```typescript
// 在开发模式下查看 key
{items.map((item, index) => {
  console.log('Rendering item with key:', index);
  return <Text key={index}>{item}</Text>;
})}
```

### 检查组件 props
```typescript
// 临时添加 props 日志
const MyComponent: React.FC<Props> = (props) => {
  console.log('Component props:', props);
  // ...
};
```

## 常见问题

### Q: children 应该是什么类型？
```typescript
// 对于 Ink 组件
children: React.ReactNode

// 对于文本组件
children: string | number

// 对于容器
children: React.ReactElement | React.ReactElement[]
```

### Q: key 应该如何传递？
```typescript
// 正确 ✅
<Component key={id} otherProp="value" />

// 错误 ❌
<Component {...{key: id, otherProp: "value"}} />
<Component key={id} {...props} /> // 如果 props 包含 key
```

### Q: 如何处理条件渲染的 children？
```typescript
<Container>
  {condition ? <Child /> : null}
  {/* 或 */}
  {condition && <Child />}
</Container>
```

## 完成后
此任务完成后，React 组件相关的错误应该大幅减少。可以继续进行其他 Step 2 的并行任务。
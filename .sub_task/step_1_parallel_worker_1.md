# Step 1 - Worker 1: FileWriteTool & FileEditTool 修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
这两个工具负责文件的写入和编辑操作，是 Kode CLI 的核心功能。它们都有相似的权限请求界面和错误处理逻辑。

## 系统架构上下文
```
src/tools/
├── FileWriteTool/
│   ├── FileWriteTool.tsx      - 文件写入工具
│   └── prompt.ts              - 工具提示词
├── FileEditTool/
│   ├── FileEditTool.tsx       - 文件编辑工具
│   ├── prompt.ts              - 工具提示词
│   └── utils.ts               - 工具函数
```

## 任务目标
1. 修复两个工具的 renderToolUseRejectedMessage 签名问题
2. 修复 renderToolResultMessage 签名问题
3. 确保文件操作权限流程正常

## 详细施工步骤

### Phase 1: 修复 FileWriteTool (25分钟)

#### Step 1.1: 修复 renderToolUseRejectedMessage 签名
**文件**: `src/tools/FileWriteTool/FileWriteTool.tsx`
**定位**: 搜索 `renderToolUseRejectedMessage` (大约第 70 行)
**当前代码**:
```typescript
renderToolUseRejectedMessage({ file_path, content }, { columns, verbose }) {
  return <FileWritePermissionRejected ... />;
}
```
**修复为**:
```typescript
renderToolUseRejectedMessage(input?: any, options?: any) {
  // 如果函数体需要这些参数
  const { file_path, content } = input || {};
  const { columns, verbose } = options || {};
  return <FileWritePermissionRejected ... />;
}
```
**或者如果接口允许可选**:
```typescript
renderToolUseRejectedMessage() {
  // 简化版本，如果不需要参数
  return <FileWritePermissionRejected />;
}
```

#### Step 1.2: 修复 renderToolResultMessage 签名
**文件**: `src/tools/FileWriteTool/FileWriteTool.tsx`
**定位**: 搜索 `renderToolResultMessage` (大约第 122 行)
**当前代码**:
```typescript
renderToolResultMessage({ filePath, content, structuredPatch, type }, { verbose }) {
  return <FileWriteResultMessage ... />;
}
```
**修复为**:
```typescript
renderToolResultMessage(output: any) {
  const { filePath, content, structuredPatch, type } = output;
  // 注意：第二个参数 verbose 可能需要从其他地方获取
  return <FileWriteResultMessage ... />;
}
```

#### Step 1.3: 导入必要的类型
**文件**: `src/tools/FileWriteTool/FileWriteTool.tsx`
**在文件顶部添加**:
```typescript
import type { Tool, ToolUseContext } from '../../Tool';
import type { Hunk } from 'diff';
```

#### Step 1.4: 修复组件导入
**检查导入部分**:
```typescript
// 确保这些组件存在并正确导入
import { FileWritePermissionRejected } from '../../components/permissions/FileWritePermissionRequest';
import { FileWriteResultMessage } from '../../components/messages/FileWriteResultMessage';
```

### Phase 2: 修复 FileEditTool (25分钟)

#### Step 2.1: 修复 renderToolUseRejectedMessage 签名
**文件**: `src/tools/FileEditTool/FileEditTool.tsx`
**定位**: 搜索 `renderToolUseRejectedMessage` (大约第 78 行)
**当前代码**:
```typescript
renderToolUseRejectedMessage({ file_path, old_string, new_string }, { columns, verbose }) {
  return <FileEditPermissionRejected ... />;
}
```
**修复为**:
```typescript
renderToolUseRejectedMessage(input?: any, options?: any) {
  const { file_path, old_string, new_string } = input || {};
  const { columns, verbose } = options || {};
  return <FileEditPermissionRejected ... />;
}
```

#### Step 2.2: 检查 validateInput 方法
**文件**: `src/tools/FileEditTool/FileEditTool.tsx`
**定位**: 搜索 `validateInput`
**确保签名正确**:
```typescript
async validateInput(
  { file_path, old_string, new_string }: any,
  { readFileTimestamps }: ToolUseContext
): Promise<{ result: boolean; message?: string }> {
  // 实现...
}
```

#### Step 2.3: 检查 call 方法
**文件**: `src/tools/FileEditTool/FileEditTool.tsx`
**定位**: 搜索 `call:`
**确保异步生成器签名正确**:
```typescript
async *call(
  { file_path, old_string, new_string }: any,
  context: ToolUseContext
): AsyncGenerator<{ type: "result"; data: any; resultForAssistant: string }> {
  // 实现...
  yield {
    type: "result",
    data: result,
    resultForAssistant: `File ${file_path} updated successfully`
  };
}
```

#### Step 2.4: 修复工具导出
**文件**: `src/tools/FileEditTool/FileEditTool.tsx`
**在文件末尾确认**:
```typescript
export const FileEditTool: Tool<any, any> = {
  name: "file_edit",
  description: async () => "Edit files",
  // ... 所有必需的方法
};
```

### Phase 3: 修复共享组件和工具函数 (15分钟)

#### Step 3.1: 检查权限组件
**文件**: `src/components/permissions/FileWritePermissionRequest/index.tsx`
**确保导出了**:
```typescript
export { FileWritePermissionRejected } from './FileWritePermissionRejected';
```

**文件**: `src/components/permissions/FileEditPermissionRequest/index.tsx`
**确保导出了**:
```typescript
export { FileEditPermissionRejected } from './FileEditPermissionRejected';
```

#### Step 3.2: 修复 utils.ts (如果存在)
**文件**: `src/tools/FileEditTool/utils.ts`
**检查函数签名**:
```typescript
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): { updatedContent: string; occurrences: number } {
  // 确保返回值包含所需属性
}
```

### Phase 4: 验证修复 (10分钟)

#### Step 4.1: 检查 FileWriteTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "FileWriteTool"
```
**预期**: 无错误或错误显著减少

#### Step 4.2: 检查 FileEditTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "FileEditTool"
```
**预期**: 无错误或错误显著减少

#### Step 4.3: 功能测试
```bash
# 启动 CLI
bun run dev

# 测试文件写入（创建测试文件）
# 输入: write test.txt "Hello World"

# 测试文件编辑（如果上面创建成功）
# 输入: edit test.txt "Hello" "Hi"

# 清理测试文件
rm test.txt
```

### Phase 5: 处理边缘情况 (10分钟)

#### Step 5.1: 如果组件不存在
创建临时占位组件：
```typescript
// 临时解决方案
const FileWritePermissionRejected = () => <Text>Permission rejected</Text>;
const FileEditPermissionRejected = () => <Text>Permission rejected</Text>;
```

#### Step 5.2: 如果类型仍然不匹配
使用类型断言：
```typescript
const tool = {
  // ... tool implementation
} as Tool<any, any>;

export const FileWriteTool = tool;
```

## 完成标志
- [ ] FileWriteTool 编译无错误
- [ ] FileEditTool 编译无错误
- [ ] 权限拒绝消息正确显示
- [ ] 文件写入功能正常
- [ ] 文件编辑功能正常
- [ ] TypeScript 错误减少至少 8 个

## 注意事项
1. **保持权限检查逻辑** - 不要跳过权限验证
2. **保留错误处理** - 确保所有错误情况都有处理
3. **测试文件操作** - 使用临时文件测试，避免修改重要文件
4. **备份修改** - 定期 git add 保存进度

## 常见问题

### Q: 找不到权限组件？
```bash
find src -name "*Permission*" -type f | grep -E "(Write|Edit)"
```

### Q: Hunk 类型不存在？
```typescript
// 添加类型定义
type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
```

### Q: 组件导入路径错误？
检查实际路径：
```bash
ls -la src/components/permissions/
```

## 调试技巧
1. 使用 `console.log` 临时调试：
   ```typescript
   console.log('FileWriteTool input:', input);
   ```

2. 检查运行时类型：
   ```typescript
   console.log('Type of input:', typeof input);
   ```

3. 使用 TypeScript 编译器获取详细错误：
   ```bash
   npx tsc --noEmit --pretty 2>&1 | less
   ```

## 完成后
标记此任务完成，继续其他并行任务。记录任何未解决的问题供后续处理。
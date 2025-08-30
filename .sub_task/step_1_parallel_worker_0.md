# Step 1 - Worker 0: ArchitectTool & FileReadTool 修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
Kode CLI 的工具系统采用插件架构，每个工具都实现 Tool 接口。本任务负责修复 ArchitectTool 和 FileReadTool 的类型错误。

## 系统架构上下文
```
src/tools/
├── ArchitectTool/
│   ├── ArchitectTool.tsx    - 架构分析工具
│   └── prompt.ts            - 工具提示词
├── FileReadTool/
│   ├── FileReadTool.tsx     - 文件读取工具
│   └── prompt.ts            - 工具提示词
```

## 任务目标
1. 修复 ArchitectTool 的返回类型不匹配问题
2. 修复 FileReadTool 的图像处理返回类型问题
3. 确保两个工具都能正确编译和运行

## 详细施工步骤

### Phase 1: 修复 ArchitectTool (30分钟)

#### Step 1.1: 修复 renderResultForAssistant 返回类型
**文件**: `src/tools/ArchitectTool/ArchitectTool.tsx`
**定位方法**: 搜索 `renderResultForAssistant`
**当前问题**: 返回 string | array，但接口期望只返回 string
**查找代码** (大约在第 100-150 行):
```typescript
renderResultForAssistant(data: { type: "text"; file: {...} } | { type: "image"; file: {...} }) {
  if (data.type === "image") {
    return [{
      type: "image",
      source: {
        type: "base64",
        data: data.file.base64,
        media_type: data.file.type,
      },
    }];
  }
  return `File content...`;
}
```
**修复方案**: 由于 Tool 接口已在 Step 0 中更新为允许 string | any[]，这里不需要修改，只需确认导入正确。

#### Step 1.2: 修复 renderToolUseRejectedMessage 签名
**文件**: `src/tools/ArchitectTool/ArchitectTool.tsx`
**定位**: 搜索第二个工具定义（FileWriteTool 部分）
**查找代码** (大约在第 200-250 行):
```typescript
renderToolUseRejectedMessage({ file_path, content }, { columns, verbose }) {
  // ...
}
```
**替换为**:
```typescript
renderToolUseRejectedMessage({ file_path, content }: any = {}, { columns, verbose }: any = {}) {
  // 如果函数体使用了这些参数，保持不变
  // 如果没使用，可以简化为：
  // renderToolUseRejectedMessage() {
}
```

#### Step 1.3: 修复 call 方法签名
**文件**: `src/tools/ArchitectTool/ArchitectTool.tsx`
**定位**: 搜索第三个工具定义（通常在文件末尾）
**查找代码** (大约在第 60 行):
```typescript
call: async function* ({ prompt, context }, toolUseContext, canUseTool) {
```
**替换为**:
```typescript
call: async function* ({ prompt, context }: any, toolUseContext: any) {
  // 移除第三个参数 canUseTool，如果函数体内使用了它，需要调整逻辑
```

#### Step 1.4: 修复第三个工具的 renderResultForAssistant
**文件**: `src/tools/ArchitectTool/ArchitectTool.tsx`
**查找代码** (大约在第 101 行):
```typescript
renderResultForAssistant: (data: TextBlock[]) => data,
```
**替换为**:
```typescript
renderResultForAssistant: (data: TextBlock[]) => JSON.stringify(data),
```

### Phase 2: 修复 FileReadTool (30分钟)

#### Step 2.1: 修复图像返回类型
**文件**: `src/tools/FileReadTool/FileReadTool.tsx`
**定位**: 搜索 `renderResultForAssistant`
**查找代码** (大约在第 255 行):
```typescript
renderResultForAssistant(data) {
  if (data.type === "image") {
    return [{
      type: "image",
      source: {
        type: "base64",
        data: data.file.base64,
        media_type: data.file.type,
      },
    }];
  }
  // ... text handling
}
```
**修复**: 由于 Tool 接口已支持 string | any[]，此处不需要修改

#### Step 2.2: 处理 sharp 模块导入
**文件**: `src/tools/FileReadTool/FileReadTool.tsx`
**定位**: 搜索 `import.*sharp` (大约在第 319 行)
**查找代码**:
```typescript
import sharp from 'sharp';
```
**修复方案 1 - 动态导入** (推荐):
```typescript
// 删除顶部的 import sharp from 'sharp';
// 在使用处改为动态导入
const sharp = await import('sharp').catch(() => null);
if (!sharp) {
  throw new Error('Sharp module not available');
}
```

**修复方案 2 - 条件导入**:
```typescript
let sharp: any;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}
```

#### Step 2.3: 添加类型声明
**文件**: `src/tools/FileReadTool/FileReadTool.tsx`
**在文件顶部添加**:
```typescript
import type { ImageBlockParam } from '@anthropic-ai/sdk';
// 如果 ImageBlockParam 不存在，使用：
type ImageBlockParam = {
  Source: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
};
```

### Phase 3: 验证修复 (10分钟)

#### Step 3.1: 单独检查 ArchitectTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "ArchitectTool"
```
**预期结果**: 无输出或错误数量显著减少

#### Step 3.2: 单独检查 FileReadTool 错误
```bash
npx tsc --noEmit 2>&1 | grep "FileReadTool"
```
**预期结果**: 无输出或只有 sharp 相关警告

#### Step 3.3: 测试工具功能
```bash
# 启动 CLI
bun run dev

# 测试文件读取
# 输入: read package.json

# 测试架构分析（如果有此命令）
# 输入: analyze src/Tool.ts
```

### Phase 4: 处理遗留问题 (10分钟)

#### Step 4.1: 如果还有类型错误
1. 检查是否正确导入了更新后的 Tool 接口：
   ```typescript
   import { Tool } from '../../Tool';
   ```

2. 确认 ToolUseContext 类型正确：
   ```typescript
   import type { ToolUseContext } from '../../Tool';
   ```

3. 对于复杂的类型错误，可以临时使用 any：
   ```typescript
   // 临时解决方案，标记 TODO
   // TODO: 正确类型化此处
   const result = someComplexOperation() as any;
   ```

## 完成标志
- [ ] ArchitectTool 编译无错误
- [ ] FileReadTool 编译无错误
- [ ] sharp 导入问题已解决
- [ ] 两个工具的基础功能可运行
- [ ] TypeScript 错误减少至少 10 个

## 注意事项
1. **保持功能不变** - 只修复类型，不改变业务逻辑
2. **保留原有注释** - 不要删除现有的代码注释
3. **测试每个修改** - 每次修改后运行 tsc 检查
4. **使用版本控制** - 定期 git add 保存进度

## 常见问题解决

### Q: 找不到 Tool 接口定义？
```bash
find src -name "*.ts" -o -name "*.tsx" | xargs grep "export interface Tool"
```

### Q: ImageBlockParam 类型不存在？
创建本地类型定义：
```typescript
// 在文件顶部添加
interface ImageBlockParam {
  Source: string;
}
```

### Q: sharp 模块一直报错？
确认已安装：
```bash
bun add sharp
bun add -d @types/sharp
```

## 完成后
标记此任务完成，可以继续其他 worker 的并行任务。
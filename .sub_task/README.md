# TypeScript 错误修复 - 快速参考指南

## 🚨 重要：必须先完成 Step 0！

在开始任何并行任务之前，**必须完成 `step_0_foundation_serial.md`**。这是所有其他修复的基础。

## 📁 文件结构

```
.sub_task/
├── README.md                        # 本文件
├── execution_plan.md               # 总体执行计划和依赖关系
├── step_0_foundation_serial.md     # ⚠️ 必须首先完成（串行）
├── step_1_parallel_worker_0.md     # 工具修复：ArchitectTool, FileReadTool
├── step_1_parallel_worker_1.md     # 工具修复：FileWriteTool, FileEditTool
├── step_1_parallel_worker_2.md     # 工具修复：TaskTool, MultiEditTool
├── step_1_parallel_worker_3.md     # 工具修复：其他工具
├── step_2_parallel_worker_0.md     # React 组件修复
├── step_2_parallel_worker_1.md     # Hook 系统修复
└── step_2_parallel_worker_2.md     # Service 层修复
```

## 🎯 快速开始

### 单人执行
```bash
# 1. 完成基础修复
# 打开 step_0_foundation_serial.md 并按步骤执行

# 2. 检查进度
npx tsc --noEmit 2>&1 | wc -l

# 3. 依次完成 Step 1 的 4 个任务

# 4. 依次完成 Step 2 的 3 个任务

# 5. 最终验证
bun run dev
```

### 多人协作
```bash
# 人员 A：负责 Step 0（独自完成）
# 完成后通知其他人

# Step 0 完成后，分配任务：
# 人员 B：step_1_parallel_worker_0.md
# 人员 C：step_1_parallel_worker_1.md
# 人员 D：step_1_parallel_worker_2.md
# 人员 E：step_1_parallel_worker_3.md
# 人员 F：step_2_parallel_worker_0.md
# 人员 G：step_2_parallel_worker_1.md
# 人员 H：step_2_parallel_worker_2.md
```

## 📊 进度监控

### 实时错误计数
```bash
# 查看当前错误总数
npx tsc --noEmit 2>&1 | wc -l

# 查看错误分布
npx tsc --noEmit 2>&1 | grep -oE "src/[^(]*" | cut -d: -f1 | xargs -I {} dirname {} | sort | uniq -c | sort -rn
```

### 特定文件检查
```bash
# 检查特定工具的错误
npx tsc --noEmit 2>&1 | grep "FileWriteTool"

# 检查特定目录的错误
npx tsc --noEmit 2>&1 | grep "src/tools/"
```

## ✅ 完成标准

每个任务文档都有详细的"完成标志"部分。确保：
1. 所有复选框都已勾选
2. TypeScript 错误减少到预期数量
3. 功能测试通过

## 🔧 常用命令

```bash
# 开发模式运行
bun run dev

# TypeScript 检查
npx tsc --noEmit

# 查看具体错误
npx tsc --noEmit --pretty

# 测试特定功能
bun test

# 格式化代码
bun run format
```

## ⚠️ 注意事项

1. **不要跳过 Step 0** - 这会导致后续所有任务失败
2. **保持原有功能** - 只修复类型，不改变业务逻辑
3. **频繁保存** - 使用 git 定期提交进度
4. **遇到问题** - 参考每个文档的"常见问题"部分

## 📈 预期成果

| 里程碑 | 错误数 | 完成百分比 |
|--------|--------|-----------|
| 初始状态 | 127 | 0% |
| Step 0 完成 | ~80 | 37% |
| Step 1 完成 | ~40 | 69% |
| Step 2 完成 | ~15 | 88% |
| 最终清理 | 0 | 100% |

## 🆘 获取帮助

如果遇到无法解决的问题：
1. 检查对应任务文档的"常见问题"部分
2. 查看 `execution_plan.md` 的风险部分
3. 使用文档中提供的调试技巧
4. 记录问题供高级开发者处理

## 🎉 完成后

所有任务完成后：
1. 运行完整测试套件
2. 检查没有运行时错误
3. 更新 `tasks.md` 标记所有任务完成
4. 庆祝成功！🎊

---

**记住：质量比速度更重要。宁可慢一点，也要确保每个修复都正确。**
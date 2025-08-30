# Quick Fix Checklist - Start Here! 🚀

## Immediate Actions (Fix These First)

### 1. Install Missing Dependencies (2 min)
```bash
bun add sharp
bun add -d @types/sharp
```

### 2. Create Type Augmentation File (5 min)
Create `src/types/ink-augmentation.d.ts`:
```typescript
declare module 'ink' {
  interface Key {
    fn?: boolean
    home?: boolean  
    end?: boolean
    space?: boolean
  }
}
```

### 3. Fix Critical Type Errors (15 min)

#### A. Fix src/query.ts (lines 203-210)
Replace direct `.message` access with type guard:
```typescript
// Before: msg.message
// After:
if (msg.type !== 'progress' && 'message' in msg) {
  // use msg.message
}
```

#### B. Fix src/utils/messageContextManager.ts (line 136)
Add missing properties:
```typescript
return {
  type: "assistant",
  message: { role: "assistant", content: [...] },
  costUSD: 0,
  durationMs: 0,
  uuid: crypto.randomUUID() as UUID
}
```

#### C. Fix src/utils/thinking.ts (line 115)
Remove 'minimal' from type:
```typescript
// Change from: "low" | "medium" | "high" | "minimal"
// To: "low" | "medium" | "high"
```

### 4. Quick Component Fixes (10 min)

#### A. Fix key prop issues in src/commands/agents.tsx
```typescript
// Instead of: <Text {...{key: index, color: 'gray'}}>
// Use: <Text key={index} color="gray">
```

#### B. Add children to components
```typescript
// src/components/messages/AssistantToolUseMessage.tsx (line 91)
<Text agentType={agentType} bold>{/* Add content here */}</Text>

// src/screens/REPL.tsx (line 526)
<TodoProvider>{/* Add children */}</TodoProvider>
```

### 5. Remove Unused Directives (5 min)
Remove these lines:
- src/entrypoints/cli.tsx:318
- src/hooks/useDoublePress.ts:33  
- src/hooks/useTextInput.ts:143
- src/utils/messages.tsx:301

## Verify Progress
```bash
# Check error count
npx tsc --noEmit 2>&1 | wc -l

# Should see significant reduction after these fixes
```

## Next Steps
Once these quick fixes are done:
1. Run full TypeScript check
2. Move to Phase 2 (Tool implementations)
3. Use tasks.md for detailed tracking

## Expected Result
These quick fixes should eliminate ~40-50% of errors, making the remaining issues much clearer.
# Phase 1: Core Type System Foundation - Detailed Fix Guide

## 1.1 Message Type System Fix

### Problem Analysis
The `Message` type union has inconsistent property access. Some code expects a `message` property that doesn't exist on all union members.

### Fix Location: `src/messages.ts`
```typescript
// Current problematic union
export type Message = AssistantMessage | UserMessage | ProgressMessage

// The issue: Code in query.ts accesses .message property which doesn't exist on ProgressMessage
```

### Solution
```typescript
// Option 1: Add message property to ProgressMessage
export interface ProgressMessage {
  type: 'progress'
  message?: any  // Add this
  // ... existing properties
}

// Option 2: Fix access pattern in query.ts
// Instead of directly accessing .message, use type guards:
if (msg.type !== 'progress' && 'message' in msg) {
  // Safe to access msg.message
}
```

### Fix in `src/utils/messageContextManager.ts` (line 136)
```typescript
// Current
return {
  type: "assistant",
  message: { role: "assistant", content: [...] }
}

// Fixed
return {
  type: "assistant",
  message: { role: "assistant", content: [...] },
  costUSD: 0,        // Add required property
  durationMs: 0,     // Add required property
  uuid: crypto.randomUUID() as UUID  // Add required property
}
```

## 1.2 Tool Interface Alignment

### Problem Analysis
The Tool interface expects specific return types, but implementations return different types.

### Fix Location: `src/Tool.ts`
```typescript
// Current interface (approximate)
export interface Tool<TInput, TOutput> {
  renderResultForAssistant(output: TOutput): string
  renderToolUseRejectedMessage(): React.ReactElement
  // ...
}

// Fixed interface
export interface Tool<TInput, TOutput> {
  renderResultForAssistant(output: TOutput): string | any[]  // Allow arrays
  renderToolUseRejectedMessage(...args: any[]): React.ReactElement  // Allow optional params
  // ...
}
```

### Add to ToolUseContext
```typescript
// In src/types.ts or wherever ToolUseContext is defined
export interface ToolUseContext {
  // ... existing properties
  setToolJSX?: (jsx: React.ReactElement) => void  // Add as optional
}

export interface ExtendedToolUseContext extends ToolUseContext {
  setToolJSX: (jsx: React.ReactElement) => void  // Required in extended version
}
```

## 1.3 Key Type Extensions

### Problem Analysis
The Key type from Ink doesn't have all properties that the code expects.

### Fix Location: Create `src/types/ink-augmentation.d.ts`
```typescript
// Type augmentation for ink
declare module 'ink' {
  interface Key {
    fn?: boolean
    home?: boolean
    end?: boolean
    space?: boolean
  }
}
```

### Alternative: Create wrapper type
```typescript
// In src/types/input.ts
import { Key as InkKey } from 'ink'

export interface ExtendedKey extends InkKey {
  fn?: boolean
  home?: boolean
  end?: boolean
  space?: boolean
}

// Then update all usages from Key to ExtendedKey
```

## Verification Steps

After each fix:
1. Run `npx tsc --noEmit` to check error count
2. Verify no runtime errors with `bun run dev`
3. Test affected functionality

## Expected Outcome

After Phase 1 completion:
- Message type errors in query.ts resolved
- Tool interface matches all implementations
- Key type has all required properties
- Error count reduced by approximately 40-50 errors

## Commands to Run

```bash
# After each file change
npx tsc --noEmit 2>&1 | grep -c "error TS"

# Check specific file errors
npx tsc --noEmit 2>&1 | grep "src/query.ts"
npx tsc --noEmit 2>&1 | grep "src/messages.ts"
npx tsc --noEmit 2>&1 | grep "Tool.ts"

# Test runtime
bun run dev
```
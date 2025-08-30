# TypeScript Error Fix Plan - 100% Confidence Strategy

## Overview
Fix all 127 TypeScript compilation errors systematically, starting from core type definitions to implementation details.

## Phase 1: Core Type System Foundation (Critical - Block Everything)

### 1.1 Message Type System Fix
- [ ] Fix Message type union in `src/messages.ts` - Add missing 'message' property to ProgressMessage or remove from usage
- [ ] Add required properties (costUSD, durationMs, uuid) to message type factories in `src/utils/messageContextManager.ts`
- [ ] Fix query.ts message property access patterns (lines 203-210)
- [ ] Validate all Message type consumers after changes

### 1.2 Tool Interface Alignment
- [ ] Update Tool base interface in `src/Tool.ts` to match actual implementations
- [ ] Fix renderResultForAssistant return type to allow string | array
- [ ] Fix renderToolUseRejectedMessage signature to be consistent (0 args vs 2 args)
- [ ] Add optional setToolJSX to ToolUseContext interface
- [ ] Update ExtendedToolUseContext type definition

### 1.3 Key Type Extensions
- [ ] Add missing properties to Key type: `fn`, `home`, `end`, `space`
- [ ] Update ink types or create proper type augmentation file
- [ ] Verify all keyboard event handlers after Key type update

## Phase 2: Tool System Implementation (High Priority)

### 2.1 Fix Tool Implementations
- [ ] Fix ArchitectTool - Align call() and renderResultForAssistant signatures
- [ ] Fix FileReadTool - Handle string | array return type, add sharp dependency
- [ ] Fix FileWriteTool - Fix renderToolUseRejectedMessage signature
- [ ] Fix FileEditTool - Fix renderToolUseRejectedMessage signature
- [ ] Fix MultiEditTool - Fix applyEdit parameters and return properties
- [ ] Fix TaskTool - Align AsyncGenerator types with Tool interface
- [ ] Fix StickerRequestTool - Handle optional setToolJSX property
- [ ] Fix NotebookReadTool - Type assertion for unknown to string conversion
- [ ] Fix AskExpertModelTool - Fix debugLogger call signatures

### 2.2 Tool Prompt System
- [ ] Update all tool prompt.ts files to match new signatures
- [ ] Ensure async description functions are properly typed

## Phase 3: React 19 / Ink 6 Component Updates (Medium Priority)

### 3.1 Component Props Fix
- [ ] Fix agents.tsx - Remove 'key' from component props, pass as JSX attribute
- [ ] Fix AssistantToolUseMessage - Add required children prop
- [ ] Fix REPL.tsx - Add children to PermissionProvider and TodoProvider
- [ ] Fix all Text components missing children prop

### 3.2 Import Path Corrections
- [ ] Remove .tsx extensions from imports in Doctor.tsx
- [ ] Verify all import paths follow TypeScript conventions

## Phase 4: Service Layer Fixes (Medium Priority)

### 4.1 OpenAI Service Type Safety
- [ ] Add proper error type guards in openai.ts (lines 611, 743)
- [ ] Type API responses properly (lines 1291-1299)
- [ ] Create response type interfaces for OpenAI API

### 4.2 Config Service Overloads
- [ ] Fix getConfig overload in cli.tsx line 543
- [ ] Ensure boolean parameter properly narrows to true/false

## Phase 5: Hook System Updates (Low Priority)

### 5.1 Input Hook Fixes
- [ ] Remove unused @ts-expect-error in useDoublePress.ts
- [ ] Remove unused @ts-expect-error in useTextInput.ts
- [ ] Fix Key type usage in useTextInput.ts
- [ ] Fix Key type usage in useUnifiedCompletion.ts

### 5.2 Message Hook Updates
- [ ] Fix useUnifiedCompletion optional vs required properties
- [ ] Update messages.tsx type assertions

## Phase 6: Utility Functions (Low Priority)

### 6.1 Type Utilities
- [ ] Fix generators.ts void | Awaited<A> issue
- [ ] Fix thinking.ts enum value 'minimal'
- [ ] Clean up type assertions

### 6.2 Clean-up Tasks
- [ ] Remove all unused @ts-expect-error directives
- [ ] Fix entrypoints parameter counts
- [ ] Add isCustomCommand to proper type definition

## Phase 7: Dependency Management

### 7.1 Missing Dependencies
- [ ] Add sharp package for image processing
- [ ] Verify all package.json dependencies are installed
- [ ] Update @types packages if needed

## Phase 8: Validation & Testing

### 8.1 Compilation Verification
- [ ] Run `npx tsc --noEmit` after each phase
- [ ] Document remaining errors if any
- [ ] Ensure zero TypeScript errors

### 8.2 Runtime Testing
- [ ] Test basic CLI functionality
- [ ] Test each tool individually
- [ ] Test React components render correctly
- [ ] Verify no runtime regressions

## Execution Order & Time Estimates

1. **Phase 1**: 2 hours - Must complete first, blocks everything
2. **Phase 2**: 3 hours - Can parallelize tool fixes
3. **Phase 3**: 1 hour - Independent, can do in parallel with Phase 4
4. **Phase 4**: 1 hour - Independent service fixes
5. **Phase 5**: 30 minutes - Quick fixes
6. **Phase 6**: 30 minutes - Simple clean-up
7. **Phase 7**: 15 minutes - Package installation
8. **Phase 8**: 1 hour - Final validation

**Total Estimated Time**: 9 hours 15 minutes

## Success Criteria
- [ ] Zero TypeScript compilation errors
- [ ] All tools functioning correctly
- [ ] React components rendering without warnings
- [ ] No runtime regressions
- [ ] Clean git diff with minimal changes

## Risk Mitigation
- Create backup branch before starting
- Test each phase independently
- Use `git add -p` for selective staging
- Document any breaking changes
- Keep fixes minimal and focused
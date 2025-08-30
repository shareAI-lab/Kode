# Step 2 - Worker 2: Service 层修复

## 前置条件
**必须先完成 step_0_foundation_serial.md 的所有任务**

## 项目背景
Service 层处理与外部 API 的通信，包括 OpenAI、Claude 等模型服务。主要问题是对 unknown 类型的不安全访问。

## 系统架构上下文
```
src/services/
├── openai.ts              - OpenAI API 集成
├── claude.ts              - Claude API 集成
├── modelAdapterFactory.ts - 模型适配器工厂
└── mcpClient.ts          - MCP 客户端
src/entrypoints/
├── cli.tsx               - CLI 入口
└── mcp.ts                - MCP 入口
```

## 任务目标
1. 修复 openai.ts 中的类型安全问题
2. 修复 entrypoints 中的函数调用问题
3. 添加适当的错误处理和类型守卫

## 详细施工步骤

### Phase 1: 修复 OpenAI Service (30分钟)

#### Step 1.1: 添加响应类型定义
**文件**: `src/services/openai.ts`
**在文件顶部添加类型定义**:
```typescript
// OpenAI API 响应类型
interface OpenAIErrorResponse {
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  data?: OpenAIModel[];
  models?: OpenAIModel[]; // 某些 API 兼容服务使用此字段
  object?: string;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

#### Step 1.2: 修复错误处理 (第 611, 743 行)
**文件**: `src/services/openai.ts`
**定位**: 第 611, 743 行

**修复错误访问**:
```typescript
// 原始代码
if (error.error && error.message) {
  // 处理错误
}

// 修复为 - 添加类型守卫
function isOpenAIError(error: unknown): error is OpenAIErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as any).error === 'object'
  );
}

// 使用类型守卫
try {
  // API 调用
} catch (error) {
  if (isOpenAIError(error) && error.error) {
    const errorMessage = error.error.message || 'Unknown error';
    console.error('OpenAI API error:', errorMessage);
    throw new Error(errorMessage);
  } else if (error instanceof Error) {
    throw error;
  } else {
    throw new Error('Unknown error occurred');
  }
}
```

#### Step 1.3: 修复模型列表处理 (第 1291-1299 行)
**文件**: `src/services/openai.ts`
**定位**: 第 1291-1299 行

**修复数据访问**:
```typescript
// 原始代码
if (response.data || response.models) {
  const models = response.data || response.models;
}

// 修复为 - 添加类型安全
async function fetchModels(): Promise<OpenAIModel[]> {
  try {
    const response = await fetch('/v1/models');
    const data: unknown = await response.json();
    
    // 类型验证
    if (!isModelsResponse(data)) {
      throw new Error('Invalid models response');
    }
    
    // 安全访问
    const models = data.data || data.models || [];
    return models;
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return [];
  }
}

// 类型守卫
function isModelsResponse(data: unknown): data is OpenAIModelsResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    (Array.isArray((data as any).data) || Array.isArray((data as any).models))
  );
}
```

#### Step 1.4: 创建通用 API 调用包装器
**添加安全的 API 调用函数**:
```typescript
class OpenAIService {
  private async safeApiCall<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    try {
      const response = await fetch(endpoint, options);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (isOpenAIError(errorData)) {
          throw new Error(errorData.error?.message || 'API request failed');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data as T;
    } catch (error) {
      // 统一错误处理
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Unknown error in API call');
    }
  }
  
  async listModels(): Promise<OpenAIModel[]> {
    const response = await this.safeApiCall<OpenAIModelsResponse>('/v1/models');
    return response.data || response.models || [];
  }
  
  async createChatCompletion(params: any): Promise<OpenAIChatResponse> {
    return this.safeApiCall<OpenAIChatResponse>('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
}
```

### Phase 2: 修复 CLI 入口点 (20分钟)

#### Step 2.1: 修复 cli.tsx
**文件**: `src/entrypoints/cli.tsx`

**第 318 行 - 移除未使用的 @ts-expect-error**:
```typescript
// 删除这一行
// @ts-expect-error
```

**第 543 行 - 修复 getConfig 重载**:
```typescript
// 原始代码
const config = getConfig(isGlobal);

// 修复方案 1 - 明确类型
const config = isGlobal ? getConfig(true) : getConfig(false);

// 修复方案 2 - 类型断言
const config = getConfig(isGlobal as true);

// 修复方案 3 - 修改函数签名（如果可以）
function getConfig(global?: boolean): Config {
  // 统一处理
}
```

**第 1042 行 - 修复无类型函数调用**:
```typescript
// 原始代码
someFunction<Type>(args);

// 如果函数不是泛型，移除类型参数
someFunction(args);

// 或者确保函数是泛型
const someFunction = <T,>(arg: T): T => {
  return arg;
};
```

### Phase 3: 修复 MCP 入口点 (15分钟)

#### Step 3.1: 修复 mcp.ts
**文件**: `src/entrypoints/mcp.ts`

**第 70 行 - 修复参数数量**:
```typescript
// 查找函数定义，确认期望的参数数量
// 如果函数不期望参数
someFunction();

// 如果参数是可选的
someFunction(undefined);
```

**第 130 行 - 修复参数数量**:
```typescript
// 原始：3 个参数，期望 2 个
someFunction(arg1, arg2, arg3);

// 修复方案 1 - 移除多余参数
someFunction(arg1, arg2);

// 修复方案 2 - 合并参数
someFunction(arg1, { arg2, arg3 });

// 修复方案 3 - 检查函数签名是否正确
// 可能函数签名已更改，需要更新调用
```

### Phase 4: 创建类型安全的服务层 (15分钟)

#### Step 4.1: 创建服务基类
**创建文件**: `src/services/base.ts`
```typescript
// 基础服务类，提供通用功能
export abstract class BaseService {
  protected apiKey?: string;
  protected baseUrl: string;
  
  constructor(config: { apiKey?: string; baseUrl: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }
  
  protected async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      ...options?.headers,
      ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
    };
    
    try {
      const response = await fetch(url, { ...options, headers });
      
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      return await response.json();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }
  
  protected async handleErrorResponse(response: Response): Promise<never> {
    const error = await response.json().catch(() => ({
      message: `HTTP ${response.status}`
    }));
    throw new Error(error.message || 'Request failed');
  }
  
  protected handleError(error: unknown): void {
    console.error('Service error:', error);
  }
}
```

#### Step 4.2: 更新服务使用基类
```typescript
// 在 openai.ts 中
import { BaseService } from './base';

export class OpenAIService extends BaseService {
  constructor(apiKey?: string) {
    super({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    });
  }
  
  async listModels(): Promise<OpenAIModel[]> {
    const response = await this.request<OpenAIModelsResponse>('/v1/models');
    return response.data || [];
  }
}
```

### Phase 5: 验证和测试 (20分钟)

#### Step 5.1: 检查服务层错误
```bash
# OpenAI service
npx tsc --noEmit 2>&1 | grep "openai.ts"

# CLI entrypoint
npx tsc --noEmit 2>&1 | grep "cli.tsx"

# MCP entrypoint
npx tsc --noEmit 2>&1 | grep "mcp.ts"

# 所有服务
npx tsc --noEmit 2>&1 | grep "src/services/"
```

#### Step 5.2: 测试 API 调用
```bash
# 启动 CLI
bun run dev

# 如果配置了 OpenAI
export OPENAI_API_KEY="your-key"

# 测试模型列表（如果有此功能）
/models

# 测试基本功能
/help
```

#### Step 5.3: 创建测试脚本
**创建文件**: `test-services.ts`
```typescript
import { OpenAIService } from './src/services/openai';

async function testServices() {
  console.log('Testing services...');
  
  // 测试 OpenAI
  try {
    const openai = new OpenAIService(process.env.OPENAI_API_KEY);
    const models = await openai.listModels();
    console.log('OpenAI models:', models.length);
  } catch (error) {
    console.error('OpenAI test failed:', error);
  }
  
  console.log('Tests complete');
}

testServices();
```

## 完成标志
- [ ] OpenAI service 类型安全
- [ ] 所有 unknown 类型正确处理
- [ ] CLI 入口点无错误
- [ ] MCP 入口点无错误
- [ ] API 调用有错误处理
- [ ] TypeScript 错误减少至少 12 个

## 注意事项
1. **保护 API 密钥** - 不要记录敏感信息
2. **处理网络错误** - 考虑超时和重试
3. **向后兼容** - 保持现有 API 接口
4. **性能考虑** - 避免不必要的 API 调用

## 调试技巧

### API 响应调试
```typescript
const debugResponse = async (response: Response) => {
  const text = await response.text();
  console.log('Response:', {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text.substring(0, 500),
  });
  return JSON.parse(text);
};
```

### 类型检查
```typescript
// 运行时类型检查
console.log('Type of response:', typeof response);
console.log('Response keys:', Object.keys(response || {}));
```

### 网络请求监控
```typescript
const fetchWithLogging = async (url: string, options?: RequestInit) => {
  console.log(`[FETCH] ${options?.method || 'GET'} ${url}`);
  const start = Date.now();
  try {
    const response = await fetch(url, options);
    console.log(`[FETCH] ${response.status} in ${Date.now() - start}ms`);
    return response;
  } catch (error) {
    console.error(`[FETCH] Error after ${Date.now() - start}ms:`, error);
    throw error;
  }
};
```

## 常见问题

### Q: 如何处理不同的 API 响应格式？
```typescript
// 使用联合类型
type APIResponse = OpenAIResponse | AnthropicResponse | CustomResponse;

// 使用类型守卫区分
function isOpenAIResponse(r: APIResponse): r is OpenAIResponse {
  return 'choices' in r;
}
```

### Q: 如何处理 API 版本差异？
```typescript
class VersionedAPI {
  private version: string;
  
  constructor(version: string = 'v1') {
    this.version = version;
  }
  
  getEndpoint(path: string): string {
    return `/${this.version}${path}`;
  }
}
```

### Q: 重试逻辑？
```typescript
async function retryableRequest<T>(
  fn: () => Promise<T>,
  retries: number = 3
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error('Max retries exceeded');
}
```

## 完成后
Service 层修复完成后，API 通信应该类型安全且稳定。这是系统可靠性的关键部分。
[![MSeeP.ai Security Assessment Badge](https://mseep.net/pr/shareai-lab-kode-badge.png)](https://mseep.ai/app/shareai-lab-kode)

# Kode - AI Assistant for Your Terminal

[![npm version](https://badge.fury.io/js/@shareai-lab%2Fkode.svg)](https://www.npmjs.com/package/@shareai-lab/kode)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

[中文文档](README.zh-CN.md) | [Contributing](CONTRIBUTING.md) | [Documentation](docs/)

Kode is a powerful AI assistant that lives in your terminal. It can understand your codebase, edit files, run commands, and handle entire workflows for you.

## Features

- 🤖 **AI-Powered Assistance** - Uses advanced AI models to understand and respond to your requests
- 🔄 **Multi-Model Collaboration** - Flexibly switch and combine multiple AI models to leverage their unique strengths
- 📝 **Code Editing** - Directly edit files with intelligent suggestions and improvements
- 🔍 **Codebase Understanding** - Analyzes your project structure and code relationships
- 🚀 **Command Execution** - Run shell commands and see results in real-time
- 🛠️ **Workflow Automation** - Handle complex development tasks with simple prompts
- 🎨 **Interactive UI** - Beautiful terminal interface with syntax highlighting
- 🔌 **Tool System** - Extensible architecture with specialized tools for different tasks
- 💾 **Context Management** - Smart context handling to maintain conversation continuity

## Installation

```bash
npm install -g @shareai-lab/kode
```

After installation, you can use any of these commands:
- `kode` - Primary command
- `kwa` - Kode With Agent (alternative)
- `kd` - Ultra-short alias

## Usage

### Interactive Mode
Start an interactive session:
```bash
kode
# or
kwa
# or
kd
```

### Non-Interactive Mode
Get a quick response:
```bash
kode -p "explain this function" main.js
# or
kwa -p "explain this function" main.js
```

### Docker Usage


#### Alternative: Build from local source

```bash
# Clone the repository
git clone  https://github.com/shareAI-lab/Kode.git
cd Kode

# Build the image locally
docker build --no-cache -t Kode .

# Run in your project directory
cd your-project
docker run -it --rm \
  -v $(pwd):/workspace \
  -v ~/.kode:/root/.kode \
  -v ~/.kode.json:/root/.kode.json \
  -w /workspace \
  Kode
```

#### Docker Configuration Details

The Docker setup includes:

- **Volume Mounts**:
  - `$(pwd):/workspace` - Mounts your current project directory
  - `~/.kode:/root/.kode` - Preserves your kode configuration directory between runs
  - `~/.kode.json:/root/.kode.json` - Preserves your kode global configuration file between runs

- **Working Directory**: Set to `/workspace` inside the container

- **Interactive Mode**: Uses `-it` flags for interactive terminal access

- **Cleanup**: `--rm` flag removes the container after exit

**Note**:  Kode uses both `~/.kode` directory for additional data (like memory files) and `~/.kode.json` file for global configuration.

The first time you run the Docker command, it will build the image. Subsequent runs will use the cached image for faster startup.

You can use the onboarding to set up the model, or `/model`.
If you don't see the models you want on the list, you can manually set them in `/config`
As long as you have an openai-like endpoint, it should work.


### Commands

- `/help` - Show available commands
- `/model` - Change AI model settings
- `/config` - Open configuration panel
- `/cost` - Show token usage and costs
- `/clear` - Clear conversation history
- `/init` - Initialize project context

## Multi-Model Intelligent Collaboration

Unlike official Claude which supports only a single model, Kode implements **true multi-model collaboration**, allowing you to fully leverage the unique strengths of different AI models.

### 🏗️ Core Technical Architecture

#### 1. **ModelManager Multi-Model Manager**
We designed a unified `ModelManager` system that supports:
- **Model Profiles**: Each model has an independent configuration file containing API endpoints, authentication, context window size, cost parameters, etc.
- **Model Pointers**: Users can configure default models for different purposes in the `/model` command:
  - `main`: Default model for main Agent
  - `task`: Default model for SubAgent
  - `reasoning`: Reserved for future ThinkTool usage
  - `quick`: Fast model for simple NLP tasks (security identification, title generation, etc.)
- **Dynamic Model Switching**: Support runtime model switching without restarting sessions, maintaining context continuity

#### 2. **TaskTool Intelligent Task Distribution**
Our specially designed `TaskTool` (Architect tool) implements:
- **Subagent Mechanism**: Can launch multiple sub-agents to process tasks in parallel
- **Model Parameter Passing**: Users can specify which model SubAgents should use in their requests
- **Default Model Configuration**: SubAgents use the model configured by the `task` pointer by default

#### 3. **AskExpertModel Expert Consultation Tool**
We specially designed the `AskExpertModel` tool:
- **Expert Model Invocation**: Allows temporarily calling specific expert models to solve difficult problems during conversations
- **Model Isolation Execution**: Expert model responses are processed independently without affecting the main conversation flow
- **Knowledge Integration**: Integrates expert model insights into the current task

#### 🎯 Flexible Model Switching
- **Tab Key Quick Switch**: Press Tab in the input box to quickly switch the model for the current conversation
- **`/model` Command**: Use `/model` command to configure and manage multiple model profiles, set default models for different purposes
- **User Control**: Users can specify specific models for task processing at any time

#### 🔄 Intelligent Work Allocation Strategy

**Architecture Design Phase**
- Use **o3 model** or **GPT-5 model** to explore system architecture and formulate sharp and clear technical solutions
- These models excel in abstract thinking and system design

**Solution Refinement Phase**
- Use **gemini model** to deeply explore production environment design details
- Leverage its deep accumulation in practical engineering and balanced reasoning capabilities

**Code Implementation Phase**
- Use **Qwen Coder model**, **Kimi k2 model**, **GLM-4.5 model**, or **Claude Sonnet 4 model** for specific code writing
- These models have strong performance in code generation, file editing, and engineering implementation
- Support parallel processing of multiple coding tasks through subagents

**Problem Solving**
- When encountering complex problems, consult expert models like **o3 model**, **Claude Opus 4.1 model**, or **Grok 4 model**
- Obtain deep technical insights and innovative solutions

#### 💡 Practical Application Scenarios

```bash
# Example 1: Architecture Design
"Use o3 model to help me design a high-concurrency message queue system architecture"

# Example 2: Multi-Model Collaboration
"First use GPT-5 model to analyze the root cause of this performance issue, then use Claude Sonnet 4 model to write optimization code"

# Example 3: Parallel Task Processing
"Use Qwen Coder model as subagent to refactor these three modules simultaneously"

# Example 4: Expert Consultation
"This memory leak issue is tricky, ask Claude Opus 4.1 model separately for solutions"

# Example 5: Code Review
"Have Kimi k2 model review the code quality of this PR"

# Example 6: Complex Reasoning
"Use Grok 4 model to help me derive the time complexity of this algorithm"

# Example 7: Solution Design
"Have GLM-4.5 model design a microservice decomposition plan"
```

### 🛠️ Key Implementation Mechanisms

#### **Configuration System**
```typescript
// Example of multi-model configuration support
{
  "modelProfiles": {
    "o3": { "provider": "openai", "model": "o3", "apiKey": "..." },
    "claude4": { "provider": "anthropic", "model": "claude-sonnet-4", "apiKey": "..." },
    "qwen": { "provider": "alibaba", "model": "qwen-coder", "apiKey": "..." }
  },
  "modelPointers": {
    "main": "claude4",      // Main conversation model
    "task": "qwen",         // Task execution model
    "reasoning": "o3",      // Reasoning model
    "quick": "glm-4.5"      // Quick response model
  }
}
```

#### **Cost Tracking System**
- **Usage Statistics**: Use `/cost` command to view token usage and costs for each model
- **Multi-Model Cost Comparison**: Track usage costs of different models in real-time
- **History Records**: Save cost data for each session

#### **Context Manager**
- **Context Inheritance**: Maintain conversation continuity when switching models
- **Context Window Adaptation**: Automatically adjust based on different models' context window sizes
- **Session State Preservation**: Ensure information consistency during multi-model collaboration

### 🚀 Advantages of Multi-Model Collaboration

1. **Maximized Efficiency**: Each task is handled by the most suitable model
2. **Cost Optimization**: Use lightweight models for simple tasks, powerful models for complex tasks
3. **Parallel Processing**: Multiple models can work on different subtasks simultaneously
4. **Flexible Switching**: Switch models based on task requirements without restarting sessions
5. **Leveraging Strengths**: Combine advantages of different models for optimal overall results

### 📊 Comparison with Official Implementation

| Feature | Kode | Official Claude |
|---------|------|-----------------|
| Number of Supported Models | Unlimited, configurable for any model | Only supports single Claude model |
| Model Switching | ✅ Tab key quick switch | ❌ Requires session restart |
| Parallel Processing | ✅ Multiple SubAgents work in parallel | ❌ Single-threaded processing |
| Cost Tracking | ✅ Separate statistics for multiple models | ❌ Single model cost |
| Task Model Configuration | ✅ Different default models for different purposes | ❌ Same model for all tasks |
| Expert Consultation | ✅ AskExpertModel tool | ❌ Not supported |

This multi-model collaboration capability makes Kode a true **AI Development Workbench**, not just a single AI assistant.

## Development

Kode is built with modern tools and requires [Bun](https://bun.sh) for development.

### Install Bun

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### Setup Development Environment

```bash
# Clone the repository
git clone https://github.com/shareAI-lab/kode.git
cd kode

# Install dependencies
bun install

# Run in development mode
bun run dev
```

### Build

```bash
bun run build
```

### Testing

```bash
# Run tests
bun test

# Test the CLI
./cli.js --help
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

ISC License - see [LICENSE](LICENSE) for details.

## Support

- 📚 [Documentation](docs/)
- 🐛 [Report Issues](https://github.com/shareAI-lab/kode/issues)
- 💬 [Discussions](https://github.com/shareAI-lab/kode/discussions)
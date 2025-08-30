import { Message } from '../query'
import type { UUID } from '../types/common'
import { countTokens } from './tokens'
import crypto from 'crypto'

export interface MessageRetentionStrategy {
  type:
    | 'preserve_recent'
    | 'preserve_important'
    | 'smart_compression'
    | 'auto_compact'
  maxTokens: number
  preserveCount?: number
  importanceThreshold?: number
}

export interface MessageTruncationResult {
  truncatedMessages: Message[]
  removedCount: number
  preservedTokens: number
  strategy: string
  summary?: string
}

/**
 * Smart message truncation for context-limited models
 * Implements multiple strategies for preserving important conversation content
 */
export class MessageContextManager {
  /**
   * Truncate messages intelligently based on strategy and token limit
   */
  async truncateMessages(
    messages: Message[],
    strategy: MessageRetentionStrategy,
  ): Promise<MessageTruncationResult> {
    switch (strategy.type) {
      case 'preserve_recent':
        return this.preserveRecentMessages(messages, strategy)
      case 'preserve_important':
        return this.preserveImportantMessages(messages, strategy)
      case 'smart_compression':
        return this.smartCompressionStrategy(messages, strategy)
      case 'auto_compact':
        return this.autoCompactStrategy(messages, strategy)
      default:
        return this.preserveRecentMessages(messages, strategy)
    }
  }

  /**
   * Strategy 1: Preserve most recent messages
   */
  private preserveRecentMessages(
    messages: Message[],
    strategy: MessageRetentionStrategy,
  ): MessageTruncationResult {
    const preserveCount =
      strategy.preserveCount || this.estimateMessageCount(strategy.maxTokens)
    const truncatedMessages = messages.slice(-preserveCount)
    const removedCount = messages.length - truncatedMessages.length

    return {
      truncatedMessages,
      removedCount,
      preservedTokens: countTokens(truncatedMessages),
      strategy: `Preserved last ${preserveCount} messages`,
      summary:
        removedCount > 0
          ? `Removed ${removedCount} older messages to fit context window`
          : 'No messages removed',
    }
  }

  /**
   * Strategy 2: Preserve important messages (errors, user queries, recent context)
   */
  private preserveImportantMessages(
    messages: Message[],
    strategy: MessageRetentionStrategy,
  ): MessageTruncationResult {
    const importantMessages: Message[] = []
    const recentMessages: Message[] = []

    // Always preserve the last few messages for context continuity
    const recentCount = Math.min(5, messages.length)
    recentMessages.push(...messages.slice(-recentCount))

    // Identify important messages (errors, tool failures, user decisions)
    for (let i = 0; i < messages.length - recentCount; i++) {
      const message = messages[i]
      if (this.isImportantMessage(message)) {
        importantMessages.push(message)
      }
    }

    // Combine and deduplicate
    const combinedMessages = [
      ...importantMessages,
      ...recentMessages.filter(
        msg => !importantMessages.some(imp => this.messagesEqual(imp, msg)),
      ),
    ]

    // Sort by original order
    const truncatedMessages = combinedMessages.sort((a, b) => {
      const aIndex = messages.indexOf(a)
      const bIndex = messages.indexOf(b)
      return aIndex - bIndex
    })

    const removedCount = messages.length - truncatedMessages.length

    return {
      truncatedMessages,
      removedCount,
      preservedTokens: countTokens(truncatedMessages),
      strategy: `Preserved ${importantMessages.length} important + ${recentMessages.length} recent messages`,
      summary: `Kept critical errors, user decisions, and recent context (${removedCount} messages archived)`,
    }
  }

  /**
   * Strategy 3: Smart compression with summary
   */
  private async smartCompressionStrategy(
    messages: Message[],
    strategy: MessageRetentionStrategy,
  ): Promise<MessageTruncationResult> {
    const recentCount = Math.min(10, Math.floor(messages.length * 0.3))
    const recentMessages = messages.slice(-recentCount)
    const olderMessages = messages.slice(0, -recentCount)

    // Create a summary of older messages
    const summary = this.createMessagesSummary(olderMessages)

    // Create a summary message
    const summaryMessage: Message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `[CONVERSATION SUMMARY - ${olderMessages.length} messages compressed]\n\n${summary}\n\n[END SUMMARY - Recent context follows...]`,
          },
        ],
      },
      costUSD: 0,
      durationMs: 0,
      uuid: crypto.randomUUID() as UUID
    }

    const truncatedMessages = [summaryMessage, ...recentMessages]

    return {
      truncatedMessages,
      removedCount: olderMessages.length,
      preservedTokens: countTokens(truncatedMessages),
      strategy: `Compressed ${olderMessages.length} messages + preserved ${recentCount} recent`,
      summary: `Created intelligent summary of conversation history`,
    }
  }

  /**
   * Strategy 4: Use existing auto-compact mechanism
   */
  private async autoCompactStrategy(
    messages: Message[],
    strategy: MessageRetentionStrategy,
  ): Promise<MessageTruncationResult> {
    // This would integrate with the existing autoCompactCore.ts
    // For now, fallback to preserve_recent
    return this.preserveRecentMessages(messages, strategy)
  }

  /**
   * Helper: Estimate how many messages fit in token budget
   */
  private estimateMessageCount(maxTokens: number): number {
    const avgTokensPerMessage = 150 // Conservative estimate
    return Math.max(3, Math.floor(maxTokens / avgTokensPerMessage))
  }

  /**
   * Helper: Determine if a message is important
   */
  private isImportantMessage(message: Message): boolean {
    if (message.type === 'user') return true // User messages are always important

    if (message.type === 'assistant') {
      const content = message.message.content
      if (Array.isArray(content)) {
        const textContent = content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join(' ')
          .toLowerCase()

        // Mark as important if contains error keywords
        return (
          textContent.includes('error') ||
          textContent.includes('failed') ||
          textContent.includes('warning') ||
          textContent.includes('critical') ||
          textContent.includes('issue')
        )
      }
    }

    return false
  }

  /**
   * Helper: Check if two messages are equal
   */
  private messagesEqual(a: Message, b: Message): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  /**
   * Helper: Create summary of message sequence
   */
  private createMessagesSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.type === 'user').length
    const assistantMessages = messages.filter(
      m => m.type === 'assistant',
    ).length
    const toolUses = messages.filter(
      m =>
        m.type === 'assistant' &&
        Array.isArray(m.message.content) &&
        m.message.content.some(c => c.type === 'tool_use'),
    ).length

    const topics: string[] = []

    // Extract key topics from user messages
    messages.forEach(msg => {
      if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        const text = msg.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join(' ')

        // Simple keyword extraction (could be enhanced with NLP)
        if (text.includes('error') || text.includes('bug'))
          topics.push('debugging')
        if (text.includes('implement') || text.includes('create'))
          topics.push('implementation')
        if (text.includes('explain') || text.includes('understand'))
          topics.push('explanation')
        if (text.includes('fix') || text.includes('solve'))
          topics.push('problem-solving')
      }
    })

    const uniqueTopics = [...new Set(topics)]

    return `Previous conversation included ${userMessages} user messages and ${assistantMessages} assistant responses, with ${toolUses} tool invocations. Key topics: ${uniqueTopics.join(', ') || 'general discussion'}.`
  }
}

/**
 * Factory function to create appropriate retention strategy
 */
export function createRetentionStrategy(
  targetContextLength: number,
  currentTokens: number,
  userPreference: 'aggressive' | 'balanced' | 'conservative' = 'balanced',
): MessageRetentionStrategy {
  const maxTokens = Math.floor(targetContextLength * 0.7) // Leave room for new conversation

  switch (userPreference) {
    case 'aggressive':
      return {
        type: 'preserve_recent',
        maxTokens,
        preserveCount: Math.max(3, Math.floor(maxTokens / 200)),
      }
    case 'conservative':
      return {
        type: 'smart_compression',
        maxTokens,
      }
    case 'balanced':
    default:
      return {
        type: 'preserve_important',
        maxTokens,
        preserveCount: Math.max(5, Math.floor(maxTokens / 150)),
      }
  }
}

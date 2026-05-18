// Provider Type Definitions

import type { Config, ChatMessage, ChatOptions, ToolConfig } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';

export type ContextManagementConfig = NonNullable<ToolConfig['contextManagement']>;

export interface ToolChatResult {
  response: string;
  toolCalls: string[];
  usage?: UsageDetails;
  cost?: CostDetails;
}

export interface ProviderChatParams {
  messages: ChatMessage[];
  options: ChatOptions;
  config: Config;
}

export interface ProviderToolChatParams extends ProviderChatParams {
  toolConfig: ToolConfig;
  toolContext?: ExecuteToolContext;
}

export interface UsageDetails {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: number;
}

export interface CostDetails {
  input: number;
  output: number;
  total: number;
}

export interface Provider {
  readonly name: string;
  isAvailable(): boolean;
  chat(params: ProviderChatParams): Promise<string>;
  chatWithTools(params: ProviderToolChatParams): Promise<ToolChatResult>;
}

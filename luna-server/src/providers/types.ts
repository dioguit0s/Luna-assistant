export type ConversationRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationRole;
  text: string;
  timestamp: number;
}

export interface CompletedTurn {
  userText?: string;
  assistantText?: string;
}

export interface ProviderSessionConfig {
  roomId: string;
  systemPrompt: string;
  history: ConversationTurn[];
}

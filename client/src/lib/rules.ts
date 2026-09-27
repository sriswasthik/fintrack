import { api } from '@/lib/api';
import type { Category } from '@/lib/transactions';

/** A rule the engine learned from one of this user's corrections. */
export interface LearnedRule {
  id: string;
  pattern: string;
  /** The merchant the rule stands for, or null for a pattern of another shape. */
  merchant: string | null;
  category: Category;
  learnedFromOverride: boolean;
  /** How many of the user's transactions are from that merchant. */
  transactionCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchRules(): Promise<LearnedRule[]> {
  const { data } = await api.get<{ rules: LearnedRule[] }>('/api/rules');
  return data.rules;
}

export async function updateRule(input: {
  id: string;
  category: Category;
}): Promise<{ recategorized: number }> {
  const { data } = await api.patch<{ recategorized: number }>(`/api/rules/${input.id}`, {
    category: input.category,
  });
  return data;
}

export async function deleteRule(id: string): Promise<{ recategorized: number }> {
  const { data } = await api.delete<{ recategorized: number }>(`/api/rules/${id}`);
  return data;
}

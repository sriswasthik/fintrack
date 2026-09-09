/**
 * Monthly summary endpoints.
 *
 * GET reads the cached paragraph and only calls the model when there is none;
 * POST /regenerate always calls it. That split is deliberate — a summary costs
 * a model call, and a page that regenerated on every visit would spend one
 * every time someone clicked back to it.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { AnthropicMonthlySummarizer, type MonthlySummarizer } from '../services/ai/summarize';
import { toIsoMonth } from '../services/dashboard/window';
import { getMonthlySummary, regenerateMonthlySummary } from '../services/summary/apply';
import { scopeToUser } from './user-scope';

const summaryQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
  /** Used only to work out whose month this is; summaries span a user's accounts. */
  accountId: z.string().min(1).optional(),
});

let summarizer: MonthlySummarizer | undefined;

/**
 * Lazily built, like the Prisma client, so importing this module never fails
 * in an environment with no API key — only actually generating does.
 */
function getSummarizer(): MonthlySummarizer {
  summarizer ??= new AnthropicMonthlySummarizer();
  return summarizer;
}

async function resolve(req: Parameters<RequestHandler>[0]) {
  const query = summaryQuerySchema.parse(req.query);
  const month = query.month ?? toIsoMonth(new Date());

  const prisma = getPrisma();
  const userId = await scopeToUser(prisma, req, query.accountId);

  return { prisma, userId, month };
}

export const getSummary: RequestHandler = async (req, res) => {
  const { prisma, userId, month } = await resolve(req);
  res.json(await getMonthlySummary(prisma, getSummarizer(), { userId, month }));
};

export const postRegenerateSummary: RequestHandler = async (req, res) => {
  const { prisma, userId, month } = await resolve(req);
  res.json(await regenerateMonthlySummary(prisma, getSummarizer(), { userId, month }));
};

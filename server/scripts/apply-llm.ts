/**
 * Runs the LLM fallback over everything the rule engine left unresolved, for
 * the demo user.
 *
 * Makes real Anthropic API calls for merchants that are not already in the
 * cache, so it costs money on the first run and nothing on repeats.
 *
 *   ANTHROPIC_API_KEY=... npm run llm:apply --workspace server
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { AnthropicMerchantCategorizer } from '../src/services/ai/categorize';
import { applyLlmCategorization } from '../src/services/ai/apply';

const prisma = createPrismaClient();

async function main() {
  const email = process.env.SEED_USER_EMAIL ?? 'demo@fintrack.local';
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user with email ${email} — run \`npm run db:seed\` first`);

  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const categorizer = new AnthropicMerchantCategorizer({
    onUsage: (u) => {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.requests += 1;
    },
  });

  const summary = await applyLlmCategorization(prisma, { userId: user.id, categorizer });

  console.log(`Unresolved to start   ${summary.unresolved}`);
  console.log(`Distinct merchants    ${summary.distinctMerchants}`);
  console.log(`  answered from cache ${summary.fromCache}`);
  console.log(`  sent to the model   ${summary.sentToModel}`);
  console.log(`Categorized           ${summary.categorized}`);
  console.log(`  low confidence      ${summary.lowConfidence}`);
  console.log(`Rejected answers      ${summary.rejected}`);
  console.log(`Still unresolved      ${summary.stillUnresolved}`);
  console.log(
    `\nModel calls ${usage.requests}, ${usage.inputTokens} in / ${usage.outputTokens} out`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    if (error instanceof Error && /authentication method/i.test(error.message)) {
      console.error('No Anthropic credentials found. Set ANTHROPIC_API_KEY in server/.env.');
    } else {
      console.error(error);
    }
    await prisma.$disconnect();
    process.exit(1);
  });

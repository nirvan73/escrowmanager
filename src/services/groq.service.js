// src/services/groq.service.js
// Tool-calling agent that replaces the hardcoded switch/case in aqa.service.js
// The LLM decides which tool to call — you just define the tools and run them

import Groq from 'groq-sdk';
import prisma from '../lib/prisma.js';
import stripeService from './stripe.service.js';
import pfiService from './pfi.service.js';
import geminiService from './gemini.service.js'; // fallback

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Tool definitions
// This is a "menu" you hand to the LLM. It reads the descriptions and
// decides which tool to call and with what arguments.
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'score_submission',
      description: `Evaluate a freelancer's submitted work against the milestone checklist.
                    Give a score from 0-100 and decide if full payout, partial, or refund is appropriate.
                    Call this FIRST before any payment tool.`,
      parameters: {
        type: 'object',
        properties: {
          score: {
            type: 'number',
            description: 'Score from 0 to 100. How well did the freelancer satisfy the checklist?',
          },
          decision: {
            type: 'string',
            enum: ['FULL_PAYOUT', 'PARTIAL_PAYOUT', 'REFUND'],
            description: 'FULL_PAYOUT if score>=85, PARTIAL_PAYOUT if 50-84, REFUND if below 50',
          },
          feedback: {
            type: 'string',
            description: '2-4 sentences of specific, actionable feedback for the freelancer',
          },
          checklist_evaluation: {
            type: 'array',
            description: 'Assessment of each checklist item',
            items: {
              type: 'object',
              properties: {
                item:    { type: 'string'  },
                met:     { type: 'boolean' },
                comment: { type: 'string'  },
              },
              required: ['item', 'met', 'comment'],
            },
          },
          summary: {
            type: 'string',
            description: 'One sentence summary for the employer',
          },
        },
        required: ['score', 'decision', 'feedback', 'checklist_evaluation', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'process_payment',
      description: `Trigger the Stripe payout or refund based on the AQA decision.
                    Call this AFTER score_submission. Use the same decision value you scored.`,
      parameters: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            enum: ['FULL_PAYOUT', 'PARTIAL_PAYOUT', 'REFUND'],
            description: 'Must match the decision from score_submission',
          },
        },
        required: ['decision'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reputation',
      description: `Recalculate the Professional Fidelity Index (PFI) for the freelancer.
                    Call this LAST after payment is processed.`,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason for the update, e.g. "milestone approved with score 82"',
          },
        },
        required: ['reason'],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Tool runner
// LLM tells us WHAT to call and WITH WHAT ARGS.
// This function actually EXECUTES it using your existing services.
// ─────────────────────────────────────────────────────────────────────────────
const runTool = async (toolName, args, ctx) => {
  // ctx = { submission, milestone, escrowAccount } — injected before agent loop

  switch (toolName) {

    case 'score_submission': {
      console.log(`[Agent] Scoring submission — score: ${args.score}, decision: ${args.decision}`);

      // Save AQA result to DB — same fields your aqa.service.js already uses
      await prisma.submission.update({
        where: { id: ctx.submission.id },
        data: {
          aqaScore:       args.score,
          aqaDecision:    args.decision,
          aqaFeedback:    args.feedback,
          aqaRawResponse: JSON.stringify(args),
          status:         'EVALUATED',
        },
      });

      // Store score in context so process_payment can use it
      ctx.aqaScore    = args.score;
      ctx.aqaDecision = args.decision;

      return {
        success:  true,
        score:    args.score,
        decision: args.decision,
        message:  'Submission scored and saved to database',
      };
    }

    case 'process_payment': {
      console.log(`[Agent] Processing payment — action: ${args.decision}`);

      const { milestone, escrowAccount } = ctx;
      let milestoneStatus;

      switch (args.decision) {
        case 'FULL_PAYOUT':
          await stripeService.releaseMilestonePayout({
            escrowAccountId: escrowAccount.id,
            milestoneId:     milestone.id,
            freelancerId:    milestone.freelancerId,
            amount:          milestone.amount,
            description:     `Full payout for milestone: ${milestone.title}`,
          });
          milestoneStatus = 'APPROVED';
          break;

        case 'PARTIAL_PAYOUT':
          await stripeService.releasePartialPayout({
            escrowAccountId: escrowAccount.id,
            milestoneId:     milestone.id,
            freelancerId:    milestone.freelancerId,
            fullAmount:      milestone.amount,
            score:           ctx.aqaScore,
          });
          milestoneStatus = 'PARTIAL';
          break;

        case 'REFUND':
          await stripeService.triggerRefund({
            escrowAccountId: escrowAccount.id,
            milestoneId:     milestone.id,
            amount:          milestone.amount,
            reason:          `Refund — failed AQA for milestone: ${milestone.title}`,
          });
          milestoneStatus = 'FAILED';
          break;
      }

      // Update milestone status — same as your existing switch/case
      await prisma.milestone.update({
        where: { id: milestone.id },
        data:  { status: milestoneStatus },
      });

      return {
        success:         true,
        action:          args.decision,
        milestoneStatus: milestoneStatus,
        message:         `Payment processed: ${args.decision}`,
      };
    }

    case 'update_reputation': {
      console.log(`[Agent] Updating PFI for freelancer: ${ctx.milestone.freelancerId}`);

      const pfi = await pfiService.calculateAndUpdatePFI(ctx.milestone.freelancerId);

      return {
        success:      true,
        newPfiScore:  pfi?.overallScore ?? 0,
        message:      'PFI score recalculated',
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — The agent loop
// Keeps running until LLM stops calling tools (returns plain text = done)
// ─────────────────────────────────────────────────────────────────────────────
const processSubmission = async (submissionId) => {

  // Load everything the agent needs
  const submission = await prisma.submission.findUnique({
    where:   { id: submissionId },
    include: {
      milestone: {
        include: { project: true, freelancer: true },
      },
    },
  });

  if (!submission) throw new Error('Submission not found');

  const { milestone } = submission;

  const escrowAccount = await prisma.escrowAccount.findUnique({
    where: { projectId: milestone.projectId },
  });

  // Context passed to every tool call — avoids re-fetching from DB
  const ctx = { submission, milestone, escrowAccount };

  // Build the checklist as readable text for the LLM
  const checklistText = milestone.checklist
    .map((item, i) => `${i + 1}. ${item}`)
    .join('\n');

  // Conversation history — grows as the agent calls tools
  const messages = [
    {
      role: 'system',
      content: `You are an autonomous escrow agent for a freelance platform called BitByBit.
Your job is to fairly evaluate freelancer submissions and process payments automatically.

You MUST call tools in this exact order:
1. score_submission — evaluate the work against the checklist
2. process_payment  — trigger Stripe based on your score
3. update_reputation — recalculate the freelancer's PFI score

Be objective and strict. Base your score only on how many checklist items are concretely satisfied.
Do not be generous. Partial work = partial score.`,
    },
    {
      role: 'user',
      content: `Process this milestone submission:

MILESTONE TITLE: ${milestone.title}
MILESTONE DESCRIPTION: ${milestone.description}

ACCEPTANCE CHECKLIST:
${checklistText}

FREELANCER SUBMISSION:
${submission.workDescription.substring(0, 800)}
${submission.repoUrl ? `REPO: ${submission.repoUrl}` : ''}

Milestone payout amount: $${milestone.amount}
Freelancer ID: ${milestone.freelancerId}

Evaluate the work, process the payment, and update the reputation score.`,
    },
  ];

  let maxIterations = 10; // safety guard — prevent infinite loops

  while (maxIterations-- > 0) {
    const response = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      messages,
      tools:       TOOLS,
      tool_choice: 'auto',
      temperature: 0.1, // low = deterministic, consistent decisions
    });

    const agentMessage = response.choices[0].message;
    messages.push(agentMessage); // always add to history

    // No tool calls = agent decided it's done — return final summary
    if (!agentMessage.tool_calls || agentMessage.tool_calls.length === 0) {
      console.log('[Agent] Done:', agentMessage.content);
      return {
        success: true,
        summary: agentMessage.content,
        submission: await prisma.submission.findUnique({ where: { id: submissionId } }),
      };
    }

    // Execute each tool the LLM requested
    for (const toolCall of agentMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const args     = JSON.parse(toolCall.function.arguments);

      console.log(`[Agent] Calling tool: ${toolName}`);

      let toolResult;
      try {
        toolResult = await runTool(toolName, args, ctx);
      } catch (toolError) {
        console.error(`[Agent] Tool ${toolName} failed:`, toolError.message);
        toolResult = { success: false, error: toolError.message };
      }

      // Feed the result back to the LLM — it uses this to decide next step
      messages.push({
        role:         'tool',
        tool_call_id: toolCall.id, // must match exactly
        content:      JSON.stringify(toolResult),
      });
    }
  }

  throw new Error('Agent loop exceeded maximum iterations');
};

export default { processSubmission };
import groqAgent from './groq.service.js';
import geminiService from './gemini.service.js'; // kept as fallback
import prisma from '../lib/prisma.js';
import stripeService from './stripe.service.js';
import pfiService from './pfi.service.js';

const processSubmission = async (submissionId) => {
  try {
    // PRIMARY PATH — tool-calling agent handles everything:
    // score_submission → process_payment → update_reputation
    return await groqAgent.processSubmission(submissionId);

  } catch (agentError) {
    // FALLBACK PATH — if agent fails, run old linear flow with real Groq call
    console.error('[AQA] Agent failed, running fallback:', agentError.message);

    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { milestone: { include: { project: true, freelancer: true } } },
    });

    if (!submission) throw new Error('Submission not found');
    const { milestone } = submission;

    const evaluation = await geminiService.evaluateSubmission({
      milestoneTitle:       milestone.title,
      milestoneDescription: milestone.description,
      checklist:            milestone.checklist,
      workDescription:      submission.workDescription,
      repoUrl:              submission.repoUrl,
    });

    const updatedSubmission = await prisma.submission.update({
      where: { id: submissionId },
      data: {
        aqaScore:       evaluation.score,
        aqaDecision:    evaluation.decision,
        aqaFeedback:    evaluation.feedback,
        aqaRawResponse: JSON.stringify(evaluation),
        status:         'EVALUATED',
      },
    });

    const escrowAccount = await prisma.escrowAccount.findUnique({
      where: { projectId: milestone.projectId },
    });

    let milestoneUpdateData = {};
    switch (evaluation.decision) {
      case 'FULL_PAYOUT':
        await stripeService.releaseMilestonePayout({
          escrowAccountId: escrowAccount.id,
          milestoneId:     milestone.id,
          freelancerId:    milestone.freelancerId,
          amount:          milestone.amount,
          description:     `Full payout for milestone: ${milestone.title}`,
        });
        milestoneUpdateData = { status: 'APPROVED' };
        break;
      case 'PARTIAL_PAYOUT':
        await stripeService.releasePartialPayout({
          escrowAccountId: escrowAccount.id,
          milestoneId:     milestone.id,
          freelancerId:    milestone.freelancerId,
          fullAmount:      milestone.amount,
          score:           evaluation.score,
        });
        milestoneUpdateData = { status: 'PARTIAL' };
        break;
      case 'REFUND':
        await stripeService.triggerRefund({
          escrowAccountId: escrowAccount.id,
          milestoneId:     milestone.id,
          amount:          milestone.amount,
          reason:          `Refund — failed AQA for: ${milestone.title}`,
        });
        milestoneUpdateData = { status: 'FAILED' };
        break;
      default:
        throw new Error(`Invalid AQA decision: ${evaluation.decision}`);
    }

    await prisma.milestone.update({ where: { id: milestone.id }, data: milestoneUpdateData });
    await pfiService.calculateAndUpdatePFI(milestone.freelancerId);

    return { evaluation, submission: updatedSubmission };
  }
};

export default {
  processSubmission,
};
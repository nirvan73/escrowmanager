import Stripe from 'stripe';
import prisma from '../lib/prisma.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const createEscrowPaymentIntent = async ({ projectId }) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    });

    if (!project) throw new Error("Project not found in database.");

    const totalCharge = project.budget * 1.02;
    const amountInSmallestUnit = Math.round(totalCharge * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInSmallestUnit,
      currency: 'inr', 
      metadata: { projectId }
    });

    return {
      clientSecret: paymentIntent.client_secret, 
      paymentIntentId: paymentIntent.id,
    };
  } catch (error) {
    console.error("Stripe API Error:", error);
    throw new Error(error.message); 
  }
};

const confirmEscrowFunded = async ({ projectId, paymentIntentId }) => {
  try {
    const updatedEscrow = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) throw new Error("Project not found");

      const escrow = await tx.escrowAccount.upsert({
        where: { projectId },
        update: {
          status: 'FUNDED',
          stripePaymentIntentId: paymentIntentId,
          heldAmount: project.budget,
          totalAmount: project.budget // <-- ADDED THIS
        },
        create: {
          projectId,
          status: 'FUNDED',
          stripePaymentIntentId: paymentIntentId,
          heldAmount: project.budget,
          totalAmount: project.budget // <-- THE FIX THAT SATISFIES PRISMA
        }
      });

      await tx.transaction.create({
        data: {
          escrowAccountId: escrow.id,
          userId: project.employerId, // <-- THE PRISMA FIX: Tell the DB who made the transaction!
          type: 'ESCROW_FUND',
          amount: project.budget,
          description: `Funds secured via Stripe Intent ${paymentIntentId}`,
        },
      });

      await tx.project.update({
        where: { id: projectId },
        data: { status: 'FUNDED' },
      });

      return escrow;
    });
    return updatedEscrow;
  } catch (error) {
    console.error("Database Save Error:", error);
    // THE REAL ERROR FIX: Now Android will actually see Prisma's exact complaint if it fails!
    throw new Error(error.message);
  }
};

const releaseMilestonePayout = async ({ escrowAccountId, milestoneId, freelancerId, amount, description, type = 'MILESTONE_PAYOUT' }) => {
  console.log(`Processing payout: ₹${amount} to freelancer ${freelancerId} for milestone ${milestoneId}`);
  const transaction = await prisma.$transaction(async (tx) => {
    const escrow = await tx.escrowAccount.findUnique({ where: { id: escrowAccountId } });
    if (escrow.heldAmount < amount) throw new Error("Insufficient funds in escrow.");
    await tx.escrowAccount.update({
      where: { id: escrowAccountId },
      data: {
        heldAmount: { decrement: amount },
        releasedAmount: { increment: amount },
      },
    });
    return tx.transaction.create({
      data: { escrowAccountId, milestoneId, userId: freelancerId, type, amount, description },
    });
  });
  return transaction;
};

const releasePartialPayout = async ({ escrowAccountId, milestoneId, freelancerId, fullAmount, score }) => {
  const partialAmount = Math.round((fullAmount * (score / 100)) * 100) / 100;
  const refundAmount = fullAmount - partialAmount;
  await releaseMilestonePayout({
    escrowAccountId, milestoneId, freelancerId,
    amount: partialAmount,
    description: `Partial payout based on AQA score of ${score}`,
    type: 'PARTIAL_PAYOUT',
  });
  if (refundAmount > 0) {
    await triggerRefund({
      escrowAccountId, milestoneId, amount: refundAmount,
      reason: `Partial refund from milestone based on AQA score of ${score}`,
    });
  }
  return { partialAmount, refundAmount };
};

const triggerRefund = async ({ escrowAccountId, milestoneId, amount, reason }) => {
  console.log(`Processing refund: ₹${amount} for milestone ${milestoneId}`);
  const transaction = await prisma.$transaction(async (tx) => {
    const escrow = await tx.escrowAccount.findUnique({ where: { id: escrowAccountId } });
    if (escrow.heldAmount < amount) throw new Error("Insufficient funds in escrow for refund.");
    await tx.escrowAccount.update({
      where: { id: escrowAccountId },
      data: {
        heldAmount: { decrement: amount },
        refundedAmount: { increment: amount },
      },
    });
    return tx.transaction.create({
      data: { escrowAccountId, milestoneId, type: 'REFUND_EMPLOYER', amount, description: reason },
    });
  });
  return transaction;
};

export default {
  createEscrowPaymentIntent,
  confirmEscrowFunded,
  releaseMilestonePayout,
  releasePartialPayout,
  triggerRefund
};
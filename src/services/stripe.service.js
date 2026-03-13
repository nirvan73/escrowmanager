import stripe from '../lib/stripe.js';
import prisma from '../lib/prisma.js';

// Stripe requires amounts in cents (smallest currency unit)
const toCents = (dollars) => Math.round(dollars * 100);

const createEscrowPaymentIntent = async ({ projectId, amount, employerEmail }) => {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: toCents(amount),
    currency: 'usd',
    description: `Escrow funding for project ${projectId}`,
    receipt_email: employerEmail,
    metadata: {
      projectId,
      type: 'ESCROW_FUND',
    },
    // payment_method_types defaults to ['card'] which is fine for hackathon
  });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
};

const confirmEscrowFunded = async ({ projectId, paymentIntentId }) => {
  // Verify with Stripe that payment actually succeeded
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  // In test mode, we also accept 'requires_capture' and 'succeeded'
  // For the hackathon demo, we'll also allow confirming a payment intent directly
  if (!['succeeded', 'requires_capture'].includes(paymentIntent.status)) {
    // In test mode, attempt to confirm with a test payment method
    if (process.env.NODE_ENV === 'development') {
      await stripe.paymentIntents.confirm(paymentIntentId, {
        payment_method: 'pm_card_visa', // Stripe's built-in test card
      });
    } else {
      throw new Error(`Payment not completed. Status: ${paymentIntent.status}`);
    }
  }

  const updatedEscrow = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({ where: { id: projectId } });

    const escrow = await tx.escrowAccount.update({
      where: { projectId },
      data: {
        status: 'FUNDED',
        stripePaymentIntentId: paymentIntentId,
        heldAmount: project.budget,
      },
    });

    await tx.transaction.create({
      data: {
        escrowAccountId: escrow.id,
        type: 'ESCROW_FUND',
        amount: project.budget,
        description: `Funds secured for project ${projectId} via Stripe PI: ${paymentIntentId}`,
      },
    });

    await tx.project.update({
      where: { id: projectId },
      data: { status: 'FUNDED' },
    });

    return escrow;
  });

  return updatedEscrow;
};

// NOTE: Real Stripe Connect payouts to freelancers require identity verification
// (onboarding flow). For the hackathon, payouts are tracked in your DB ledger
// and marked as PENDING_TRANSFER. You can show the payout happened in the UI.
// To go fully live post-hackathon, implement Stripe Connect Express onboarding.
const releaseMilestonePayout = async ({
  escrowAccountId,
  milestoneId,
  freelancerId,
  amount,
  description,
  type = 'MILESTONE_PAYOUT',
}) => {
  const transaction = await prisma.$transaction(async (tx) => {
    const escrow = await tx.escrowAccount.findUnique({ where: { id: escrowAccountId } });

    if (!escrow) throw new Error('Escrow account not found');
    if (escrow.heldAmount < amount) throw new Error('Insufficient funds in escrow');

    await tx.escrowAccount.update({
      where: { id: escrowAccountId },
      data: {
        heldAmount: { decrement: amount },
        releasedAmount: { increment: amount },
      },
    });

    return tx.transaction.create({
      data: {
        escrowAccountId,
        milestoneId,
        userId: freelancerId,
        type,
        amount,
        description,
        // stripeTransferId would go here once Connect is set up
      },
    });
  });

  console.log(`✅ Payout recorded: $${amount} to freelancer ${freelancerId} for milestone ${milestoneId}`);
  return transaction;
};

const releasePartialPayout = async ({
  escrowAccountId,
  milestoneId,
  freelancerId,
  fullAmount,
  score,
}) => {
  const partialAmount = Math.round(fullAmount * (score / 100) * 100) / 100;
  const refundAmount = Math.round((fullAmount - partialAmount) * 100) / 100;

  await releaseMilestonePayout({
    escrowAccountId,
    milestoneId,
    freelancerId,
    amount: partialAmount,
    description: `Partial payout (${score}/100 AQA score) for milestone ${milestoneId}`,
    type: 'PARTIAL_PAYOUT',
  });

  if (refundAmount > 0) {
    await triggerRefund({
      escrowAccountId,
      milestoneId,
      amount: refundAmount,
      reason: `Partial refund (${score}/100 AQA score) — unearned portion returned to employer`,
    });
  }

  return { partialAmount, refundAmount };
};

const triggerRefund = async ({ escrowAccountId, milestoneId, amount, reason }) => {
  // For a full refund back to the employer's card, we'd call:
  // stripe.refunds.create({ payment_intent: escrow.stripePaymentIntentId, amount: toCents(amount) })
  // This requires the original PaymentIntent ID. We record it in the ledger for now.

  const transaction = await prisma.$transaction(async (tx) => {
    const escrow = await tx.escrowAccount.findUnique({ where: { id: escrowAccountId } });

    if (!escrow) throw new Error('Escrow account not found');
    if (escrow.heldAmount < amount) throw new Error('Insufficient escrow funds for refund');

    // Attempt real Stripe refund if we have the PaymentIntent ID
    if (escrow.stripePaymentIntentId && !escrow.stripePaymentIntentId.startsWith('pi_simulated')) {
      try {
        await stripe.refunds.create({
          payment_intent: escrow.stripePaymentIntentId,
          amount: toCents(amount),
          reason: 'requested_by_customer',
          metadata: { milestoneId, reason },
        });
        console.log(`✅ Stripe refund issued: $${amount} for milestone ${milestoneId}`);
      } catch (stripeErr) {
        // Log but don't block — still update ledger
        console.error('Stripe refund error (ledger still updated):', stripeErr.message);
      }
    }

    await tx.escrowAccount.update({
      where: { id: escrowAccountId },
      data: {
        heldAmount: { decrement: amount },
        refundedAmount: { increment: amount },
      },
    });

    return tx.transaction.create({
      data: {
        escrowAccountId,
        milestoneId,
        type: 'REFUND_EMPLOYER',
        amount,
        description: reason,
      },
    });
  });

  return transaction;
};

export default {
  createEscrowPaymentIntent,
  confirmEscrowFunded,
  releaseMilestonePayout,
  releasePartialPayout,
  triggerRefund,
};
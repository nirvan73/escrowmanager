import { z } from 'zod';
import prisma from '../lib/prisma.js';
import stripeService from '../services/stripe.service.js';

const fundEscrowSchema = z.object({
  projectId: z.string().uuid(),
});

const fundEscrow = async (req, res) => {
  try {
    const { projectId } = fundEscrowSchema.parse(req.body);

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { employer: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (project.employerId !== req.user.userId) {
      return res.status(403).json({ error: 'Only the project employer can fund the escrow' });
    }

    const { clientSecret, paymentIntentId } = await stripeService.createEscrowPaymentIntent({ projectId });
    
    res.json({ clientSecret, paymentIntentId, message: "PaymentIntent created." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const confirmEscrow = async (req, res) => {
  try {
    const { projectId, paymentIntentId } = req.body;
    
    // Call the newly upgraded service function
    const result = await stripeService.confirmEscrowFunded({ projectId, paymentIntentId });
    
    // Send a 200 OK only if it actually saved
    res.status(200).json(result);
  } catch (error) {
    console.error("Confirm Escrow Crash:", error);
    // Send a 500 status code so Android knows it failed!
    res.status(500).json({ error: error.message });
  }
};

const getEscrowByProjectId = async (req, res) => {
    const { projectId } = req.params;
    const escrow = await prisma.escrowAccount.findUnique({
        where: { projectId },
        include: { transactions: { orderBy: { createdAt: 'desc' }}}
    });

    if (!escrow) {
        return res.status(404).json({ error: "Escrow account not found for this project." });
    }

    res.json(escrow);
}

export default {
  fundEscrow,
  confirmEscrow, // Only the correct function is exported now!
  getEscrowByProjectId,
};
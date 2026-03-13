import { Router } from 'express';
import escrowController from '../controllers/escrow.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/fund', authenticateToken, escrowController.fundEscrow);
router.post('/confirm', authenticateToken, escrowController.confirmEscrow);
router.get('/:projectId', authenticateToken, escrowController.getEscrowByProjectId);

export default router;

import { Router } from 'express';
import projectController from '../controllers/project.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/', authenticateToken, projectController.createProject);
router.get('/:id', authenticateToken, projectController.getProjectById);
router.get('/', authenticateToken, projectController.getUserProjects);
router.put('/:id/deadline', authenticateToken, projectController.updateDeadline);
router.put('/:id/milestones', authenticateToken, projectController.updateProjectMilestones);

export default router;

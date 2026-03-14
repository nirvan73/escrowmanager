import { z } from 'zod';
import prisma from '../lib/prisma.js';
import geminiService from '../services/gemini.service.js';

const createProjectSchema = z.object({
    title: z.string().min(5),
    description: z.string().min(20),
    budget: z.number().positive(),
    deadline: z.string().datetime(),
    freelancerEmail: z.string().email().optional(),
});

const createProject = async (req, res) => {
    try {
        if (req.user.role !== 'EMPLOYER') return res.status(403).json({ error: 'Only employers can create projects' });
        
        const projectData = createProjectSchema.parse(req.body);

        // 1. Fetch AI-Decomposed Milestones from Groq/Gemini Service
        const milestonesFromAI = await geminiService.decomposeProjectIntoMilestones(projectData);

        // 2. Identify Freelancer if an email was provided
        let freelancerId = null;
        if (projectData.freelancerEmail) {
            const freelancer = await prisma.user.findUnique({ where: { email: projectData.freelancerEmail } });
            if (freelancer?.role === 'FREELANCER') freelancerId = freelancer.id;
        }

        // 3. Prepare Milestone Data for Database insertion
        const milestoneData = milestonesFromAI.map((m) => ({
            ...m,
            submissionType: m.submissionType || 'CODE',
            // Use AI's estimatedDays to set a deadline, but we don't save the field 'estimatedDays' yet
            deadline: new Date(Date.now() + (m.estimatedDays || 7) * 86400000),
            freelancerId,
            status: freelancerId ? 'ASSIGNED' : 'PENDING',
        }));

        // 4. Atomic Transaction: Create Project, Milestones, and Escrow in one go
        const result = await prisma.$transaction(async (tx) => {
            const proj = await tx.project.create({
                data: {
                    title: projectData.title,
                    description: projectData.description,
                    budget: projectData.budget,
                    deadline: new Date(projectData.deadline),
                    employerId: req.user.userId,
                },
            });

            // FIX 1: Strip 'estimatedDays' from AI response using destructuring
            // Prisma throws an error if it sees a field that isn't in schema.prisma
            await tx.milestone.createMany({
                data: milestoneData.map((m) => {
                    const { estimatedDays, ...prismaReadyData } = m; 
                    return { 
                        ...prismaReadyData, 
                        projectId: proj.id 
                    };
                }),
            });

            // FIX 2: Explicitly provide 'heldAmount: 0' (Prisma requires Float fields)
            await tx.escrowAccount.create({
                data: { 
                    projectId: proj.id, 
                    totalAmount: projectData.budget, 
                    heldAmount: 0, 
                    status: 'UNFUNDED' 
                },
            });

            return { project: proj };
        });

        // 5. Fetch the newly created milestones to return to the Android App
        const finalMilestones = await prisma.milestone.findMany({ 
            where: { projectId: result.project.id }, 
            orderBy: { order: 'asc' } 
        });

        res.status(201).json({ project: result.project, milestones: finalMilestones });

    } catch (error) {
        console.error("Project Creation Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

const updateProjectMilestones = async (req, res) => {
    try {
        const { id: projectId } = req.params;
        const { milestones } = req.body;

        const project = await prisma.project.findUnique({ where: { id: projectId } });
        if (!project || project.employerId !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });

        await prisma.$transaction(async (tx) => {
            // Delete AI suggestions and replace with employer's approved/edited versions
            await tx.milestone.deleteMany({ where: { projectId } });
            
            await tx.milestone.createMany({
                data: milestones.map((m) => ({
                    projectId,
                    order: m.order,
                    title: m.title,
                    description: m.description,
                    submissionType: m.submissionType,
                    checklist: m.checklist,
                    amount: m.amount,
                    deadline: new Date(m.deadline),
                    status: 'PENDING'
                }))
            });

            // Recalculate and update the budget/escrow
            const finalBudget = milestones.reduce((sum, m) => sum + m.amount, 0);
            
            await tx.project.update({ 
                where: { id: projectId }, 
                data: { budget: finalBudget } 
            });

            await tx.escrowAccount.update({
                where: { projectId },
                data: { 
                    status: 'FUNDED', 
                    totalAmount: finalBudget, 
                    heldAmount: finalBudget 
                }
            });
        });

        res.json({ message: 'Milestones finalized and escrow funded.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getProjectById = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await prisma.project.findUnique({
            where: { id },
            include: {
                milestones: { 
                    orderBy: { order: 'asc' }, 
                    include: { submissions: { orderBy: { createdAt: 'desc' }, take: 1 } } 
                },
                escrowAccount: true,
                employer: { select: { id: true, name: true, email: true } },
            },
        });
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getUserProjects = async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            where: {
                OR: [
                    { employerId: req.user.userId },
                    { milestones: { some: { freelancerId: req.user.userId } } },
                ],
            },
            include: { employer: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
        });
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const updateDeadline = async (req, res) => {
    try {
        const { id } = req.params;
        const { newDeadline } = req.body;
        const updatedProject = await prisma.project.update({
            where: { id },
            data: { deadline: new Date(newDeadline) },
        });
        res.json(updatedProject);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export default { 
    createProject, 
    getProjectById, 
    getUserProjects, 
    updateDeadline, 
    updateProjectMilestones 
};
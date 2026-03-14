import prisma from '../lib/prisma.js';
import aqaService from '../services/aqa.service.js';

const submitMilestone = async (req, res) => {
    const { id: milestoneId } = req.params;
    const { workDescription, repoUrl } = req.body;

    const milestone = await prisma.milestone.findUnique({ where: { id: milestoneId } });
    if (!milestone) return res.status(404).json({ error: 'Milestone not found' });

    // Validation Logic Based on SubmissionType Tag
    if (milestone.submissionType === 'CODE') {
        if (!repoUrl || !repoUrl.includes('github.com')) {
            return res.status(400).json({ error: 'CODE tasks require a GitHub repository link.' });
        }
    } else if (milestone.submissionType === 'DEPLOYMENT') {
        if (!repoUrl || !repoUrl.startsWith('http')) {
            return res.status(400).json({ error: 'DEPLOYMENT tasks require a live URL.' });
        }
    }

    const previousSubmissions = await prisma.submission.count({ where: { milestoneId } });

    const submission = await prisma.submission.create({
        data: {
            milestoneId,
            workDescription,
            repoUrl,
            attemptNumber: previousSubmissions + 1,
        },
    });

    await prisma.milestone.update({ where: { id: milestoneId }, data: { status: 'UNDER_REVIEW' } });

    // Trigger AI Agent evaluation
    aqaService.processSubmission(submission.id).catch(err => {
        console.error("AQA Trigger Failed:", err);
    });

    res.status(202).json({ message: 'Submission received and AQA evaluation started.' });
};

const getMilestoneResult = async (req, res) => {
    const { id: milestoneId } = req.params;
    const submission = await prisma.submission.findFirst({
        where: { milestoneId },
        orderBy: { createdAt: 'desc' }
    });
    if (!submission) return res.status(404).json({ error: 'No result found.' });
    res.json(submission);
};

const getMilestoneById = async (req, res) => {
    const { id } = req.params;
    const milestone = await prisma.milestone.findUnique({
        where: { id },
        include: { submissions: true, project: true }
    });
    res.json(milestone);
};

export default { submitMilestone, getMilestoneResult, getMilestoneById };
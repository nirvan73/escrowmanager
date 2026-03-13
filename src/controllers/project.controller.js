// import { z } from 'zod';
// import prisma from '../lib/prisma.js';
// import geminiService from '../services/gemini.service.js';

// const createProjectSchema = z.object({
//   title: z.string().min(5),
//   description: z.string().min(20),
//   budget: z.number().positive(),
//   deadline: z.string().datetime(),
//   freelancerEmail: z.string().email().optional(),
// });

// const createProject = async (req, res) => {
//   try {
//     if (req.user.role !== 'EMPLOYER') {
//       return res.status(403).json({ error: 'Only employers can create projects' });
//     }

//     const projectData = createProjectSchema.parse(req.body);

//     // FIX 1: Actually call Gemini and store the result
//     const milestonesFromAI = await geminiService.decomposeProjectIntoMilestones({
//       title: projectData.title,
//       description: projectData.description,
//       budget: projectData.budget,
//       deadline: projectData.deadline,
//     });

//     // FIX 2: Look up freelancer
//     let freelancerId = null;
//     if (projectData.freelancerEmail) {
//       const freelancer = await prisma.user.findUnique({
//         where: { email: projectData.freelancerEmail },
//       });
//       if (freelancer && freelancer.role === 'FREELANCER') {
//         freelancerId = freelancer.id;
//       } else {
//         console.warn(`Freelancer with email ${projectData.freelancerEmail} not found.`);
//       }
//     }

//     const { project, milestones, escrowAccount } = await prisma.$transaction(async (tx) => {
//       // FIX 3: Remove freelancerId from project.create — it doesn't exist on Project model
//       const proj = await tx.project.create({
//         data: {
//           title: projectData.title,
//           description: projectData.description,
//           budget: projectData.budget,
//           deadline: new Date(projectData.deadline),
//           employerId: req.user.userId,
//           // NO freelancerId here — Project model doesn't have it
//         },
//       });

//       const milestoneCreations = milestonesFromAI.map((m) =>
//         tx.milestone.create({
//           data: {
//             projectId: proj.id,
//             order: m.order,
//             title: m.title,
//             description: m.description,
//             checklist: m.checklist,
//             amount: m.amount,
//             deadline: (() => { const d = new Date(); d.setDate(d.getDate() + (m.estimatedDays || 7)); return d; })(),
//             freelancerId: freelancerId,
//             status: freelancerId ? 'ASSIGNED' : 'PENDING',
//           },
//         })
//       );
//       const createdMilestones = await Promise.all(milestoneCreations);

//       const esc = await tx.escrowAccount.create({
//         data: {
//           projectId: proj.id,
//           totalAmount: projectData.budget,
//           heldAmount: 0,
//           status: 'UNFUNDED',
//         },
//       });

//       return { project: proj, milestones: createdMilestones, escrowAccount: esc };
//     });

//     res.status(201).json({ project, milestones, escrowAccount });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: error.message, stack: error.stack });
//   }
// };

// const getProjectById = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const project = await prisma.project.findUnique({
//       where: { id },
//       include: {
//         milestones: {
//           orderBy: { order: 'asc' },
//           include: {
//             submissions: {
//               orderBy: { createdAt: 'desc' },
//               take: 1,
//             },
//           },
//         },
//         escrowAccount: {
//           include: {
//             transactions: {
//               orderBy: { createdAt: 'desc' },
//             },
//           },
//         },
//         employer: {
//           select: { id: true, name: true, email: true },
//         },
//       },
//     });

//     if (!project) {
//       return res.status(404).json({ error: 'Project not found' });
//     }

//     const isEmployer = project.employerId === req.user.userId;
//     const isAssignedFreelancer = project.milestones.some(
//       (m) => m.freelancerId === req.user.userId
//     );

//     if (!isEmployer && !isAssignedFreelancer) {
//       return res.status(403).json({ error: "You don't have permission to view this project." });
//     }

//     res.json(project);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

// const getUserProjects = async (req, res) => {
//   try {
//     const projects = await prisma.project.findMany({
//       where: {
//         OR: [
//           { employerId: req.user.userId },
//           { milestones: { some: { freelancerId: req.user.userId } } },
//         ],
//       },
//       include: {
//         employer: { select: { name: true } },
//       },
//       orderBy: { createdAt: 'desc' },
//     });
//     res.json(projects);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

// export default {
//   createProject,
//   getProjectById,
//   getUserProjects,
// };
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
    if (req.user.role !== 'EMPLOYER') {
      return res.status(403).json({ error: 'Only employers can create projects' });
    }

    const projectData = createProjectSchema.parse(req.body);

    // FIX 1: Actually call Gemini and store the result
    const milestonesFromAI = await geminiService.decomposeProjectIntoMilestones({
      title: projectData.title,
      description: projectData.description,
      budget: projectData.budget,
      deadline: projectData.deadline,
    });

    // FIX 2: Look up freelancer
    let freelancerId = null;
    if (projectData.freelancerEmail) {
      const freelancer = await prisma.user.findUnique({
        where: { email: projectData.freelancerEmail },
      });
      if (freelancer && freelancer.role === 'FREELANCER') {
        freelancerId = freelancer.id;
      } else {
        console.warn(`Freelancer with email ${projectData.freelancerEmail} not found.`);
      }
    }

    // Build milestone data before the transaction — no async work inside
    const milestoneData = milestonesFromAI.map((m) => ({
      order: m.order,
      title: m.title,
      description: m.description,
      checklist: m.checklist,
      amount: m.amount,
      deadline: (() => { const d = new Date(); d.setDate(d.getDate() + (m.estimatedDays || 7)); return d; })(),
      freelancerId: freelancerId,
      status: freelancerId ? 'ASSIGNED' : 'PENDING',
    }));

    // Transaction only does fast DB writes — no external calls, no Promise.all
    const { project, escrowAccount } = await prisma.$transaction(async (tx) => {
      const proj = await tx.project.create({
        data: {
          title: projectData.title,
          description: projectData.description,
          budget: projectData.budget,
          deadline: new Date(projectData.deadline),
          employerId: req.user.userId,
        },
      });

      // createMany = single DB round trip instead of N separate calls
      await tx.milestone.createMany({
        data: milestoneData.map((m) => ({ ...m, projectId: proj.id })),
      });

      const esc = await tx.escrowAccount.create({
        data: {
          projectId: proj.id,
          totalAmount: projectData.budget,
          heldAmount: 0,
          status: 'UNFUNDED',
        },
      });

      return { project: proj, escrowAccount: esc };
    }, {
      timeout: 15000, // 15 seconds — safe for cloud DB
    });

    // Fetch milestones after transaction (createMany doesn't return records)
    const milestones = await prisma.milestone.findMany({
      where: { projectId: project.id },
      orderBy: { order: 'asc' },
    });

    res.status(201).json({ project, milestones, escrowAccount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message, stack: error.stack });
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
          include: {
            submissions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
        escrowAccount: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
        employer: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const isEmployer = project.employerId === req.user.userId;
    const isAssignedFreelancer = project.milestones.some(
      (m) => m.freelancerId === req.user.userId
    );

    if (!isEmployer && !isAssignedFreelancer) {
      return res.status(403).json({ error: "You don't have permission to view this project." });
    }

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
      include: {
        employer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export default {
  createProject,
  getProjectById,
  getUserProjects,
};

import { GoogleGenerativeAI } from '@google/generative-ai';

let model;

const getModel = () => {
  if (!model) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
  }
  return model;
};

const cleanJson = (text) => {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
};

const decomposeProjectIntoMilestones = async ({ title, description, budget, deadline }) => {
  const prompt = `
You are a senior project manager. Decompose the following freelance project into 3-5 clear, actionable milestones.

Project Title: ${title}
Description: ${description}
Total Budget: $${budget}
Deadline: ${deadline}

Return ONLY a valid JSON array. No explanation, no markdown, no preamble. Just the raw JSON array.

Each milestone object must have exactly these fields:
- order: number (1, 2, 3...)
- title: string (short milestone name)
- description: string (what needs to be done)
- checklist: array of strings (3-5 specific, verifiable acceptance criteria)
- amount: number (dollar amount for this milestone, all amounts must sum to exactly ${budget})
- estimatedDays: number (realistic days to complete)

Example format:
[
  {
    "order": 1,
    "title": "...",
    "description": "...",
    "checklist": ["...", "..."],
    "amount": 500,
    "estimatedDays": 3
  }
]
`;

  try {
    const result = await getModel().generateContent(prompt);
    const text = result.response.text();
    const milestones = cleanJson(text);

    // Validate it's an array
    if (!Array.isArray(milestones)) {
      throw new Error('Gemini did not return an array');
    }

    return milestones;
  } catch (err) {
    console.error('Gemini decomposeProject error:', err.message);
    throw new Error(`Failed to decompose project into milestones: ${err.message}`);
  }
};

const evaluateSubmission = async ({ milestoneTitle, milestoneDescription, checklist, workDescription, repoUrl }) => {
  const checklistText = checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');

  const prompt = `
You are a strict but fair technical quality assessor for a freelance platform.

Evaluate the freelancer's submitted work against the milestone requirements below.

--- MILESTONE ---
Title: ${milestoneTitle}
Description: ${milestoneDescription}

Acceptance Checklist:
${checklistText}

--- FREELANCER SUBMISSION ---
Work Description: ${workDescription}
${repoUrl ? `Repository/Link: ${repoUrl}` : ''}

--- SCORING RULES ---
- Score 0-100 based on how well the submission meets the checklist
- 80-100 = FULL_PAYOUT (most criteria clearly met)
- 40-79 = PARTIAL_PAYOUT (partial progress demonstrated)
- 0-39 = REFUND (insufficient work, criteria not met)

Return ONLY a valid JSON object. No explanation, no markdown, no preamble. Just raw JSON.

Required fields:
- score: number (0-100)
- decision: string (exactly one of: "FULL_PAYOUT", "PARTIAL_PAYOUT", "REFUND")
- feedback: string (2-3 sentences explaining the decision)
- checklistEvaluation: array of objects, one per checklist item, each with:
  - item: string (the checklist item text)
  - met: boolean
  - comment: string (brief reason)
- summary: string (one sentence verdict)
`;

  try {
    const result = await getModel().generateContent(prompt);
    const text = result.response.text();
    const evaluation = cleanJson(text);

    // Validate required fields
    const required = ['score', 'decision', 'feedback', 'checklistEvaluation', 'summary'];
    for (const field of required) {
      if (evaluation[field] === undefined) {
        throw new Error(`Missing field in Gemini response: ${field}`);
      }
    }

    const validDecisions = ['FULL_PAYOUT', 'PARTIAL_PAYOUT', 'REFUND'];
    if (!validDecisions.includes(evaluation.decision)) {
      throw new Error(`Invalid decision value: ${evaluation.decision}`);
    }

    return evaluation;
  } catch (err) {
    console.error('Gemini evaluateSubmission error:', err.message);
    throw new Error(`Failed to evaluate submission: ${err.message}`);
  }
};

export default {
  decomposeProjectIntoMilestones,
  evaluateSubmission,
};
// src/services/gemini.service.js
// Uses Groq (free, fast, unlimited) instead of Gemini
// Drop-in replacement — same exported function names, same return shapes

import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const cleanJson = (text) => {
  return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
};

// Retry with exponential backoff on rate limit
const withRetry = async (fn, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.status === 429 || err.message?.includes('rate');
      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`Rate limited. Retry ${attempt}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
};

// ─── Called by project.controller.js on project creation ─────────────────────
const decomposeProjectIntoMilestones = async ({ title, description, budget, deadline }) => {
  const safeDescription = description.substring(0, 600);

  const prompt = `Decompose this freelance project into milestones.
Title: ${title}
Description: ${safeDescription}
Total Budget: $${budget}
Deadline: ${deadline}

Return ONLY valid JSON, no markdown, no explanation:
{
  "milestones": [
    {
      "order": 1,
      "title": "string (max 60 chars)",
      "description": "2-3 sentences on what must be built",
      "checklist": ["specific verifiable criterion 1", "criterion 2"],
      "amount": 150,
      "estimatedDays": 5
    }
  ]
}
Rules: 3-5 milestones, amounts sum exactly to ${budget}, checklist items must be testable.`;

  try {
    const result = await withRetry(() =>
      groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      })
    );
    return cleanJson(result.choices[0].message.content).milestones;
  } catch (err) {
    console.error('Groq milestone decomposition failed, using fallback:', err.message);
    return [
      {
        order: 1, title: 'Project Setup',
        description: 'Set up project structure, repository, and development environment.',
        checklist: ['Repository initialized', 'Folder structure documented', 'Dependencies installed'],
        amount: Math.round(budget * 0.25), estimatedDays: 3,
      },
      {
        order: 2, title: 'Core Implementation',
        description: 'Build the main features and core functionality.',
        checklist: ['Core features implemented', 'Basic tests passing', 'Code reviewed'],
        amount: Math.round(budget * 0.50), estimatedDays: 10,
      },
      {
        order: 3, title: 'Testing & Delivery',
        description: 'End-to-end testing, bug fixing, and final delivery.',
        checklist: ['All features tested', 'Bugs fixed', 'Final build documented'],
        amount: Math.round(budget * 0.25), estimatedDays: 4,
      },
    ];
  }
};

// ─── Fallback only — primary path is the agent in groq.service.js ────────────
const evaluateSubmission = async ({ milestoneTitle, milestoneDescription, checklist, workDescription, repoUrl }) => {
  const safeWork = workDescription.substring(0, 800);
  const checklistText = checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');

  const prompt = `Evaluate this freelance milestone submission. Return ONLY valid JSON.

MILESTONE: ${milestoneTitle}
DESCRIPTION: ${milestoneDescription}
CHECKLIST:\n${checklistText}
SUBMISSION:\n${safeWork}
${repoUrl ? `REPO: ${repoUrl}` : ''}

Return:
{
  "score": 78,
  "decision": "PARTIAL_PAYOUT",
  "feedback": "2-4 sentences of actionable feedback",
  "checklistEvaluation": [{ "item": "text", "met": true, "comment": "reason" }],
  "summary": "1 sentence for employer"
}
Rules: score 85-100 = FULL_PAYOUT, 50-84 = PARTIAL_PAYOUT, 0-49 = REFUND`;

  const result = await withRetry(() =>
    groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    })
  );
  return cleanJson(result.choices[0].message.content);
};

export default { decomposeProjectIntoMilestones, evaluateSubmission };
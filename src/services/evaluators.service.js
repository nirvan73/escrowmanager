// Mock evaluators — each returns realistic evidence for the AQA grader
// Replace internals with real APIs (Greptile, Figma, etc) post-hackathon

const evaluateCode = async ({ repoUrl, checklist }) => {
  console.log(`[CodeEvaluator] Analyzing repo: ${repoUrl}`);
  
  // Extract owner/repo from GitHub URL
  const match = repoUrl?.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return { type: 'CODE', evidence: 'Invalid GitHub URL provided', verified: false };

  const [, owner, repo] = match;
  
  // Mock realistic GitHub analysis response
  return {
    type: 'CODE',
    repoUrl,
    owner,
    repo,
    fileTree: [
      'README.md',
      'package.json', 
      'src/index.js',
      'src/auth/login.js',
      'src/auth/register.js',
      'src/middleware/auth.js',
      'tests/auth.test.js'
    ],
    commitCount: Math.floor(Math.random() * 20) + 5,
    lastCommitDate: new Date(Date.now() - 86400000).toISOString(),
    languages: ['JavaScript', 'JSON'],
    readmeSummary: `Repository for ${repo}. Contains implementation matching project requirements.`,
    checklistEvidence: checklist.map(item => ({
      criterion: item,
      found: true,
      location: `src/ directory`,
      confidence: 'HIGH'
    })),
    verified: true
  };
};

const evaluateDesign = async ({ figmaUrl, checklist }) => {
  console.log(`[DesignEvaluator] Analyzing Figma: ${figmaUrl}`);
  
  return {
    type: 'DESIGN',
    figmaUrl,
    screenCount: 5,
    frameNames: ['Hero Section', 'Features Grid', 'Testimonials', 'Contact Form', 'Mobile View'],
    lastModified: new Date(Date.now() - 3600000).toISOString(),
    componentCount: 24,
    hasResponsiveFrames: true,
    checklistEvidence: checklist.map(item => ({
      criterion: item,
      found: true,
      location: 'Figma file',
      confidence: 'HIGH'
    })),
    verified: true
  };
};

const evaluateContent = async ({ content, workDescription, checklist }) => {
  console.log(`[ContentEvaluator] Analyzing submitted content`);
  
  const text = content || workDescription || '';
  const wordCount = text.split(' ').filter(w => w.length > 0).length;
  
  return {
    type: 'CONTENT',
    wordCount,
    estimatedReadTime: `${Math.ceil(wordCount / 200)} min`,
    topicsDetected: ['main topic', 'supporting arguments', 'conclusion'],
    hasStructure: text.includes('\n'),
    checklistEvidence: checklist.map(item => ({
      criterion: item,
      found: wordCount > 100,
      location: 'Submitted text',
      confidence: wordCount > 500 ? 'HIGH' : 'MEDIUM'
    })),
    verified: true
  };
};

const evaluateDeployment = async ({ liveUrl, checklist }) => {
  console.log(`[DeploymentEvaluator] Checking live URL: ${liveUrl}`);
  
  return {
    type: 'DEPLOYMENT',
    liveUrl,
    isLive: true,
    statusCode: 200,
    responseTimeMs: Math.floor(Math.random() * 400) + 100,
    hasSSL: liveUrl?.startsWith('https'),
    pageTitle: 'Project Deployment',
    routesChecked: ['/', '/about', '/contact'],
    routesLive: 3,
    checklistEvidence: checklist.map(item => ({
      criterion: item,
      found: true,
      location: liveUrl,
      confidence: 'HIGH'
    })),
    verified: true
  };
};

const getEvidenceForSubmission = async ({ submissionType, repoUrl, workDescription, checklist }) => {
  switch (submissionType) {
    case 'CODE':
      return evaluateCode({ repoUrl, checklist });
    case 'DESIGN':
      return evaluateDesign({ figmaUrl: repoUrl, checklist });
    case 'CONTENT':
      return evaluateContent({ content: workDescription, workDescription, checklist });
    case 'DEPLOYMENT':
      return evaluateDeployment({ liveUrl: repoUrl, checklist });
    default:
      return evaluateCode({ repoUrl, checklist });
  }
};

export default { getEvidenceForSubmission };

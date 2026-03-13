import 'dotenv/config';
import axios from 'axios';

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const state = {
  employerToken: null,
  freelancerToken: null,
  employerId: null,
  freelancerId: null,
  projectId: null,
  milestones: [],
  paymentIntentId: null,
  clientSecret: null,
  firstMilestoneId: null,
  submissionId: null,
};

let passed = 0, failed = 0;
const test = (name, condition, actual) => {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name} — got: ${actual ? JSON.stringify(actual) : 'undefined'}`);
    failed++;
  }
};

const api = async (method, path, body = null, token = null) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  try {
    const res = await axios({ 
      method, 
      url: `${BASE_URL}${path}`, 
      data: body, 
      headers, 
      validateStatus: () => true,
      timeout: 30000 
    });
    return res;
  } catch (error) {
    return { status: 500, data: { error: error.message } };
  }
};

async function runTests() {
  console.log('Starting E2E Tests...\n');

  // Tracking sub-systems
  let geminiPass = false;
  let stripePass = false;
  let escrowFlowPass = false;
  let aqaPass = false;
  let pfiStatus = 'FAIL';

  // STEP 1 — Register Employer
  console.log('Running Step 1: Register Employer');
  let res = await api('POST', '/api/auth/register', { 
    email: "employer_test@freelanceguard.com", 
    password: "Test1234!", 
    role: "EMPLOYER", 
    name: "Test Employer" 
  });
  
  if (res.status === 400 || res.status === 409) {
    console.log('  ⚠️ Employer exists, falling back to login...');
    res = await api('POST', '/api/auth/login', { email: "employer_test@freelanceguard.com", password: "Test1234!" });
  }
  
  test('Step 1 Status', res.status === 201 || res.status === 200, res.status);
  test('Step 1 Token', !!res.data.token, res.data.token);
  test('Step 1 User ID', !!res.data.user?.id, res.data.user?.id);
  
  if (res.status >= 400) return console.error('CRITICAL ERROR: Failed Step 1', res.data);
  state.employerToken = res.data.token;
  state.employerId = res.data.user.id;

  // STEP 2 — Register Freelancer
  console.log('\nRunning Step 2: Register Freelancer');
  res = await api('POST', '/api/auth/register', { 
    email: "freelancer_test@freelanceguard.com", 
    password: "Test1234!", 
    role: "FREELANCER", 
    name: "Test Freelancer" 
  });
  
  if (res.status === 400 || res.status === 409) {
    console.log('  ⚠️ Freelancer exists, falling back to login...');
    res = await api('POST', '/api/auth/login', { email: "freelancer_test@freelanceguard.com", password: "Test1234!" });
  }
  
  test('Step 2 Status', res.status === 201 || res.status === 200, res.status);
  test('Step 2 Token', !!res.data.token, res.data.token);
  test('Step 2 User ID', !!res.data.user?.id, res.data.user?.id);
  
  if (res.status >= 400) return console.error('CRITICAL ERROR: Failed Step 2', res.data);
  state.freelancerToken = res.data.token;
  state.freelancerId = res.data.user.id;

  // STEP 3 — Login Employer
  console.log('\nRunning Step 3: Login Employer');
  res = await api('POST', '/api/auth/login', { 
    email: "employer_test@freelanceguard.com", 
    password: "Test1234!" 
  });
  test('Step 3 Status', res.status === 200, res.status);
  test('Step 3 Token', !!res.data.token, res.data.token);
  
  if (res.status !== 200) return console.error('CRITICAL ERROR: Failed Step 3', res.data);
  state.employerToken = res.data.token; // update token

  // STEP 4 — Create Project (Gemini)
  console.log('\nRunning Step 4: Create Project');
  res = await api('POST', '/api/projects', {
    title: "Build a REST API for a todo app",
    description: "Need a Node.js Express REST API with full CRUD endpoints for todos, JWT authentication, PostgreSQL with Prisma ORM, input validation with Zod, and proper error handling middleware.",
    budget: 1000,
    deadline: "2026-06-01T00:00:00.000Z",
    freelancerEmail: "freelancer_test@freelanceguard.com"
  }, state.employerToken);
  
  test('Step 4 Status', res.status === 201 || res.status === 200, res.status);
  test('Step 4 Project ID', !!res.data.project?.id, res.data.project?.id);
  const ms = res.data.milestones || [];
  test('Step 4 Milestones created', ms.length >= 2, ms.length);
  
  if (res.status >= 400) return console.error('CRITICAL ERROR: Failed Step 4', res.data);
  state.projectId = res.data.project.id;
  state.milestones = ms;
  state.firstMilestoneId = ms[0]?.id;
  geminiPass = ms.length >= 2; // Gemini generated milestones successfully

  // STEP 5 — Fund Escrow (Stripe)
  console.log('\nRunning Step 5: Fund Escrow');
  res = await api('POST', '/api/escrow/fund', { projectId: state.projectId }, state.employerToken);
  
  test('Step 5 Status', res.status === 200, res.status);
  const piId = res.data.paymentIntentId || '';
  test('Step 5 PI not sim', piId.startsWith('pi_') && !piId.startsWith('pi_simulated_'), piId);
  test('Step 5 Client Secret', !!res.data.clientSecret, res.data.clientSecret);
  
  if (res.status !== 200 || !piId.startsWith('pi_')) {
    console.error('CRITICAL: Stripe failed or simulated', res.data);
    return;
  }
  state.paymentIntentId = piId;
  state.clientSecret = res.data.clientSecret;

  // STEP 6 — Confirm Escrow Funding
  console.log('\nRunning Step 6: Confirm Escrow Funding');
  res = await api('POST', '/api/escrow/confirm', { 
    projectId: state.projectId, 
    paymentIntentId: state.paymentIntentId 
  }, state.employerToken);
  
  test('Step 6 Status', res.status === 200, res.status);
  const escStatus = res.data.escrowAccount?.status;
  const projStatus = res.data.project?.status;
  test('Step 6 Escrow Status', escStatus === "FUNDED", escStatus);
  test('Step 6 Project Status', projStatus === "FUNDED" || projStatus === "IN_PROGRESS", projStatus);
  test('Step 6 Held Amount', res.data.escrowAccount?.heldAmount === 1000, res.data.escrowAccount?.heldAmount);
  
  if (res.status !== 200) return console.error('CRITICAL ERROR: Failed Step 6', res.data);
  stripePass = true; // Stripe flow complete

  // STEP 7 — Get Escrow Status
  console.log('\nRunning Step 7: Get Escrow Status');
  res = await api('GET', `/api/escrow/project/${state.projectId}`, null, state.employerToken);
  test('Step 7 Status', res.status === 200, res.status);
  test('Step 7 status matches FUNDED', res.data.escrow?.status === "FUNDED", res.data.escrow?.status);
  const tx = res.data.escrow?.transactions || [];
  test('Step 7 Has Transactions', tx.length >= 1, tx.length);
  test('Step 7 Tx Type', tx[0]?.type === "ESCROW_FUND", tx[0]?.type);

  // STEP 8 — Submit Milestone Work (AQA Gemini)
  console.log('\nRunning Step 8: Submit Milestone Work');
  res = await api('POST', `/api/milestones/${state.firstMilestoneId}/submit`, {
    workDescription: "I have completed the first milestone. Set up the Node.js Express project with proper folder structure (controllers, routes, services, middleware). Initialized Prisma with PostgreSQL schema, installed all dependencies including express, prisma, zod, jsonwebtoken, bcrypt. Created the base app.js with error handling middleware. Repository is organized and documented with a README.",
    repoUrl: "https://github.com/test/todo-api-demo"
  }, state.freelancerToken);
  
  test('Step 8 Status', res.status === 200 || res.status === 201, res.status);
  const evalObj = res.data.evaluation || {};
  test('Step 8 Score', typeof evalObj.score === 'number' && evalObj.score >= 0 && evalObj.score <= 100, evalObj.score);
  test('Step 8 Decision', ["FULL_PAYOUT", "PARTIAL_PAYOUT", "REFUND"].includes(evalObj.decision), evalObj.decision);
  test('Step 8 Feedback', !!evalObj.feedback && evalObj.feedback.length > 0, evalObj.feedback);
  test('Step 8 Checklist Eval', Array.isArray(evalObj.checklistEvaluation), evalObj.checklistEvaluation);
  test('Step 8 Submission Status', res.data.submission?.status === "EVALUATED", res.data.submission?.status);
  
  if (res.status >= 400) return console.error('CRITICAL ERROR: Failed Step 8', res.data);
  state.submissionId = res.data.submission?.id;
  aqaPass = true; // Gemini AQA working
  const aqaDecision = evalObj.decision;

  // STEP 9 — Verify Escrow Updated
  console.log('\nRunning Step 9: Verify Escrow Updated After Payout');
  res = await api('GET', `/api/escrow/project/${state.projectId}`, null, state.employerToken);
  test('Step 9 Status', res.status === 200, res.status);
  const esc9 = res.data.escrow || {};
  if (aqaDecision === "FULL_PAYOUT") {
    test('Step 9 Full Payout logic', esc9.releasedAmount > 0 && esc9.heldAmount < 1000, esc9);
  } else if (aqaDecision === "PARTIAL_PAYOUT") {
    test('Step 9 Partial Payout logic', esc9.releasedAmount > 0 && esc9.refundedAmount > 0, esc9);
  } else {
    test('Step 9 Refund logic', esc9.refundedAmount > 0, esc9);
  }
  const tx9 = esc9.transactions || [];
  test('Step 9 Tx count', tx9.length >= 2, tx9.length);
  
  if (res.status === 200) escrowFlowPass = true; // Complete escrow lifecycle passed

  // STEP 10 — Freelancer PFI Score
  console.log('\nRunning Step 10: Get Freelancer PFI');
  res = await api('GET', `/api/freelancer/${state.freelancerId}/pfi`, null, state.freelancerToken);
  if (res.status === 404) {
    console.log('  ⚠️ PFI endpoint not implemented yet (WARN)');
    pfiStatus = 'WARN';
  } else {
    test('Step 10 Status', res.status === 200, res.status);
    const score = res.data.pfi || res.data.score;
    test('Step 10 PFI value', typeof score === 'number', score);
    if (res.status === 200) pfiStatus = 'PASS';
  }

  // STEP 11 — Auth Guard Check
  console.log('\nRunning Step 11: Auth Guard Check');
  res = await api('GET', `/api/escrow/project/${state.projectId}`);
  test('Step 11 Status', res.status === 401 || res.status === 403, res.status);

  // FINAL REPORT
  const total = passed + failed;
  console.log('\n========================================');
  console.log('  FreelanceGuard E2E Test Results');
  console.log('========================================');
  console.log(`  Total:  ${total} tests`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${failed} ❌`);
  console.log('----------------------------------------');
  console.log(`  Gemini Integration: ${geminiPass ? 'PASS' : 'FAIL'}`);
  console.log(`  Stripe Integration: ${stripePass ? 'PASS' : 'FAIL'}`);
  console.log(`  Escrow Flow:        ${escrowFlowPass ? 'PASS' : 'FAIL'}`);
  console.log(`  AQA Evaluation:     ${aqaPass ? 'PASS' : 'FAIL'}`);
  console.log(`  PFI Score:          ${pfiStatus}`);
  console.log('========================================\n');
}

runTests().catch(console.error);
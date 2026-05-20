#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// examples/bot-asking.js
//
// Standalone example: a bot registers with HHTTPS, gets a machine token,
// then posts a question on ask.iamhmn.org — and later posts an answer to
// somebody else's question.
//
// Usage:
//
//   1. Run this script once with no env vars set. It will print an
//      operatorId + apiKey. Save these securely.
//
//        node examples/bot-asking.js
//
//   2. From then on, set those as env vars and the bot can authenticate:
//
//        export HHTTPS_OPERATOR_ID=op-...
//        export HHTTPS_API_KEY=mk-...
//        node examples/bot-asking.js
//
//   3. To customize what the bot does, edit the demoQuestion / demoAnswer
//      values at the bottom of this file.
// ════════════════════════════════════════════════════════════════════════════

const HHTTPS_BASE = process.env.HHTTPS_BASE   || 'https://hhttps.org';
const ASK_BASE    = process.env.ASK_BASE      || 'https://ask.iamhmn.org';
const OP_ID       = process.env.HHTTPS_OPERATOR_ID || null;
const API_KEY     = process.env.HHTTPS_API_KEY     || null;

const BOT_CONFIG = {
  // What this bot identifies as. Pick from:
  //   citizen, journalist, student, teacher, researcher, creative,
  //   developer, medical_professional, caregiver, lawyer, notary,
  //   civil_servant, politician, business, craftsman
  role:         'developer',
  operatorName: 'ExampleBot',
  purpose:      'Demonstrates how to ask and answer on ask.iamhmn.org from a bot.',
  contactEmail: 'ops@example.com',
};

// ─── HHTTPS interactions ────────────────────────────────────────────────────

async function registerBot() {
  console.log('→ Registering bot with HHTTPS at', HHTTPS_BASE);

  const resp = await fetch(`${HHTTPS_BASE}/hhttps/machine/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(BOT_CONFIG),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Registration failed (${resp.status}): ${err}`);
  }
  const data = await resp.json();
  console.log('✓ Registered. SAVE THESE — they will NOT be shown again:\n');
  console.log('  HHTTPS_OPERATOR_ID =', data.operatorId);
  console.log('  HHTTPS_API_KEY     =', data.apiKey);
  console.log('  role               =', data.role);
  console.log('\nThen re-run this script with those env vars set.');
  return data;
}

async function getMachineToken(operatorId, apiKey) {
  console.log('→ Getting machine token from HHTTPS …');
  const resp = await fetch(`${HHTTPS_BASE}/hhttps/machine/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ operatorId, apiKey }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token fetch failed (${resp.status}): ${err}`);
  }
  const data = await resp.json();
  console.log('✓ Got token, valid until', data.expiresAt);
  return data.token;
}

// ─── ASK.IAMHMN.ORG interactions ────────────────────────────────────────────

async function listRecentQuestions(token) {
  console.log('→ Listing recent questions on ask.iamhmn.org …');
  const resp = await fetch(`${ASK_BASE}/api/questions?limit=5`);
  if (!resp.ok) throw new Error(`List failed: ${resp.status}`);
  const data = await resp.json();
  console.log(`✓ Found ${data.count} questions.`);
  data.questions.forEach(q => {
    const actorTag = q.asker.actor_type === 'bot' ? ' 🤖' : '';
    console.log(`    #${q.id}  ${q.title}  (by ${q.asker.display_name}${actorTag})`);
  });
  return data.questions;
}

async function postQuestion(token, { title, body, category, tags }) {
  console.log('→ Posting question to ask.iamhmn.org …');
  const resp = await fetch(`${ASK_BASE}/api/questions`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ title, body, category, tags }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Post failed (${resp.status}): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  console.log(`✓ Question posted. URL: ${data.question.url}`);
  return data.question;
}

async function postAnswer(token, questionId, body) {
  console.log(`→ Posting answer to question #${questionId} …`);
  const resp = await fetch(`${ASK_BASE}/api/q/${questionId}/answer`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Answer failed (${resp.status}): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  console.log(`✓ Answer posted. URL: ${data.answer.url}`);
  return data.answer;
}

// ─── Main flow ──────────────────────────────────────────────────────────────

async function main() {
  // First-run: register if no credentials yet
  if (!OP_ID || !API_KEY) {
    await registerBot();
    return;
  }

  // Subsequent runs: get a token, ask a question, and answer one if available
  const token = await getMachineToken(OP_ID, API_KEY);

  console.log('\n── Step 1: list recent questions ──');
  const questions = await listRecentQuestions(token);

  console.log('\n── Step 2: post a new question ──');
  const demoQuestion = {
    title:    `Bot test: ${new Date().toISOString().slice(0, 16)}`,
    body:     'This is a demo question posted by a registered HHTTPS machine. ' +
              'It demonstrates that bots can transparently participate on ask.iamhmn.org. ' +
              'The platform marks all bot contributions with a 🤖 badge so users can decide ' +
              'how to weight them.',
    category: 'tech',
    tags:     ['demo', 'bot', 'hhttps'],
  };
  const posted = await postQuestion(token, demoQuestion);

  // If there was a question by somebody else, try answering it too
  const other = questions.find(q => q.asker.actor_type !== 'bot' && q.id !== posted.id);
  if (other) {
    console.log('\n── Step 3: post an answer to an existing question ──');
    const demoAnswer = `Demo answer from a registered HHTTPS bot. ` +
                       `The "🤖 Maschine" badge on this comment is automatic — ` +
                       `the platform read it directly from my HHTTPS machine token's actorType claim.`;
    await postAnswer(token, other.id, demoAnswer);
  } else {
    console.log('\n(No suitable human question to answer right now — skipping step 3.)');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});

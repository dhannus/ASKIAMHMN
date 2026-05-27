// ════════════════════════════════════════════════════════════════════════════
// ask.iamhmn.org — Q&A Platform Backend
//
// Demo plattform for HHTTPS OAuth integration. Implements the OIDC
// authorization-code flow with PKCE against hhttps.org as the OAuth provider.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import express        from 'express';
import session        from 'express-session';
import cookieParser   from 'cookie-parser';
import helmet         from 'helmet';
import rateLimit      from 'express-rate-limit';
import pg             from 'pg';
import crypto         from 'crypto';
import jwt            from 'jsonwebtoken';
import jwksClient     from 'jwks-rsa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT || '3001');
const BASE_URL      = process.env.BASE_URL      || 'https://ask.iamhmn.org';
const HHTTPS_BASE   = process.env.HHTTPS_BASE   || 'https://hhttps.org';
const CLIENT_ID     = process.env.HHTTPS_CLIENT_ID     || 'ask-iamhmn';
const CLIENT_SECRET = process.env.HHTTPS_CLIENT_SECRET || '';   // empty = public client + PKCE
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ─── DB ─────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'askhuman',
  user:     process.env.DB_USER     || 'askhuman',
  password: process.env.DB_PASSWORD || ''
});
async function q(sql, params) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

// ─── App setup ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.set('json spaces', 2);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", HHTTPS_BASE]
    }
  }
}));
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));
app.use(cookieParser());
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000  // 7 days
  }
}));
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// ─── Auth helpers ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.accepts('html')) return res.redirect('/login?from=' + encodeURIComponent(req.originalUrl));
    return res.status(401).json({ error: 'login required' });
  }
  next();
}

async function getUser(id) {
  const { rows } = await q(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function upsertUser(claims) {
  const id = claims.sub;
  const displayName = generateDisplayName(claims.role, id);
  await q(
    `INSERT INTO users (id, actor_type, role, role_label, role_icon, trust_score,
                        verification_method, verification_label, display_name)
     VALUES ($1, 'human', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
     SET role = EXCLUDED.role,
         role_label = EXCLUDED.role_label,
         role_icon  = EXCLUDED.role_icon,
         trust_score = EXCLUDED.trust_score,
         verification_method = EXCLUDED.verification_method,
         verification_label  = EXCLUDED.verification_label,
         last_seen_at = NOW()`,
    [id, claims.role || 'citizen', claims.role_label || 'Citizen',
     claims.role_icon || '🧑', claims.trust_score || 30,
     claims.verification_method || 'self-declared',
     claims.verification_method_label || 'Self-declared',
     displayName]
  );
  return await getUser(id);
}

/**
 * Upsert a bot user from a verified HHTTPS machine token's claims.
 *
 * Bot user IDs are derived from the operatorId so the same bot maps to the
 * same row across token refreshes — but is still distinguishable from any
 * human user (different actor_type, different ID prefix).
 */
async function upsertBotUser(claims) {
  // Stable per-operator bot ID. Different format from human pairwise sub
  // (which is a 32-char hex string) so collisions are impossible.
  const id = 'bot-' + crypto.createHash('sha256')
    .update('askiamhmn:' + claims.operatorId).digest('hex').slice(0, 28);

  const role        = claims.role       || 'citizen';
  const roleLabel   = claims.role_label || 'Bot';
  const roleIcon    = claims.role_icon  || '🤖';
  const displayName = generateBotDisplayName(role, claims.operatorName || claims.operatorId);

  await q(
    `INSERT INTO users (id, actor_type, role, role_label, role_icon, trust_score,
                        verification_method, verification_label, display_name,
                        operator_name, operator_purpose)
     VALUES ($1, 'bot', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE
     SET role         = EXCLUDED.role,
         role_label   = EXCLUDED.role_label,
         role_icon    = EXCLUDED.role_icon,
         display_name = EXCLUDED.display_name,
         operator_name    = EXCLUDED.operator_name,
         operator_purpose = EXCLUDED.operator_purpose,
         last_seen_at = NOW()`,
    [id, role, roleLabel, roleIcon,
     // Bots get a fixed lower trust score by default — they are transparent,
     // not verified for expertise. Trust here means "is the bot operator
     // accountable?", which equals "yes" because they registered with HHTTPS.
     50,
     'machine-token', 'HHTTPS-Maschinen-Token', displayName,
     claims.operatorName || null, claims.purpose || null]
  );
  return await getUser(id);
}

function generateDisplayName(role, id) {
  // Generates a stable, pseudonymous display name like "Doc-XQ9N" or "Dev-7K2A"
  const prefixes = {
    medical_professional: 'Doc',  caregiver: 'Care',
    lawyer: 'Law',                notary: 'Not',
    developer: 'Dev',             researcher: 'Sci',  student: 'Stu',
    teacher: 'Teach',             politician: 'Pol',  civil_servant: 'Civ',
    craftsman: 'Hand',            business: 'Biz',
    journalist: 'Press',          creative: 'Art',    citizen: 'User'
  };
  const prefix = prefixes[role] || 'User';
  const suffix = id.slice(-4).toUpperCase();
  return `${prefix}-${suffix}`;
}

function generateBotDisplayName(role, operatorName) {
  // For bots we use the operator name so users recognize repeat bots.
  // Truncated + sanitized to fit our 40-char column.
  const safe = (operatorName || 'Bot').replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 28);
  return `🤖 ${safe || 'Bot'}`;
}

// ─── HHTTPS Bearer-Token verification (for bot API) ────────────────────────
const jwks = jwksClient({
  jwksUri: `${HHTTPS_BASE}/.well-known/jwks.json`,
  cache: true, cacheMaxAge: 60 * 60 * 1000,   // 1h
  rateLimit: true, jwksRequestsPerMinute: 5,
});

function jwksGetKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyHhttpsToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, jwksGetKey, { algorithms: ['ES256'] }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

/**
 * Auth middleware that accepts EITHER:
 *   - a browser session (req.session.userId set by OAuth callback) → human
 *   - an HTTP Authorization: Bearer <hhttps-machine-token> header → bot
 *
 * On success, sets req.actor = { user: <users row>, isBot: bool }.
 */
async function acceptAuth(req, res, next) {
  // 1. Try Bearer token first (bot path)
  const authz = req.headers.authorization || '';
  const bearerMatch = authz.match(/^Bearer\s+(\S+)$/i);

  if (bearerMatch) {
    try {
      const decoded = await verifyHhttpsToken(bearerMatch[1]);

      // Only machine tokens are accepted here. Human OAuth tokens should
      // arrive via the browser session, not the API. This is a deliberate
      // separation: humans get cookies, bots get bearer tokens.
      if (decoded.actorType !== 'bot' || decoded.sub !== 'machine') {
        return res.status(403).json({
          error: 'wrong_token_type',
          detail: 'API endpoints accept only HHTTPS machine tokens. Humans should use the web UI with /login.',
        });
      }

      const botUser = await upsertBotUser(decoded);
      req.actor = { user: botUser, isBot: true, claims: decoded };
      return next();
    } catch (err) {
      return res.status(401).json({
        error: 'invalid_token',
        detail: err.message,
      });
    }
  }

  // 2. Fall back to session (human path)
  if (req.session.userId) {
    const user = await getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'session_user_not_found' });
    req.actor = { user, isBot: false };
    return next();
  }

  // 3. Neither — unauthorized
  if (req.accepts('html')) {
    return res.redirect('/login?from=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({
    error: 'unauthenticated',
    detail: 'Provide either a browser session cookie (via /login) or an HHTTPS Authorization: Bearer <token> header (via https://hhttps.org/hhttps/machine/token).',
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Home: list of recent questions
app.get('/', async (req, res) => {
  const cat = req.query.category;
  const params = [];
  let where = '';
  if (cat) {
    where = 'WHERE q.category = $1';
    params.push(cat);
  }
  const { rows: questions } = await q(
    `SELECT q.id, q.title, q.body, q.category, q.tags, q.answer_count, q.view_count, q.created_at,
            u.id AS asker_id, u.display_name, u.role, u.role_label, u.role_icon, u.trust_score,
            u.actor_type
     FROM questions q
     JOIN users u ON u.id = q.asker_id
     ${where}
     ORDER BY q.created_at DESC
     LIMIT 50`,
    params
  );
  const { rows: categories } = await q(
    `SELECT * FROM categories ORDER BY sort_order`
  );

  let me = null;
  if (req.session.userId) me = await getUser(req.session.userId);

  res.send(renderHome({ questions, categories, me, activeCategory: cat }));
});

// Question detail + answers
app.get('/q/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).send('Invalid id');

  const { rows: qRows } = await q(
    `SELECT q.*, u.display_name, u.role, u.role_label, u.role_icon, u.trust_score
     FROM questions q JOIN users u ON u.id = q.asker_id
     WHERE q.id = $1`, [id]
  );
  const question = qRows[0];
  if (!question) return res.status(404).send('Question not found');

  await q(`UPDATE questions SET view_count = view_count + 1 WHERE id = $1`, [id]);

  const { rows: answers } = await q(
    `SELECT a.*, u.display_name, u.operator_name AS operator_name
     FROM answers a JOIN users u ON u.id = a.answerer_id
     WHERE a.question_id = $1
     ORDER BY a.marked_helpful DESC, a.created_at ASC`,
    [id]
  );

  const { rows: catRows } = await q(`SELECT * FROM categories WHERE slug = $1`, [question.category]);
  const category = catRows[0];

  let me = null;
  if (req.session.userId) me = await getUser(req.session.userId);

  res.send(renderQuestion({ question, answers, category, me }));
});

// Ask a question (form + submit)
app.get('/ask', requireAuth, async (req, res) => {
  const me = await getUser(req.session.userId);
  const { rows: categories } = await q(`SELECT * FROM categories ORDER BY sort_order`);
  res.send(renderAskForm({ me, categories }));
});

app.post('/ask', requireAuth, async (req, res) => {
  const { title, body, category } = req.body;
  if (!title?.trim() || !body?.trim() || !category?.trim()) {
    return res.status(400).send('Title, body, category required');
  }
  if (title.length > 200) return res.status(400).send('Title too long');
  if (body.length > 5000) return res.status(400).send('Body too long');

  const { rows: catRows } = await q(`SELECT slug FROM categories WHERE slug = $1`, [category]);
  if (!catRows[0]) return res.status(400).send('Invalid category');

  const { rows } = await q(
    `INSERT INTO questions (asker_id, title, body, category) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.session.userId, title.trim(), body.trim(), category]
  );
  res.redirect(`/q/${rows[0].id}`);
});

// Post an answer
app.post('/q/:id/answer', requireAuth, async (req, res) => {
  const qid = parseInt(req.params.id);
  const { body } = req.body;
  if (!qid) return res.status(400).send('Invalid id');
  if (!body?.trim()) return res.status(400).send('Body required');
  if (body.length > 5000) return res.status(400).send('Body too long');

  const me = await getUser(req.session.userId);
  if (!me) return res.status(401).send('User not found');

  const { rows: qRows } = await q(`SELECT id FROM questions WHERE id = $1`, [qid]);
  if (!qRows[0]) return res.status(404).send('Question not found');

  await q(
    `INSERT INTO answers (question_id, answerer_id, body,
                          answerer_actor_type,
                          answerer_role, answerer_role_label, answerer_role_icon,
                          answerer_trust, answerer_verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [qid, me.id, body.trim(),
     me.actor_type || 'human',
     me.role, me.role_label, me.role_icon, me.trust_score, me.verification_method]
  );
  await q(`UPDATE questions SET answer_count = answer_count + 1, updated_at = NOW() WHERE id = $1`, [qid]);
  res.redirect(`/q/${qid}`);
});

// Mark an answer helpful (only by asker)
app.post('/a/:id/helpful', requireAuth, async (req, res) => {
  const aid = parseInt(req.params.id);
  if (!aid) return res.status(400).send('Invalid id');

  const { rows } = await q(
    `SELECT a.id, a.question_id, q.asker_id, a.marked_helpful
     FROM answers a JOIN questions q ON q.id = a.question_id
     WHERE a.id = $1`, [aid]
  );
  const ans = rows[0];
  if (!ans) return res.status(404).send('Answer not found');
  if (ans.asker_id !== req.session.userId) {
    return res.status(403).send('Only the asker can mark answers helpful');
  }

  await q(
    `UPDATE answers SET marked_helpful = NOT marked_helpful,
                        marked_helpful_at = CASE WHEN marked_helpful THEN NULL ELSE NOW() END
     WHERE id = $1`, [aid]
  );
  res.redirect(`/q/${ans.question_id}`);
});

// ─── Bot API ────────────────────────────────────────────────────────────────
// Endpoints below accept HHTTPS machine tokens via Authorization: Bearer.
// Same logic as the web routes, but JSON in/out and accepts only bots.

const apiRateLimit = rateLimit({
  windowMs: 60_000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', detail: 'Max 30 requests per minute per IP.' },
});

/**
 * POST /api/questions
 * Body: { title: string, body: string, category: string, tags?: string[] }
 * Auth: Bearer <hhttps-machine-token>
 *
 * Returns: { ok, question: { id, url, ... } }
 */
app.post('/api/questions', apiRateLimit, acceptAuth, async (req, res) => {
  if (!req.actor.isBot) {
    return res.status(403).json({
      error: 'bot_only',
      detail: 'This endpoint is only for bots. Humans should use POST /ask via the web UI.',
    });
  }
  const { title, body, category, tags } = req.body || {};
  if (typeof title !== 'string' || !title.trim())  return res.status(400).json({ error: 'title required' });
  if (typeof body  !== 'string' || !body.trim())   return res.status(400).json({ error: 'body required' });
  if (title.length > 200)   return res.status(400).json({ error: 'title too long (max 200)' });
  if (body.length  > 10000) return res.status(400).json({ error: 'body too long (max 10000)' });

  // Validate category exists
  const { rows: catRows } = await q(`SELECT slug FROM categories WHERE slug = $1`, [category || 'allgemein']);
  if (!catRows[0]) return res.status(400).json({ error: 'unknown_category', detail: `Category "${category}" does not exist.` });

  const safeTags = Array.isArray(tags)
    ? tags.filter(t => typeof t === 'string').slice(0, 8).map(t => t.slice(0, 24))
    : [];

  const { rows } = await q(
    `INSERT INTO questions (asker_id, title, body, category, tags)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [req.actor.user.id, title.trim(), body.trim(), category || 'allgemein', safeTags]
  );

  res.status(201).json({
    ok: true,
    question: {
      id:         rows[0].id,
      url:        `${BASE_URL}/q/${rows[0].id}`,
      title:      title.trim(),
      category:   category || 'allgemein',
      tags:       safeTags,
      created_at: rows[0].created_at,
      asker: {
        actor_type:   'bot',
        display_name: req.actor.user.display_name,
        role:         req.actor.user.role,
        role_label:   req.actor.user.role_label,
        role_icon:    req.actor.user.role_icon,
        operator:     req.actor.user.operator_name,
        purpose:      req.actor.user.operator_purpose,
      },
    },
  });
});

/**
 * POST /api/q/:id/answer
 * Body: { body: string }
 * Auth: Bearer <hhttps-machine-token>
 *
 * Returns: { ok, answer: { id, ... } }
 */
app.post('/api/q/:id/answer', apiRateLimit, acceptAuth, async (req, res) => {
  if (!req.actor.isBot) {
    return res.status(403).json({
      error: 'bot_only',
      detail: 'This endpoint is only for bots. Humans should use POST /q/:id/answer via the web UI.',
    });
  }
  const qid = parseInt(req.params.id);
  if (!qid) return res.status(400).json({ error: 'invalid_question_id' });

  const { body } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (body.length > 10000) return res.status(400).json({ error: 'body too long (max 10000)' });

  const { rows: qRows } = await q(`SELECT id, category FROM questions WHERE id = $1`, [qid]);
  if (!qRows[0]) return res.status(404).json({ error: 'question_not_found' });

  const me = req.actor.user;

  const { rows } = await q(
    `INSERT INTO answers (question_id, answerer_id, body,
                          answerer_actor_type,
                          answerer_role, answerer_role_label, answerer_role_icon,
                          answerer_trust, answerer_verification)
     VALUES ($1, $2, $3, 'bot', $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [qid, me.id, body.trim(),
     me.role, me.role_label, me.role_icon, me.trust_score, me.verification_method]
  );

  await q(`UPDATE questions SET answer_count = answer_count + 1, updated_at = NOW() WHERE id = $1`, [qid]);

  res.status(201).json({
    ok: true,
    answer: {
      id:         rows[0].id,
      url:        `${BASE_URL}/q/${qid}#a-${rows[0].id}`,
      created_at: rows[0].created_at,
      answerer: {
        actor_type:   'bot',
        display_name: me.display_name,
        role:         me.role,
        role_label:   me.role_label,
        role_icon:    me.role_icon,
        trust:        me.trust_score,
        operator:     me.operator_name,
        purpose:      me.operator_purpose,
      },
    },
  });
});

/**
 * GET /api/q/:id
 * Read a question + answers as JSON. No auth required.
 * Useful for bots polling for questions to answer.
 */
app.get('/api/q/:id', apiRateLimit, async (req, res) => {
  const qid = parseInt(req.params.id);
  if (!qid) return res.status(400).json({ error: 'invalid_question_id' });

  const { rows: qRows } = await q(
    `SELECT q.*, u.display_name AS asker_display, u.actor_type AS asker_actor_type,
            u.role_label AS asker_role_label, u.role_icon AS asker_role_icon
       FROM questions q JOIN users u ON u.id = q.asker_id
      WHERE q.id = $1`, [qid]
  );
  if (!qRows[0]) return res.status(404).json({ error: 'question_not_found' });

  const { rows: aRows } = await q(
    `SELECT a.*, u.display_name AS answerer_display
       FROM answers a JOIN users u ON u.id = a.answerer_id
      WHERE a.question_id = $1
      ORDER BY a.marked_helpful DESC, a.created_at ASC`, [qid]
  );

  // Increment view count
  await q(`UPDATE questions SET view_count = view_count + 1 WHERE id = $1`, [qid]);

  res.json({
    ok: true,
    question: {
      id: qRows[0].id, title: qRows[0].title, body: qRows[0].body,
      category: qRows[0].category, tags: qRows[0].tags,
      view_count: qRows[0].view_count, answer_count: qRows[0].answer_count,
      created_at: qRows[0].created_at, updated_at: qRows[0].updated_at,
      asker: {
        actor_type:   qRows[0].asker_actor_type,
        display_name: qRows[0].asker_display,
        role_label:   qRows[0].asker_role_label,
        role_icon:    qRows[0].asker_role_icon,
      },
    },
    answers: aRows.map(a => ({
      id: a.id, body: a.body, created_at: a.created_at,
      marked_helpful: a.marked_helpful,
      answerer: {
        actor_type:   a.answerer_actor_type,
        display_name: a.answerer_display,
        role:         a.answerer_role,
        role_label:   a.answerer_role_label,
        role_icon:    a.answerer_role_icon,
        trust:        a.answerer_trust,
        verification: a.answerer_verification,
      },
    })),
  });
});

/**
 * GET /api/questions?category=...&limit=20
 * List recent questions. No auth required. Useful for bots looking for work.
 */
app.get('/api/questions', apiRateLimit, async (req, res) => {
  const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const cat    = typeof req.query.category === 'string' ? req.query.category : null;

  const params = [];
  let where = '';
  if (cat) {
    params.push(cat);
    where = `WHERE q.category = $1`;
  }
  params.push(limit);

  const { rows } = await q(
    `SELECT q.id, q.title, q.category, q.tags, q.created_at,
            q.answer_count, q.view_count,
            u.display_name AS asker_display, u.actor_type AS asker_actor_type
       FROM questions q JOIN users u ON u.id = q.asker_id
       ${where}
       ORDER BY q.created_at DESC
       LIMIT $${params.length}`,
    params
  );

  res.json({
    ok: true,
    count: rows.length,
    questions: rows.map(r => ({
      id: r.id, title: r.title, url: `${BASE_URL}/q/${r.id}`,
      category: r.category, tags: r.tags,
      created_at: r.created_at,
      answer_count: r.answer_count, view_count: r.view_count,
      asker: {
        actor_type:   r.asker_actor_type,
        display_name: r.asker_display,
      },
    })),
  });
});

// ─── OAuth login flow ───────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  // PKCE: generate verifier + challenge
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const stateValue = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');

  req.session.pkceVerifier = verifier;
  req.session.oauthState   = stateValue;
  req.session.oauthNonce   = nonce;
  req.session.returnTo     = req.query.from || '/';

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    redirect_uri:          `${BASE_URL}/auth/callback`,
    scope:                 'openid role verification_method',
    state:                 stateValue,
    nonce,
    code_challenge:        challenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`${HHTTPS_BASE}/hhttps/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(renderError(`Login abgebrochen: ${error_description || error}`));
  }
  if (!code) return res.status(400).send(renderError('Kein Code erhalten'));
  if (state !== req.session.oauthState) {
    return res.status(400).send(renderError('State mismatch — possible CSRF attack'));
  }

  // Exchange code for token
  const tokenRes = await fetch(`${HHTTPS_BASE}/hhttps/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  `${BASE_URL}/auth/callback`,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET || undefined,
      code_verifier: req.session.pkceVerifier
    })
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.json().catch(() => ({}));
    return res.status(401).send(renderError(`Token-Tausch fehlgeschlagen: ${errBody.error_description || errBody.error || tokenRes.status}`));
  }
  const tokens = await tokenRes.json();

  // Decode id_token (no signature verification here — Phase 3 will add it
  // via the JWKS endpoint of hhttps.org. For demo we trust the secure channel.)
  const parts = tokens.id_token.split('.');
  if (parts.length !== 3) return res.status(401).send(renderError('Invalid id_token'));
  let claims;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    claims = JSON.parse(payload);
  } catch (e) {
    return res.status(401).send(renderError('id_token konnte nicht dekodiert werden'));
  }

  if (claims.nonce !== req.session.oauthNonce) {
    return res.status(401).send(renderError('Nonce mismatch'));
  }

  // Upsert user, start session
  const user = await upsertUser(claims);
  req.session.userId = user.id;
  delete req.session.pkceVerifier;
  delete req.session.oauthState;
  delete req.session.oauthNonce;

  res.redirect(req.session.returnTo || '/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Rendering helpers ──────────────────────────────────────────────────────
// (kept inline to make the demo a single file; for production, swap to a
//  template engine like EJS or Nunjucks)

const I18N_SCRIPT = `
<script>
(function(){
  const T = {
    de: {
      "brand.sub":"Q&A für verifizierte Menschen","nav.questions":"Fragen","nav.ask":"Frage stellen",
      "nav.logout":"Abmelden","nav.login":"Mit HHTTPS einloggen","footer.tagline":"Demo-Plattform für das HHTTPS-Protokoll",
      "cat.all":"Alle","home.hero.t1":"Fragen, die","home.hero.t2":"echte Menschen","home.hero.t3":"beantworten.",
      "home.hero.lead":"Jede Antwort hier kommt von einem kryptografisch verifizierten Menschen — mit Rolle und Trust-Score. Keine Bots, keine KI-Antworten ohne Kennzeichnung.",
      "home.empty.title":"Noch keine Fragen","home.empty.inCat":" in dieser Kategorie",
      "home.empty.cta":"Sei der erste! Stelle eine Frage und bekomme Antworten von verifizierten Menschen.",
      "answer.one":"Antwort","answer.many":"Antworten","q.breadcrumb":"Frage","q.noAnswers":"Noch keine Antworten.",
      "q.beFirst":"Sei der erste!","q.loginToAnswer":"Logge dich ein, um zu antworten.",
      "answer.helpfulBadge":"✓ Vom Fragesteller als hilfreich markiert","bot.machine":"🤖 Maschine",
      "bot.pillTitle":"Antwort von einer registrierten Maschine — transparent gekennzeichnet","bot.metaSelfDeclared":"Maschine, selbstdeklariert",
      "verify.for":"Fachverifikation für","verify.none":"Keine Fachverifikation für",
      "verify.botTitle":"Maschinen-Antworten werden grundsätzlich ohne Fachverifikation eingestuft — die Verantwortung liegt beim Bot-Betreiber.",
      "verify.noTitle":"Trotzdem gültige Antwort, aber ohne fachliche Verifikation für diese Kategorie",
      "q.yourAnswer":"Deine Antwort","q.answeringAs":"Du antwortest als","q.withTrust":"mit Trust",
      "q.qual.pre":"Deine Rolle ist für die Kategorie","q.qual.post":"qualifiziert — deine Antwort erscheint mit grünem Fachsiegel.",
      "q.notQual.post":"nicht spezifisch qualifiziert. Du darfst trotzdem antworten — deine Antwort wird mit einem Hinweis versehen.",
      "q.answerPlaceholder":"Deine Antwort...","q.postAnswer":"Antwort posten","answer.markHelpful":"Als hilfreich markieren",
      "ask.h1":"Frage stellen","ask.askingAs":"Du fragst als","ask.leadRest":"Dein Trust-Score und deine Rolle werden bei deiner Frage angezeigt.",
      "form.title":"Titel","form.body":"Beschreibung","form.category":"Kategorie",
      "ask.titlePlaceholder":"Konkrete Frage in einem Satz...","ask.bodyPlaceholder":"Kontext, was du schon weißt, was du genau wissen willst...",
      "action.cancel":"Abbrechen","action.ask":"Frage stellen","action.back":"← zurück",
      "error.title":"Ein Fehler ist aufgetreten",
      "time.justNow":"gerade eben","time.min":"Min","time.hrs":"Std","time.days":"Tag(e)"
    },
    en: {
      "brand.sub":"Q&A by verified humans","nav.questions":"Questions","nav.ask":"Ask a question",
      "nav.logout":"Log out","nav.login":"Log in with HHTTPS","footer.tagline":"Demo platform for the HHTTPS protocol",
      "cat.all":"All","home.hero.t1":"Questions that","home.hero.t2":"real humans","home.hero.t3":"answer.",
      "home.hero.lead":"Every answer here comes from a cryptographically verified human — with role and trust score. No bots, no AI answers without a label.",
      "home.empty.title":"No questions yet","home.empty.inCat":" in this category",
      "home.empty.cta":"Be the first! Ask a question and get answers from verified humans.",
      "answer.one":"Answer","answer.many":"Answers","q.breadcrumb":"Question","q.noAnswers":"No answers yet.",
      "q.beFirst":"Be the first!","q.loginToAnswer":"Log in to answer.",
      "answer.helpfulBadge":"✓ Marked helpful by the asker","bot.machine":"🤖 Machine",
      "bot.pillTitle":"Answer from a registered machine — transparently labelled","bot.metaSelfDeclared":"Machine, self-declared",
      "verify.for":"Subject verification for","verify.none":"No subject verification for",
      "verify.botTitle":"Machine answers are categorised without subject verification by default — responsibility lies with the bot operator.",
      "verify.noTitle":"Still a valid answer, but without subject verification for this category",
      "q.yourAnswer":"Your answer","q.answeringAs":"You are answering as","q.withTrust":"with trust",
      "q.qual.pre":"Your role for the category","q.qual.post":"is qualified — your answer appears with a green subject seal.",
      "q.notQual.post":"is not specifically qualified. You may still answer — your answer will be flagged with a note.",
      "q.answerPlaceholder":"Your answer...","q.postAnswer":"Post answer","answer.markHelpful":"Mark as helpful",
      "ask.h1":"Ask a question","ask.askingAs":"You are asking as","ask.leadRest":"Your trust score and role are shown with your question.",
      "form.title":"Title","form.body":"Description","form.category":"Category",
      "ask.titlePlaceholder":"A concrete question in one sentence...","ask.bodyPlaceholder":"Context, what you already know, what exactly you want to find out...",
      "action.cancel":"Cancel","action.ask":"Ask a question","action.back":"← Back",
      "error.title":"An error occurred",
      "time.justNow":"just now","time.min":"min","time.hrs":"h","time.days":"day(s)"
    }
  };
  function apply(lang){
    const d = T[lang] || T.de;
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function(e){ var t=d[e.getAttribute('data-i18n')]; if(t!=null) e.textContent=t; });
    document.querySelectorAll('[data-i18n-title]').forEach(function(e){ var t=d[e.getAttribute('data-i18n-title')]; if(t!=null) e.title=t; });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(e){ var t=d[e.getAttribute('data-i18n-ph')]; if(t!=null) e.placeholder=t; });
    document.querySelectorAll('.lang-toggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.lang===lang); });
    try { localStorage.setItem('iamhmn-lang', lang); } catch(e){}
  }
  function detect(){
    try { var s=localStorage.getItem('iamhmn-lang'); if(s && T[s]) return s; } catch(e){}
    var n=(navigator.language||'de').slice(0,2).toLowerCase();
    return T[n] ? n : 'de';
  }
  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('.lang-toggle button').forEach(function(b){
      b.addEventListener('click', function(){ apply(b.dataset.lang); });
    });
    apply(detect());
  });
})();
</script>`;

function pageWrap(title, content, opts = {}) {
  const me = opts.me;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · ask.iamhmn</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..600,30..100,0..1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <div class="brand-mark"></div>
    <div>
      <div class="brand-name">ask <em>I am human</em></div>
      <div class="brand-sub" data-i18n="brand.sub">Q&amp;A für verifizierte Menschen</div>
    </div>
  </a>
  <nav class="topnav">
    <a href="/" data-i18n="nav.questions">Fragen</a>
    ${me ? `<a href="/ask" class="btn-primary" data-i18n="nav.ask">Frage stellen</a>` : ''}
    ${me
      ? `<div class="me">
           <span class="me-icon">${esc(me.role_icon || '🧑')}</span>
           <div class="me-info">
             <div class="me-name">${esc(me.display_name)}</div>
             <div class="me-role">${esc(me.role_label)} · Trust ${me.trust_score}</div>
           </div>
           <a class="logout" href="/logout" data-i18n-title="nav.logout" title="Abmelden">↪</a>
         </div>`
      : `<a class="btn-primary" href="/login" data-i18n="nav.login">Mit HHTTPS einloggen</a>`}
    <span class="lang-toggle" role="group" aria-label="Language">
      <button type="button" data-lang="de" class="active">DE</button>
      <button type="button" data-lang="en">EN</button>
    </span>
  </nav>
</header>
<main class="container">
${content}
</main>
<footer class="footer">
  <div>
    <strong>ask.iamhmn.org</strong> · <span data-i18n="footer.tagline">Demo-Plattform für das HHTTPS-Protokoll</span>
  </div>
  <div>
    <a href="https://iamhmn.org">iamhmn.org</a>
    · <a href="https://hhttps.org">hhttps.org</a>
    · <a href="https://github.com/dhannus/HHTTPS">GitHub</a>
  </div>
</footer>
${I18N_SCRIPT}
</body>
</html>`;
}

function renderHome({ questions, categories, me, activeCategory }) {
  const catChips = categories.map(c => `
    <a class="cat-chip ${activeCategory === c.slug ? 'active' : ''}"
       href="/${c.slug ? '?category=' + c.slug : ''}">
      <span class="cat-icon">${esc(c.icon)}</span>
      <span>${esc(c.label)}</span>
    </a>
  `).join('');

  const empty = `
    <div class="empty">
      <div class="empty-icon">💭</div>
      <h2><span data-i18n="home.empty.title">Noch keine Fragen</span>${activeCategory ? `<span data-i18n="home.empty.inCat"> in dieser Kategorie</span>` : ''}</h2>
      <p data-i18n="home.empty.cta">Sei der erste! Stelle eine Frage und bekomme Antworten von verifizierten Menschen.</p>
      ${me ? `<a class="btn-primary" href="/ask" data-i18n="action.ask">Frage stellen</a>`
           : `<a class="btn-primary" href="/login" data-i18n="nav.login">Mit HHTTPS einloggen</a>`}
    </div>`;

  const qList = questions.length === 0 ? empty : questions.map(qi => `
    <a class="q-item" href="/q/${qi.id}">
      <div class="q-meta">
        <span class="q-cat">${esc(categories.find(c => c.slug === qi.category)?.icon || '📰')} ${esc(categories.find(c => c.slug === qi.category)?.label || qi.category)}</span>
        <span class="q-time">${fmtTime(qi.created_at)}</span>
      </div>
      <h3 class="q-title">${esc(qi.title)}</h3>
      <p class="q-preview">${esc(truncate(qi.body, 160))}</p>
      <div class="q-foot">
        <span class="q-author">
          <span class="role-badge" title="${esc(qi.role_label)}">${esc(qi.role_icon)}</span>
          <span class="q-name">${esc(qi.display_name)}</span>
          ${qi.actor_type === 'bot'
            ? `<span class="bot-pill">🤖 Bot</span>`
            : `<span class="q-trust">Trust ${qi.trust_score}</span>`}
        </span>
        <span class="q-stats">
          <span>💬 ${qi.answer_count} ${qi.answer_count === 1 ? '<span data-i18n="answer.one">Antwort</span>' : '<span data-i18n="answer.many">Antworten</span>'}</span>
          <span>👁 ${qi.view_count}</span>
        </span>
      </div>
    </a>
  `).join('');

  const content = `
    <section class="hero">
      <h1><span data-i18n="home.hero.t1">Fragen, die</span> <em data-i18n="home.hero.t2">echte Menschen</em> <span data-i18n="home.hero.t3">beantworten.</span></h1>
      <p class="lead" data-i18n="home.hero.lead">Jede Antwort hier kommt von einem kryptografisch verifizierten Menschen — mit Rolle und Trust-Score. Keine Bots, keine KI-Antworten ohne Kennzeichnung.</p>
    </section>
    <nav class="categories">
      <a class="cat-chip ${!activeCategory ? 'active' : ''}" href="/">
        <span class="cat-icon">📋</span><span data-i18n="cat.all">Alle</span>
      </a>
      ${catChips}
    </nav>
    <section class="questions">
      ${qList}
    </section>
  `;
  return pageWrap('Fragen', content, { me });
}

function renderQuestion({ question, answers, category, me }) {
  const askerIsMe = me && me.id === question.asker_id;
  const qualifiedRoles = category?.qualified_roles || [];

  const answersHtml = answers.length === 0 ? `
    <div class="empty-answers">
      <p><span data-i18n="q.noAnswers">Noch keine Antworten.</span> ${me ? '<span data-i18n="q.beFirst">Sei der erste!</span>' : '<span data-i18n="q.loginToAnswer">Logge dich ein, um zu antworten.</span>'}</p>
    </div>` : answers.map(a => {
    const qualified = qualifiedRoles.includes(a.answerer_role);
    const trustClass = a.answerer_trust >= 80 ? 'trust-high' :
                       a.answerer_trust >= 60 ? 'trust-mid' : 'trust-low';
    const isBot = a.answerer_actor_type === 'bot';
    return `
      <article class="answer ${a.marked_helpful ? 'answer-helpful' : ''} ${isBot ? 'answer-bot' : ''}">
        ${a.marked_helpful ? `<div class="helpful-badge" data-i18n="answer.helpfulBadge">✓ Vom Fragesteller als hilfreich markiert</div>` : ''}
        <header class="answer-head">
          <div class="answerer">
            <span class="role-badge ${trustClass}" title="${esc(a.answerer_role_label)}">${esc(a.answerer_role_icon)}</span>
            <div>
              <div class="answerer-name">
                ${esc(a.display_name)}
                ${isBot ? `<span class="bot-pill" data-i18n-title="bot.pillTitle" title="Antwort von einer registrierten Maschine — transparent gekennzeichnet" data-i18n="bot.machine">🤖 Maschine</span>` : ''}
              </div>
              <div class="answerer-meta">
                <strong>${esc(a.answerer_role_label)}</strong> · ${isBot ? '<span data-i18n="bot.metaSelfDeclared">Maschine, selbstdeklariert</span>' : `Trust ${a.answerer_trust}`}
              </div>
            </div>
          </div>
          ${qualified && !isBot
            ? `<span class="verify-badge verify-yes">✓ <span data-i18n="verify.for">Fachverifikation für</span> ${esc(category.label)}</span>`
            : isBot
              ? `<span class="verify-badge verify-bot" data-i18n-title="verify.botTitle" title="Maschinen-Antworten werden grundsätzlich ohne Fachverifikation eingestuft — die Verantwortung liegt beim Bot-Betreiber.">🤖 ${esc(a.operator_name || a.answerer_role_label || 'Bot')}</span>`
              : `<span class="verify-badge verify-no" data-i18n-title="verify.noTitle" title="Trotzdem gültige Antwort, aber ohne fachliche Verifikation für diese Kategorie">⚠ <span data-i18n="verify.none">Keine Fachverifikation für</span> ${esc(category?.label || question.category)}</span>`}
        </header>
        <div class="answer-body">${linkify(esc(a.body))}</div>
        <footer class="answer-foot">
          <span class="answer-time">${fmtTime(a.created_at)}</span>
          ${askerIsMe && !a.marked_helpful ? `
            <form action="/a/${a.id}/helpful" method="POST" style="display:inline">
              <button class="mark-helpful" data-i18n="answer.markHelpful">Als hilfreich markieren</button>
            </form>` : ''}
        </footer>
      </article>`;
  }).join('');

  const answerForm = me ? `
    <form class="answer-form" action="/q/${question.id}/answer" method="POST">
      <h3 data-i18n="q.yourAnswer">Deine Antwort</h3>
      <p class="answer-hint">
        <span data-i18n="q.answeringAs">Du antwortest als</span> <strong>${esc(me.role_label)}</strong> <span data-i18n="q.withTrust">mit Trust</span> ${me.trust_score}.
        ${qualifiedRoles.includes(me.role)
          ? `<span data-i18n="q.qual.pre">Deine Rolle ist für die Kategorie</span> <em>${esc(category?.label)}</em> <span data-i18n="q.qual.post">qualifiziert — deine Antwort erscheint mit grünem Fachsiegel.</span>`
          : `<span data-i18n="q.qual.pre">Deine Rolle ist für die Kategorie</span> <em>${esc(category?.label)}</em> <span data-i18n="q.notQual.post">nicht spezifisch qualifiziert. Du darfst trotzdem antworten — deine Antwort wird mit einem Hinweis versehen.</span>`}
      </p>
      <textarea name="body" rows="6" maxlength="5000" data-i18n-ph="q.answerPlaceholder" placeholder="Deine Antwort..." required></textarea>
      <button type="submit" class="btn-primary" data-i18n="q.postAnswer">Antwort posten</button>
    </form>
  ` : `
    <div class="answer-form-empty">
      <p data-i18n="q.loginToAnswer">Logge dich ein, um zu antworten.</p>
      <a class="btn-primary" href="/login?from=/q/${question.id}" data-i18n="nav.login">Mit HHTTPS einloggen</a>
    </div>`;

  const content = `
    <article class="question-detail">
      <div class="q-breadcrumb">
        <a href="/?category=${esc(question.category)}">${esc(category?.icon || '📰')} ${esc(category?.label || question.category)}</a>
        <span class="sep">›</span>
        <span data-i18n="q.breadcrumb">Frage</span>
      </div>
      <h1>${esc(question.title)}</h1>
      <div class="q-meta-detail">
        <span class="q-author">
          <span class="role-badge" title="${esc(question.role_label)}">${esc(question.role_icon)}</span>
          <span><strong>${esc(question.display_name)}</strong> · ${esc(question.role_label)} · Trust ${question.trust_score}</span>
        </span>
        <span class="q-time">${fmtTime(question.created_at)}</span>
      </div>
      <div class="q-body">${linkify(esc(question.body))}</div>
    </article>

    <section class="answers">
      <h2>${answers.length} ${answers.length === 1 ? '<span data-i18n="answer.one">Antwort</span>' : '<span data-i18n="answer.many">Antworten</span>'}</h2>
      ${answersHtml}
    </section>

    <section class="answer-form-wrap">
      ${answerForm}
    </section>
  `;
  return pageWrap(question.title, content, { me });
}

function renderAskForm({ me, categories }) {
  const catOptions = categories.map(c => {
    const qualified = c.qualified_roles.includes(me.role);
    return `<label class="cat-radio ${qualified ? 'qualified' : ''}">
      <input type="radio" name="category" value="${esc(c.slug)}" required>
      <div>
        <div class="cat-radio-head">${esc(c.icon)} ${esc(c.label)}</div>
        <div class="cat-radio-desc">${esc(c.description)}</div>
      </div>
    </label>`;
  }).join('');

  const content = `
    <article class="ask-page">
      <h1 data-i18n="ask.h1">Frage stellen</h1>
      <p class="lead"><span data-i18n="ask.askingAs">Du fragst als</span> <strong>${esc(me.role_label)}</strong>. <span data-i18n="ask.leadRest">Dein Trust-Score und deine Rolle werden bei deiner Frage angezeigt.</span></p>

      <form action="/ask" method="POST" class="ask-form">
        <label class="form-row">
          <span class="form-label" data-i18n="form.title">Titel</span>
          <input type="text" name="title" maxlength="200" required
                 data-i18n-ph="ask.titlePlaceholder" placeholder="Konkrete Frage in einem Satz..."
                 class="form-input">
        </label>

        <label class="form-row">
          <span class="form-label" data-i18n="form.body">Beschreibung</span>
          <textarea name="body" rows="8" maxlength="5000" required
                    data-i18n-ph="ask.bodyPlaceholder" placeholder="Kontext, was du schon weißt, was du genau wissen willst..."
                    class="form-textarea"></textarea>
        </label>

        <div class="form-row">
          <span class="form-label" data-i18n="form.category">Kategorie</span>
          <div class="cat-radios">
            ${catOptions}
          </div>
        </div>

        <div class="form-actions">
          <a href="/" class="btn-secondary" data-i18n="action.cancel">Abbrechen</a>
          <button type="submit" class="btn-primary" data-i18n="action.ask">Frage stellen</button>
        </div>
      </form>
    </article>
  `;
  return pageWrap('Frage stellen', content, { me });
}

function renderError(msg) {
  return pageWrap('Fehler', `
    <div class="empty">
      <div class="empty-icon">⚠</div>
      <h2 data-i18n="error.title">Ein Fehler ist aufgetreten</h2>
      <p>${esc(msg)}</p>
      <a class="btn-primary" href="/" data-i18n="action.back">← zurück</a>
    </div>
  `, {});
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trim() + '…';
}
function linkify(s) {
  // After escape, turn URLs into clickable links
  return s.replace(/https?:\/\/[^\s<]+/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`)
    .replace(/\n/g, '<br>');
}
function fmtTime(d) {
  const date = new Date(d);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return '<span data-i18n="time.justNow">gerade eben</span>';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' <span data-i18n="time.min">Min</span>';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' <span data-i18n="time.hrs">Std</span>';
  if (diffSec < 7 * 86400) return Math.floor(diffSec / 86400) + ' <span data-i18n="time.days">Tag(e)</span>';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Static + start ─────────────────────────────────────────────────────────
app.use('/static', express.static(join(__dirname, 'public/static')));

// Health
app.get('/health', (req, res) => res.json({ ok: true, service: 'ask.iamhmn.org' }));

// Boot
async function main() {
  try {
    await q('SELECT 1');
    console.log('[DB] Connected.');
  } catch (e) {
    console.error('[DB] FAILED:', e.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`📚 ask.iamhmn.org running on port ${PORT}`);
    console.log(`   Base URL:     ${BASE_URL}`);
    console.log(`   OAuth Issuer: ${HHTTPS_BASE}`);
    console.log(`   Client ID:    ${CLIENT_ID}`);
    console.log(`   Mode:         ${CLIENT_SECRET ? 'confidential client' : 'public client + PKCE'}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });

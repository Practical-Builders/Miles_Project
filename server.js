import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env manually ────────────────────────────────────────────────────
function loadEnv() {
  try {
    const env = readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    }
  } catch {}
}
loadEnv();

const JWT_SECRET = process.env.JWT_SECRET || 'promptlyperfect-secret-change-me';
const BASE_URL = process.env.APP_URL || process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FREE_RUN_LIMIT = 10;
const PRO_RUN_LIMIT = 200;

// ── Resend email (optional — requires RESEND_API_KEY) ─────────────────────
let resendClient = null;
try {
  const { Resend } = await import('resend');
  if (process.env.RESEND_API_KEY) resendClient = new Resend(process.env.RESEND_API_KEY);
} catch {}

const RESEND_FROM = process.env.RESEND_FROM || 'PromptlyPerfect <onboarding@resend.dev>';
// onboarding@resend.dev can only deliver to the Resend account owner's address until a domain is verified.
// Set RESEND_OVERRIDE_TO to your Resend account email to receive all emails during testing.
const RESEND_OVERRIDE_TO = process.env.RESEND_OVERRIDE_TO || null;

async function sendEmail(to, subject, html) {
  if (!resendClient) { console.log('[email] No Resend client — skipping email to', to); return; }
  const recipient = RESEND_OVERRIDE_TO || to;
  try {
    const result = await resendClient.emails.send({ from: RESEND_FROM, to: recipient, subject, html });
    if (result.error) console.error('[email] Resend error:', JSON.stringify(result.error));
    else console.log('[email] Sent to', recipient, result.data?.id);
  } catch (e) { console.error('[email] Send failed:', e.message); }
}

// ── Database ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function queryOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

// Create tables and migrate schema on startup
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`).catch(() => {});
// Fix users who got streak=1 from the old DB default but have never completed a lesson
await query(`UPDATE users SET streak = 0 WHERE streak = 1 AND (last_visit = '' OR last_visit IS NULL) AND (completed_lessons = '[]' OR completed_lessons IS NULL);`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT;`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TEXT;`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`).catch(() => {});
await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`).catch(() => {});
await query(`CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  business_name TEXT,
  num_accounts TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);`).catch(() => {});
await query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    sb_runs_this_month INT NOT NULL DEFAULT 0,
    sb_reset_month TEXT NOT NULL DEFAULT '',
    xp INT NOT NULL DEFAULT 0,
    streak INT NOT NULL DEFAULT 0,
    last_visit TEXT NOT NULL DEFAULT '',
    completed_lessons JSONB NOT NULL DEFAULT '[]',
    passed_missions JSONB NOT NULL DEFAULT '[]',
    team_id TEXT,
    team_role TEXT
  );
  CREATE TABLE IF NOT EXISTS community_prompts (
    id TEXT PRIMARY KEY,
    cat TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    score INT NOT NULL,
    uses INT NOT NULL DEFAULT 0,
    published_by TEXT NOT NULL,
    published_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settings JSONB NOT NULL DEFAULT '{}',
    assigned_categories JSONB NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team_invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS team_prompts (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    published_by TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    category TEXT NOT NULL,
    score INT NOT NULL,
    status TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    submitted_at TEXT NOT NULL,
    uses INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    team_id TEXT,
    type TEXT NOT NULL,
    category_id TEXT,
    category_name TEXT,
    earned_at TEXT NOT NULL
  );
`);

// ── Row mappers ───────────────────────────────────────────────────────────
function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash,
    plan: row.plan, sbRunsThisMonth: row.sb_runs_this_month, sbResetMonth: row.sb_reset_month,
    xp: row.xp, streak: row.streak, lastVisit: row.last_visit,
    completedLessons: row.completed_lessons || [],
    passedMissions: row.passed_missions || [],
    teamId: row.team_id || null, teamRole: row.team_role || null,
    isAdmin: row.is_admin || false,
    emailVerified: row.email_verified || false,
    verificationToken: row.verification_token || null,
    passwordResetToken: row.password_reset_token || null,
    passwordResetExpires: row.password_reset_expires || null,
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
  };
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, plan: u.plan,
    sbRunsThisMonth: u.sbRunsThisMonth, xp: u.xp, streak: u.streak,
    lastVisit: u.lastVisit, completedLessons: u.completedLessons,
    passedMissions: u.passedMissions, teamId: u.teamId || null, teamRole: u.teamRole || null,
    isAdmin: u.isAdmin || false, emailVerified: u.emailVerified || false,
  };
}

function rowToTeam(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at,
    settings: row.settings || {}, assignedCategories: row.assigned_categories || {},
  };
}

function rowToMember(row) {
  if (!row) return null;
  return { id: row.id, teamId: row.team_id, userId: row.user_id, role: row.role, joinedAt: row.joined_at };
}

function rowToInvite(row) {
  if (!row) return null;
  return {
    id: row.id, teamId: row.team_id, token: row.token, createdBy: row.created_by,
    label: row.label, createdAt: row.created_at, expiresAt: row.expires_at,
    usedBy: row.used_by, usedAt: row.used_at,
  };
}

function rowToPrompt(row) {
  if (!row) return null;
  return {
    id: row.id, teamId: row.team_id, submittedBy: row.submitted_by, publishedBy: row.published_by,
    title: row.title, prompt: row.prompt, category: row.category, score: row.score,
    status: row.status, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
    submittedAt: row.submitted_at, uses: row.uses,
  };
}

function rowToCert(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, teamId: row.team_id, type: row.type,
    categoryId: row.category_id, categoryName: row.category_name, earnedAt: row.earned_at,
  };
}

// ── Express setup ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());
// Preserve raw body for Stripe webhook signature verification
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { req.rawBody = data; next(); });
  } else {
    express.json()(req, res, next);
  }
});
app.get('/sitemap.xml', (req, res) => { res.setHeader('Content-Type', 'application/xml'); res.sendFile(path.join(__dirname, 'sitemap.xml')); });
app.get('/robots.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'robots.txt')); });
app.get('/Favicon.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.sendFile(path.join(__dirname, 'Favicon.png')); });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'promptcraft.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'promptcraft.html')));
app.get('/privacypolicy', (req, res) => res.redirect(301, '/privacy'));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'promptcraft.html')));
app.get('/termsofservice', (req, res) => res.redirect(301, '/terms'));
app.use(express.static(__dirname));

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function getUser(id) {
  const row = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(row);
}

function requireTeamRole(...roles) {
  return async (req, res, next) => {
    try {
      const user = await getUser(req.user.id);
      if (!user?.teamId) return res.status(403).json({ error: 'Not a team member' });
      if (req.params.teamId && user.teamId !== req.params.teamId)
        return res.status(403).json({ error: 'Wrong team' });
      const memberRow = await queryOne(
        'SELECT * FROM team_members WHERE user_id = $1 AND team_id = $2',
        [user.id, user.teamId]
      );
      if (!memberRow || !roles.includes(memberRow.role))
        return res.status(403).json({ error: 'Insufficient role' });
      req.teamMember = rowToMember(memberRow);
      next();
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  };
}

// ── Seed admin account ────────────────────────────────────────────────────
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await queryOne('SELECT id, is_admin FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) {
    if (!existing.is_admin) await query('UPDATE users SET is_admin = true, plan = $1 WHERE id = $2', ['pro', existing.id]);
    return;
  }
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  await query(
    `INSERT INTO users (id, name, email, password_hash, plan, sb_runs_this_month, sb_reset_month, xp, streak, last_visit, completed_lessons, passed_missions, team_id, team_role, is_admin)
     VALUES ($1,'Admin',$2,$3,'pro',0,$4,0,1,'','[]','[]',NULL,NULL,true)`,
    [id, email.toLowerCase(), passwordHash, monthKey]
  );
}
await ensureAdmin();

// ── Reset monthly runs if month changed ───────────────────────────────────
async function checkMonthReset(user) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  if (user.sbResetMonth !== monthKey) {
    await query('UPDATE users SET sb_runs_this_month = 0, sb_reset_month = $1 WHERE id = $2', [monthKey, user.id]);
    user.sbRunsThisMonth = 0;
    user.sbResetMonth = monthKey;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const verificationToken = randomBytes(32).toString('hex');
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  await query(
    `INSERT INTO users (id, name, email, password_hash, plan, sb_runs_this_month, sb_reset_month, xp, streak, last_visit, completed_lessons, passed_missions, team_id, team_role, email_verified, verification_token)
     VALUES ($1,$2,$3,$4,'free',0,$5,0,0,'','[]','[]',NULL,NULL,false,$6)`,
    [id, name, email.toLowerCase(), passwordHash, monthKey, verificationToken]
  );
  const user = await getUser(id);
  const verifyUrl = `${BASE_URL}/api/verify-email?token=${verificationToken}`;
  await sendEmail(email.toLowerCase(), 'Verify your PromptlyPerfect email',
    `<p>Hi ${name},</p><p>Thanks for signing up for PromptlyPerfect! Click below to verify your email address.</p><p><a href="${verifyUrl}" style="background:#6C63FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Verify Email</a></p><p>Or copy this link: ${verifyUrl}</p>`);
  const token = jwt.sign({ id, email: user.email, name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const row = await queryOne('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!row) return res.status(401).json({ error: 'Invalid email or password' });
  const user = rowToUser(row);
  if (!user.passwordHash) return res.status(401).json({ error: 'No password set for this account. Use "Forgot password?" to create one, or sign in with Google or Microsoft.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  await checkMonthReset(user);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

// GET /api/me
app.get('/api/me', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await checkMonthReset(user);
  res.json(publicUser(user));
});

// PUT /api/me/progress
app.put('/api/me/progress', requireAuth, async (req, res) => {
  const { xp, streak, lastVisit, completedLessons, passedMissions } = req.body;
  const updates = [];
  const vals = [];
  let i = 1;
  if (xp !== undefined) { updates.push(`xp = $${i++}`); vals.push(xp); }
  if (streak !== undefined) { updates.push(`streak = $${i++}`); vals.push(streak); }
  if (lastVisit !== undefined) { updates.push(`last_visit = $${i++}`); vals.push(lastVisit); }
  if (completedLessons !== undefined) { updates.push(`completed_lessons = $${i++}`); vals.push(JSON.stringify(completedLessons)); }
  if (passedMissions !== undefined) { updates.push(`passed_missions = $${i++}`); vals.push(JSON.stringify(passedMissions)); }
  if (updates.length) {
    vals.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`, vals);
  }
  res.json({ success: true });
});

// PUT /api/me/profile
app.put('/api/me/profile', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, currentPassword, newPassword } = req.body;
  const updates = [];
  const vals = [];
  let i = 1;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.push(`name = $${i++}`); vals.push(name.trim());
  }
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    if (!user.passwordHash) return res.status(400).json({ error: 'Cannot set password for social login accounts' });
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const hash = await bcrypt.hash(newPassword, 10);
    updates.push(`password_hash = $${i++}`); vals.push(hash);
  }
  if (updates.length) {
    vals.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`, vals);
  }
  const updated = await getUser(req.user.id);
  res.json({ success: true, name: updated.name });
});

// POST /api/sandbox/run
app.post('/api/sandbox/run', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await checkMonthReset(user);
  const limit = (user.plan === 'pro' || user.teamId) ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit)
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  const { systemPrompt, userText } = req.body;
  if (!systemPrompt || !userText) return res.status(400).json({ error: 'systemPrompt and userText are required' });
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 8096,
      system: systemPrompt, messages: [{ role: 'user', content: userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');
    const newRuns = user.sbRunsThisMonth + 1;
    await query('UPDATE users SET sb_runs_this_month = $1 WHERE id = $2', [newRuns, user.id]);
    res.json({ result: text, sbRunsThisMonth: newRuns, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// POST /api/sandbox/dissect
app.post('/api/sandbox/dissect', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await checkMonthReset(user);
  const limit = (user.plan === 'pro' || user.teamId) ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit)
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  const { userText } = req.body;
  if (!userText) return res.status(400).json({ error: 'userText is required' });
  const systemPrompt = `You are an AI teaching assistant for prompt engineering.
Your task is to dissect a user-provided prompt to identify its core components: Role, Format, Tone, Constraint, and Context.
Output exactly a JSON object, with no markdown wrappers or extra text.
The object should have these keys (only include a key if you genuinely find that component in the prompt):
- "role": The portion of the text setting the persona, e.g. "Act as a senior software engineer".
- "format": The portion specifying output structure, e.g. "Create a bulleted list".
- "tone": Tone/voice direction, e.g. "Professional and encouraging".
- "constraint": Explicit limits, e.g. "Under 100 words" or "No jargon".
- "context": Background information, targeting info, or scenario details.

Only extract the exact substrings or slight functional paraphrases from the text.
Example valid output format:
{"role": "You are a senior UX designer", "format": "create a quick bulleted list", "constraint": "Limit to top 3 issues"}
If none of these are strongly clear, return an empty object {}.`;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      system: systemPrompt, messages: [{ role: 'user', content: 'Prompt to dissect: ' + userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');
    let parsed;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch { throw new Error('Claude did not return valid JSON'); }
    const newRuns = user.sbRunsThisMonth + 1;
    await query('UPDATE users SET sb_runs_this_month = $1 WHERE id = $2', [newRuns, user.id]);
    res.json({ result: parsed, sbRunsThisMonth: newRuns, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// ── Content filter ────────────────────────────────────────────────────────
const BLOCKED_TERMS = [
  'kill','murder','rape','suicide','bomb','terrorist','weapon','shoot','stab','attack',
  'nazi','genocide','slur',
  'porn','nude','naked','sex','explicit','nsfw','erotic','fetish','masturbat',
  'social security','credit card','phishing','scam','hack','malware','password',
  'cocaine','heroin','meth','fentanyl','drug deal',
];
function isAppropriate(text) {
  const lower = text.toLowerCase();
  return !BLOCKED_TERMS.some(term => lower.includes(term));
}

// GET /api/library
app.get('/api/library', async (req, res) => {
  const result = await query('SELECT * FROM community_prompts ORDER BY published_at DESC');
  res.json(result.rows.map(r => ({
    id: r.id, cat: r.cat, title: r.title, prompt: r.prompt,
    score: r.score, uses: r.uses, publishedBy: r.published_by, publishedAt: r.published_at,
  })));
});

// POST /api/library
app.post('/api/library', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) {
    const teamRow = await queryOne('SELECT settings FROM teams WHERE id = $1', [user.teamId]);
    if (teamRow?.settings?.blockCommunityPublish)
      return res.status(403).json({ error: 'Community publishing disabled by your team admin' });
  }
  if (user.plan !== 'pro' && !user.teamId) return res.status(403).json({ error: 'Pro plan required to publish prompts' });
  const { prompt, title, category, score } = req.body;
  if (!prompt || !title || !category) return res.status(400).json({ error: 'prompt, title, and category are required' });
  if (!score || score < 90) return res.status(400).json({ error: 'Only prompts scoring 90 or above can be published' });
  if (!isAppropriate(prompt) || !isAppropriate(title))
    return res.status(422).json({ error: 'Prompt contains inappropriate content and cannot be published' });
  const id = 'u_' + randomUUID();
  const titleTrimmed = title.trim().substring(0, 80);
  const publishedAt = new Date().toISOString();
  await query(
    'INSERT INTO community_prompts (id, cat, title, prompt, score, uses, published_by, published_at) VALUES ($1,$2,$3,$4,$5,0,$6,$7)',
    [id, category, titleTrimmed, prompt.trim(), score, user.name, publishedAt]
  );
  const entry = { id, cat: category, title: titleTrimmed, prompt: prompt.trim(), score, uses: 0, publishedBy: user.name, publishedAt };
  res.json({ success: true, entry });
});

// ── Teams ─────────────────────────────────────────────────────────────────

// POST /api/teams
app.post('/api/teams', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: 'Already on a team' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
  const teamId = 'team_' + randomUUID();
  const settings = { showStreaks: true, showXP: true, leaderboardType: 'team', blockCommunityPublish: false, requirePromptApproval: true };
  const createdAt = new Date().toISOString();
  await query(
    'INSERT INTO teams (id, name, owner_id, created_at, settings, assigned_categories) VALUES ($1,$2,$3,$4,$5,$6)',
    [teamId, name.trim(), user.id, createdAt, JSON.stringify(settings), JSON.stringify({})]
  );
  const memberId = 'tm_' + randomUUID();
  await query(
    'INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5)',
    [memberId, teamId, user.id, 'owner', new Date().toISOString()]
  );
  await query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [teamId, 'owner', user.id]);
  const team = { id: teamId, name: name.trim(), ownerId: user.id, createdAt, settings, assignedCategories: {} };
  res.json({ team, role: 'owner' });
});

// GET /api/teams/mine
app.get('/api/teams/mine', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.teamId) return res.json({ team: null });
  const teamRow = await queryOne('SELECT * FROM teams WHERE id = $1', [user.teamId]);
  if (!teamRow) return res.json({ team: null });
  const team = rowToTeam(teamRow);
  const memberRow = await queryOne('SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2', [user.id, user.teamId]);
  const countRes = await query('SELECT COUNT(*) FROM team_members WHERE team_id = $1', [user.teamId]);
  const memberCount = parseInt(countRes.rows[0].count);
  const settingDefaults = { showStreaks: true, showXP: true, leaderboardType: 'team', blockCommunityPublish: false, requirePromptApproval: true, enableTeamLibrary: true };
  const teamWithDefaults = { ...team, settings: { ...settingDefaults, ...team.settings } };
  res.json({ team: teamWithDefaults, role: memberRow?.role || 'member', memberCount });
});

// PUT /api/teams/:teamId/settings
app.put('/api/teams/:teamId/settings', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const teamRow = await queryOne('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
  if (!teamRow) return res.status(404).json({ error: 'Team not found' });
  const team = rowToTeam(teamRow);
  const allowed = ['showStreaks','showXP','leaderboardType','blockCommunityPublish','requirePromptApproval','enableTeamLibrary'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) team.settings[k] = req.body[k];
  }
  await query('UPDATE teams SET settings = $1 WHERE id = $2', [JSON.stringify(team.settings), req.params.teamId]);
  res.json({ success: true, settings: team.settings });
});

// PUT /api/teams/:teamId/name
app.put('/api/teams/:teamId/name', requireAuth, (req, res, next) => requireTeamRole('owner')(req, res, next), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
  await query('UPDATE teams SET name = $1 WHERE id = $2', [name.trim(), req.params.teamId]);
  res.json({ success: true, name: name.trim() });
});

// PUT /api/teams/:teamId/categories
app.put('/api/teams/:teamId/categories', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { assignedCategories } = req.body;
  if (assignedCategories && typeof assignedCategories === 'object') {
    await query('UPDATE teams SET assigned_categories = $1 WHERE id = $2', [JSON.stringify(assignedCategories), req.params.teamId]);
  }
  res.json({ success: true, assignedCategories });
});

// ── Invites ───────────────────────────────────────────────────────────────

// POST /api/teams/:teamId/invites
app.post('/api/teams/:teamId/invites', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { label } = req.body;
  const token = randomBytes(32).toString('hex');
  const id = 'inv_' + randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  await query(
    'INSERT INTO team_invites (id, team_id, token, created_by, label, created_at, expires_at, used_by, used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)',
    [id, req.params.teamId, token, req.user.id, label || '', createdAt, expiresAt]
  );
  const invite = { id, teamId: req.params.teamId, token, createdBy: req.user.id, label: label || '', createdAt, expiresAt, usedBy: null, usedAt: null };
  res.json({ invite, link: `/?invite=${token}` });
});

// POST /api/teams/:teamId/invites/bulk
app.post('/api/teams/:teamId/invites/bulk', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { labels } = req.body;
  if (!Array.isArray(labels) || labels.length === 0) return res.status(400).json({ error: 'labels array required' });
  if (labels.length > 50) return res.status(400).json({ error: 'Maximum 50 invites at once' });
  const invites = [];
  for (const label of labels) {
    const token = randomBytes(32).toString('hex');
    const id = 'inv_' + randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    await query(
      'INSERT INTO team_invites (id, team_id, token, created_by, label, created_at, expires_at, used_by, used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)',
      [id, req.params.teamId, token, req.user.id, label || '', createdAt, expiresAt]
    );
    invites.push({ id, teamId: req.params.teamId, token, createdBy: req.user.id, label: label || '', createdAt, expiresAt, usedBy: null, usedAt: null });
  }
  res.json({ invites: invites.map(inv => ({ ...inv, link: `/?invite=${inv.token}` })) });
});

// POST /api/teams/:teamId/invites/send-email
app.post('/api/teams/:teamId/invites/send-email', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });
  if (emails.length > 20) return res.status(400).json({ error: 'Maximum 20 invites at once' });

  // Get team name for the email
  const teamRow = await queryOne('SELECT name FROM teams WHERE id = $1', [req.params.teamId]);
  const teamName = teamRow ? teamRow.name : 'a team';
  const inviterName = req.user.name || req.user.email;

  const results = [];
  for (const rawEmail of emails) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ email, success: false, error: 'Invalid email address' });
      continue;
    }
    try {
      const token = randomBytes(32).toString('hex');
      const id = 'inv_' + randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      await query(
        'INSERT INTO team_invites (id, team_id, token, created_by, label, created_at, expires_at, used_by, used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)',
        [id, req.params.teamId, token, req.user.id, email, createdAt, expiresAt]
      );
      const inviteLink = `${BASE_URL}/?invite=${token}`;
      await sendEmail(email, `You've been invited to join ${teamName} on PromptlyPerfect`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#111">You're invited!</h2>
          <p>${inviterName} has invited you to join <strong>${teamName}</strong> on PromptlyPerfect.</p>
          <p>PromptlyPerfect is an AI-powered platform for learning how to write better prompts and work more effectively with AI tools.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${inviteLink}" style="background:#6366f1;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">Accept Invitation →</a>
          </div>
          <p style="color:#888;font-size:12px">This invite link expires in 30 days. If you didn't expect this email, you can safely ignore it.</p>
        </div>`
      );
      results.push({ email, success: true });
    } catch (e) {
      results.push({ email, success: false, error: 'Failed to send' });
    }
  }
  res.json({ results });
});

// GET /api/teams/:teamId/invites
app.get('/api/teams/:teamId/invites', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const now = new Date().toISOString();
  const result = await query(
    'SELECT * FROM team_invites WHERE team_id = $1 AND used_by IS NULL AND expires_at > $2',
    [req.params.teamId, now]
  );
  res.json(result.rows.map(r => ({ ...rowToInvite(r), link: `/?invite=${r.token}` })));
});

// DELETE /api/teams/:teamId/invites/:inviteId
app.delete('/api/teams/:teamId/invites/:inviteId', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const result = await query('DELETE FROM team_invites WHERE id = $1 AND team_id = $2', [req.params.inviteId, req.params.teamId]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
  res.json({ success: true });
});

// GET /api/invites/:token
app.get('/api/invites/:token', async (req, res) => {
  const row = await queryOne('SELECT * FROM team_invites WHERE token = $1', [req.params.token]);
  if (!row) return res.json({ valid: false, reason: 'Invalid invite link' });
  if (row.used_by) return res.json({ valid: false, reason: 'This invite has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.json({ valid: false, reason: 'This invite has expired' });
  const teamRow = await queryOne('SELECT name FROM teams WHERE id = $1', [row.team_id]);
  const creatorRow = await queryOne('SELECT name FROM users WHERE id = $1', [row.created_by]);
  res.json({ valid: true, teamName: teamRow?.name || 'Unknown Team', inviterName: creatorRow?.name || 'Someone' });
});

// POST /api/invites/:token/accept
app.post('/api/invites/:token/accept', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: 'Already on a team' });
  const row = await queryOne('SELECT * FROM team_invites WHERE token = $1', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Invalid invite link' });
  if (row.used_by) return res.status(410).json({ error: 'This invite has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });
  const teamSettingsRow = await queryOne('SELECT settings FROM teams WHERE id = $1', [row.team_id]);
  const maxMembers = teamSettingsRow?.settings?.maxMembers;
  if (maxMembers) {
    const countRes = await query('SELECT COUNT(*) FROM team_members WHERE team_id = $1', [row.team_id]);
    const current = parseInt(countRes.rows[0].count);
    if (current >= maxMembers) return res.status(403).json({ error: `This team is full (${maxMembers} member limit)` });
  }
  const memberId = 'tm_' + randomUUID();
  await query(
    'INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5)',
    [memberId, row.team_id, user.id, 'member', new Date().toISOString()]
  );
  await query('UPDATE team_invites SET used_by = $1, used_at = $2 WHERE id = $3', [user.id, new Date().toISOString(), row.id]);
  await query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [row.team_id, 'member', user.id]);
  const teamRow = await queryOne('SELECT * FROM teams WHERE id = $1', [row.team_id]);
  res.json({ success: true, team: rowToTeam(teamRow), role: 'member' });
});

// ── Members ───────────────────────────────────────────────────────────────

// GET /api/teams/:teamId/members
app.get('/api/teams/:teamId/members', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), async (req, res) => {
  const membersResult = await query('SELECT * FROM team_members WHERE team_id = $1', [req.params.teamId]);
  const result = [];
  for (const m of membersResult.rows) {
    const u = await getUser(m.user_id);
    if (!u) continue;
    result.push({
      id: u.id, name: u.name, role: m.role, joinedAt: m.joined_at,
      lastVisit: u.lastVisit, streak: u.streak || 0, xp: u.xp || 0,
      lessonsCompleted: (u.completedLessons || []).length,
      missionsPassed: (u.passedMissions || []).length,
    });
  }
  res.json(result);
});

// PUT /api/teams/:teamId/members/:userId/role
app.put('/api/teams/:teamId/members/:userId/role', requireAuth, (req, res, next) => requireTeamRole('owner')(req, res, next), async (req, res) => {
  const { role } = req.body;
  if (!['admin','member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member' });
  const teamRow = await queryOne('SELECT owner_id FROM teams WHERE id = $1', [req.params.teamId]);
  if (req.params.userId === teamRow?.owner_id) return res.status(400).json({ error: 'Cannot change owner role' });
  const result = await query(
    'UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = $3',
    [role, req.params.userId, req.params.teamId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found' });
  await query('UPDATE users SET team_role = $1 WHERE id = $2', [role, req.params.userId]);
  res.json({ success: true, role });
});

// DELETE /api/teams/:teamId/members/:userId
app.delete('/api/teams/:teamId/members/:userId', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const teamRow = await queryOne('SELECT owner_id FROM teams WHERE id = $1', [req.params.teamId]);
  if (req.params.userId === teamRow?.owner_id) return res.status(400).json({ error: 'Cannot remove the team owner' });
  const result = await query(
    'DELETE FROM team_members WHERE user_id = $1 AND team_id = $2',
    [req.params.userId, req.params.teamId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found' });
  await query('UPDATE users SET team_id = NULL, team_role = NULL WHERE id = $1', [req.params.userId]);
  res.json({ success: true });
});

// DELETE /api/teams/leave
app.delete('/api/teams/leave', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.teamId) return res.status(400).json({ error: 'Not on a team' });
  const teamRow = await queryOne('SELECT owner_id FROM teams WHERE id = $1', [user.teamId]);
  if (teamRow?.owner_id === user.id) return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
  await query('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [user.id, user.teamId]);
  await query('UPDATE users SET team_id = NULL, team_role = NULL WHERE id = $1', [user.id]);
  res.json({ success: true });
});

// ── Team Analytics ────────────────────────────────────────────────────────

// GET /api/teams/:teamId/analytics
app.get('/api/teams/:teamId/analytics', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const membersResult = await query('SELECT user_id FROM team_members WHERE team_id = $1', [req.params.teamId]);
  if (membersResult.rows.length === 0) return res.json({ completionRate: 0, categoryBreakdown: [], topPerformers: [] });
  const users = [];
  for (const m of membersResult.rows) {
    const u = await getUser(m.user_id);
    if (u) users.push(u);
  }
  const totalLessons = 13;
  const completionRates = users.map(u => (u.completedLessons || []).length / totalLessons);
  const avgCompletion = completionRates.reduce((a, b) => a + b, 0) / users.length;
  const categories = ['core','writing','code','research','marketing','productivity','learning','data','design','hr','legal','finance','selfdev'];
  const categoryBreakdown = categories.map(cat => {
    const avgPct = users.reduce((sum, u) => {
      const done = (u.completedLessons || []).filter(l => l.startsWith(cat[0])).length;
      return sum + done;
    }, 0) / users.length;
    return { categoryId: cat, avgPct: Math.round(avgPct * 100) };
  });
  const topPerformers = users
    .map(u => ({ id: u.id, name: u.name, xp: u.xp || 0, lessonsCompleted: (u.completedLessons||[]).length }))
    .sort((a, b) => b.xp - a.xp).slice(0, 5);
  const members = users.map(u => ({
    id: u.id, name: u.name, xp: u.xp || 0,
    lessonsCompleted: (u.completedLessons || []).length,
    missionsPassed: (u.passedMissions || []).length,
    streak: u.streak || 0,
    lastVisit: u.lastVisit || '',
  }));
  res.json({ completionRate: Math.round(avgCompletion * 100), categoryBreakdown, topPerformers, members });
});

// ── Team Prompt Library ───────────────────────────────────────────────────

// GET /api/teams/:teamId/prompts
app.get('/api/teams/:teamId/prompts', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), async (req, res) => {
  const isAdminOrOwner = ['owner','admin'].includes(req.teamMember.role);
  const result = isAdminOrOwner
    ? await query('SELECT * FROM team_prompts WHERE team_id = $1 ORDER BY submitted_at DESC', [req.params.teamId])
    : await query('SELECT * FROM team_prompts WHERE team_id = $1 AND status = $2 ORDER BY submitted_at DESC', [req.params.teamId, 'approved']);
  res.json(result.rows.map(rowToPrompt));
});

// POST /api/teams/:teamId/prompts
app.post('/api/teams/:teamId/prompts', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), async (req, res) => {
  const { title, prompt, category, score } = req.body;
  if (!title || !prompt || !category) return res.status(400).json({ error: 'title, prompt, category required' });
  if (!score || score < 85) return res.status(400).json({ error: 'Score must be 85 or above' });
  if (!isAppropriate(prompt) || !isAppropriate(title)) return res.status(422).json({ error: 'Content contains inappropriate material' });
  const teamRow = await queryOne('SELECT settings FROM teams WHERE id = $1', [req.params.teamId]);
  const status = teamRow?.settings?.requirePromptApproval ? 'pending' : 'approved';
  const submitter = await getUser(req.user.id);
  const id = 'tp_' + randomUUID();
  const submittedAt = new Date().toISOString();
  const titleTrimmed = title.trim().substring(0, 80);
  await query(
    'INSERT INTO team_prompts (id, team_id, submitted_by, published_by, title, prompt, category, score, status, reviewed_by, reviewed_at, submitted_at, uses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,0)',
    [id, req.params.teamId, req.user.id, submitter?.name || 'Unknown', titleTrimmed, prompt.trim(), category, score, status, submittedAt]
  );
  const entry = { id, teamId: req.params.teamId, submittedBy: req.user.id, publishedBy: submitter?.name || 'Unknown', title: titleTrimmed, prompt: prompt.trim(), category, score, status, reviewedBy: null, reviewedAt: null, submittedAt, uses: 0 };
  res.json({ success: true, entry });
});

// PUT /api/teams/:teamId/prompts/:promptId/review
app.put('/api/teams/:teamId/prompts/:promptId/review', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { action } = req.body;
  if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  const result = await query(
    'UPDATE team_prompts SET status = $1, reviewed_by = $2, reviewed_at = $3 WHERE id = $4 AND team_id = $5',
    [status, req.user.id, new Date().toISOString(), req.params.promptId, req.params.teamId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Prompt not found' });
  res.json({ success: true, status });
});

// DELETE /api/teams/:teamId/prompts/:promptId
app.delete('/api/teams/:teamId/prompts/:promptId', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const promptRow = await queryOne('SELECT * FROM team_prompts WHERE id = $1 AND team_id = $2', [req.params.promptId, req.params.teamId]);
  if (!promptRow) return res.status(404).json({ error: 'Prompt not found' });
  const memberRow = await queryOne('SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2', [user.id, req.params.teamId]);
  if (!memberRow) return res.status(403).json({ error: 'Not a team member' });
  if (!['owner','admin'].includes(memberRow.role) && promptRow.submitted_by !== user.id)
    return res.status(403).json({ error: 'Insufficient permissions' });
  await query('DELETE FROM team_prompts WHERE id = $1', [req.params.promptId]);
  res.json({ success: true });
});

// ── Certificates ──────────────────────────────────────────────────────────

// POST /api/certificates
app.post('/api/certificates', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { type, categoryId, categoryName } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  const existing = await queryOne(
    'SELECT * FROM certificates WHERE user_id = $1 AND type = $2 AND (category_id = $3 OR (category_id IS NULL AND $3::text IS NULL))',
    [user.id, type, categoryId || null]
  );
  if (existing) return res.json({ cert: rowToCert(existing), alreadyExists: true });
  const id = 'cert_' + randomUUID();
  const earnedAt = new Date().toISOString();
  await query(
    'INSERT INTO certificates (id, user_id, team_id, type, category_id, category_name, earned_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, user.id, user.teamId || null, type, categoryId || null, categoryName || null, earnedAt]
  );
  const cert = { id, userId: user.id, teamId: user.teamId || null, type, categoryId: categoryId || null, categoryName: categoryName || null, earnedAt };
  res.json({ cert });
});

// GET /api/certificates/mine
app.get('/api/certificates/mine', requireAuth, async (req, res) => {
  const result = await query('SELECT * FROM certificates WHERE user_id = $1', [req.user.id]);
  res.json(result.rows.map(rowToCert));
});

// ── Admin ─────────────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    const user = await getUser(payload.id);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const { type, name, email, businessName, numAccounts, message } = req.body;
  if (!type || !name || !email) return res.status(400).json({ error: 'type, name, and email are required' });
  const id = 'con_' + randomUUID();
  const createdAt = new Date().toISOString();
  await query(
    'INSERT INTO contact_submissions (id, type, name, email, business_name, num_accounts, message, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, type, name.trim(), email.trim().toLowerCase(), businessName?.trim() || null, numAccounts?.trim() || null, message?.trim() || null, createdAt]
  );
  const label = type === 'teams' ? 'Teams Inquiry' : 'Contact Form';
  const extraRows = [
    businessName ? `<tr><td style="color:#888;padding:4px 0">Business</td><td style="padding:4px 0">${businessName.trim()}</td></tr>` : '',
    numAccounts ? `<tr><td style="color:#888;padding:4px 0">Accounts</td><td style="padding:4px 0">${numAccounts.trim()}</td></tr>` : '',
    message ? `<tr><td style="color:#888;padding:4px 0;vertical-align:top">Message</td><td style="padding:4px 0">${message.trim().replace(/\n/g, '<br>')}</td></tr>` : '',
  ].filter(Boolean).join('');
  await sendEmail('admin@promptlyperfect.com', `[PromptlyPerfect] New ${label} from ${name.trim()}`,
    `<div style="font-family:sans-serif;max-width:520px">
      <h2 style="margin-bottom:16px">New ${label}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="color:#888;padding:4px 0">Name</td><td style="padding:4px 0">${name.trim()}</td></tr>
        <tr><td style="color:#888;padding:4px 0">Email</td><td style="padding:4px 0"><a href="mailto:${email.trim()}">${email.trim()}</a></td></tr>
        ${extraRows}
        <tr><td style="color:#888;padding:4px 0">Submitted</td><td style="padding:4px 0">${new Date(createdAt).toLocaleString()}</td></tr>
      </table>
    </div>`
  );
  res.json({ success: true });
});

// DELETE /api/admin/contacts/:id
app.delete('/api/admin/contacts/:id', requireAdmin, async (req, res) => {
  const result = await query('DELETE FROM contact_submissions WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// GET /api/admin/contacts
app.get('/api/admin/contacts', requireAdmin, async (req, res) => {
  const result = await query('SELECT * FROM contact_submissions ORDER BY created_at DESC');
  res.json(result.rows.map(r => ({
    id: r.id, type: r.type, name: r.name, email: r.email,
    businessName: r.business_name, numAccounts: r.num_accounts,
    message: r.message, createdAt: r.created_at,
  })));
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const result = await query('SELECT * FROM users ORDER BY is_admin DESC, name ASC');
  res.json(result.rows.map(row => {
    const u = rowToUser(row);
    return {
      id: u.id, name: u.name, email: u.email, plan: u.plan, isAdmin: u.isAdmin,
      sbRunsThisMonth: u.sbRunsThisMonth, xp: u.xp, streak: u.streak,
      lastVisit: u.lastVisit,
      lessonsCompleted: (u.completedLessons || []).length,
      missionsPassed: (u.passedMissions || []).length,
      teamId: u.teamId, teamRole: u.teamRole,
    };
  }));
});

// PUT /api/admin/users/:id/plan
app.put('/api/admin/users/:id/plan', requireAdmin, async (req, res) => {
  const { plan } = req.body;
  if (plan !== 'free' && plan !== 'pro') return res.status(400).json({ error: 'Plan must be free or pro' });
  const result = await query('UPDATE users SET plan = $1 WHERE id = $2', [plan, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, plan });
});

// DELETE /api/account  (self-deletion)
app.delete('/api/account', requireAuth, async (req, res) => {
  const userId = req.user.id;
  await query('DELETE FROM certificates WHERE user_id = $1', [userId]);
  await query('DELETE FROM team_members WHERE user_id = $1', [userId]);
  await query('DELETE FROM team_invites WHERE created_by = $1', [userId]);
  await query('DELETE FROM team_prompts WHERE submitted_by = $1', [userId]);
  await query('DELETE FROM users WHERE id = $1', [userId]);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isAdmin) return res.status(400).json({ error: 'Cannot delete admin account' });
  await query('DELETE FROM certificates WHERE user_id = $1', [req.params.id]);
  await query('DELETE FROM team_members WHERE user_id = $1', [req.params.id]);
  await query('DELETE FROM team_invites WHERE created_by = $1', [req.params.id]);
  await query('DELETE FROM team_prompts WHERE submitted_by = $1', [req.params.id]);
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// GET /api/admin/teams
app.get('/api/admin/teams', requireAdmin, async (req, res) => {
  const result = await query(`
    SELECT t.id, t.name, t.owner_id, t.created_at, t.settings,
           u.name AS owner_name, u.email AS owner_email,
           (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::int AS member_count
    FROM teams t JOIN users u ON u.id = t.owner_id
    ORDER BY t.created_at DESC
  `);
  res.json(result.rows.map(r => ({
    id: r.id, name: r.name, ownerId: r.owner_id, ownerName: r.owner_name,
    ownerEmail: r.owner_email, memberCount: r.member_count,
    maxMembers: r.settings?.maxMembers || null, createdAt: r.created_at,
  })));
});

// POST /api/admin/create-team
app.post('/api/admin/create-team', requireAdmin, async (req, res) => {
  const { userId, teamName, maxMembers } = req.body;
  if (!userId || !teamName) return res.status(400).json({ error: 'userId and teamName required' });
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: `${user.name} is already on a team` });
  const max = parseInt(maxMembers) || null;
  const teamId = 'team_' + randomUUID();
  const now = new Date().toISOString();
  const settings = max ? { maxMembers: max } : {};
  await query(
    'INSERT INTO teams (id, name, owner_id, created_at, settings, assigned_categories) VALUES ($1,$2,$3,$4,$5,$6)',
    [teamId, teamName.trim(), userId, now, JSON.stringify(settings), JSON.stringify({})]
  );
  const memberId = 'tm_' + randomUUID();
  await query(
    'INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5)',
    [memberId, teamId, userId, 'owner', now]
  );
  await query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [teamId, 'owner', userId]);
  res.json({ success: true, teamId, teamName: teamName.trim() });
});

// DELETE /api/admin/teams/:id
app.delete('/api/admin/teams/:id', requireAdmin, async (req, res) => {
  const teamId = req.params.id;
  const teamRow = await queryOne('SELECT id FROM teams WHERE id = $1', [teamId]);
  if (!teamRow) return res.status(404).json({ error: 'Team not found' });
  // Detach all members
  await query('UPDATE users SET team_id = NULL, team_role = NULL WHERE team_id = $1', [teamId]);
  await query('DELETE FROM team_members WHERE team_id = $1', [teamId]);
  await query('DELETE FROM team_invites WHERE team_id = $1', [teamId]);
  await query('DELETE FROM team_prompts WHERE team_id = $1', [teamId]);
  await query('DELETE FROM teams WHERE id = $1', [teamId]);
  res.json({ success: true });
});

// GET /api/admin/teams/:id/members
app.get('/api/admin/teams/:id/members', requireAdmin, async (req, res) => {
  const membersResult = await query('SELECT * FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC', [req.params.id]);
  const result = [];
  for (const m of membersResult.rows) {
    const u = await getUser(m.user_id);
    if (!u) continue;
    result.push({ id: u.id, name: u.name, email: u.email, role: m.role, joinedAt: m.joined_at });
  }
  res.json(result);
});

// POST /api/admin/teams/:id/members
app.post('/api/admin/teams/:id/members', requireAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const teamRow = await queryOne('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!teamRow) return res.status(404).json({ error: 'Team not found' });
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: `${user.name} is already on a team` });
  const memberId = 'tm_' + randomUUID();
  await query('INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5)',
    [memberId, req.params.id, userId, 'member', new Date().toISOString()]);
  await query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [req.params.id, 'member', userId]);
  res.json({ success: true });
});

// DELETE /api/admin/teams/:id/members/:userId
app.delete('/api/admin/teams/:id/members/:userId', requireAdmin, async (req, res) => {
  const teamRow = await queryOne('SELECT owner_id FROM teams WHERE id = $1', [req.params.id]);
  if (req.params.userId === teamRow?.owner_id) return res.status(400).json({ error: 'Cannot remove the team owner' });
  const result = await query('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [req.params.userId, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found' });
  await query('UPDATE users SET team_id = NULL, team_role = NULL WHERE id = $1', [req.params.userId]);
  res.json({ success: true });
});

// PUT /api/admin/teams/:id/members/:userId/role
app.put('/api/admin/teams/:id/members/:userId/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member' });
  const teamRow = await queryOne('SELECT owner_id FROM teams WHERE id = $1', [req.params.id]);
  if (req.params.userId === teamRow?.owner_id) return res.status(400).json({ error: 'Cannot change owner role' });
  const result = await query('UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = $3',
    [role, req.params.userId, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found' });
  await query('UPDATE users SET team_role = $1 WHERE id = $2', [role, req.params.userId]);
  res.json({ success: true, role });
});

// PUT /api/admin/teams/:id/max-members
app.put('/api/admin/teams/:id/max-members', requireAdmin, async (req, res) => {
  const { maxMembers } = req.body;
  const max = parseInt(maxMembers) || null;
  const teamRow = await queryOne('SELECT settings FROM teams WHERE id = $1', [req.params.id]);
  if (!teamRow) return res.status(404).json({ error: 'Team not found' });
  const settings = { ...(teamRow.settings || {}), maxMembers: max };
  await query('UPDATE teams SET settings = $1 WHERE id = $2', [JSON.stringify(settings), req.params.id]);
  res.json({ success: true, maxMembers: max });
});

// PUT /api/admin/teams/:id/owner
app.put('/api/admin/teams/:id/owner', requireAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const teamRow = await queryOne('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!teamRow) return res.status(404).json({ error: 'Team not found' });
  const newOwner = await getUser(userId);
  if (!newOwner) return res.status(404).json({ error: 'User not found' });
  const oldOwnerId = teamRow.owner_id;
  if (oldOwnerId === userId) return res.status(400).json({ error: 'User is already the owner' });
  if (newOwner.teamId && newOwner.teamId !== req.params.id)
    return res.status(400).json({ error: `${newOwner.name} is already on a different team` });
  // Demote old owner to member
  await query('UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = $3', ['member', oldOwnerId, req.params.id]);
  await query('UPDATE users SET team_role = $1 WHERE id = $2', ['member', oldOwnerId]);
  // If new owner not yet on this team, add them
  const existingMember = await queryOne('SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2', [userId, req.params.id]);
  if (!existingMember) {
    const memberId = 'tm_' + randomUUID();
    await query('INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5)',
      [memberId, req.params.id, userId, 'owner', new Date().toISOString()]);
    await query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [req.params.id, 'owner', userId]);
  } else {
    await query('UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = $3', ['owner', userId, req.params.id]);
    await query('UPDATE users SET team_role = $1 WHERE id = $2', ['owner', userId]);
  }
  await query('UPDATE teams SET owner_id = $1 WHERE id = $2', [userId, req.params.id]);
  res.json({ success: true, newOwnerId: userId, newOwnerName: newOwner.name });
});

// GET /api/leaderboard?tab=weekly|alltime
app.get('/api/leaderboard', requireAuth, async (req, res) => {
  const tab = req.query.tab === 'alltime' ? 'alltime' : 'weekly';
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sql = tab === 'weekly'
    ? `SELECT id, name, xp, streak, completed_lessons FROM users WHERE last_visit >= $1 ORDER BY xp DESC LIMIT 10`
    : `SELECT id, name, xp, streak, completed_lessons FROM users ORDER BY xp DESC LIMIT 10`;
  const params = tab === 'weekly' ? [sevenDaysAgo] : [];
  const result = await query(sql, params);
  const rows = result.rows.map(r => {
    const lessons = Array.isArray(r.completed_lessons) ? r.completed_lessons.length : 0;
    const badge = lessons >= 15 ? 'Master' : lessons >= 10 ? 'Advanced' : lessons >= 5 ? 'Core' : lessons >= 1 ? 'Foundations' : 'Learner';
    return { id: r.id, name: r.name, xp: r.xp || 0, streak: r.streak || 0, badge };
  });
  res.json(rows);
});

// POST /api/forgot-password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Always respond ok to prevent user enumeration
  const user = await queryOne('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);
  if (user) {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    await query('UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3', [token, expires, user.id]);
    const resetUrl = `${BASE_URL}/?reset_token=${token}`;
    await sendEmail(email.toLowerCase(), 'Reset your PromptlyPerfect password',
      `<p>Hi ${user.name},</p><p>Click below to reset your PromptlyPerfect password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="background:#6C63FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Reset Password</a></p><p>Or copy this link: ${resetUrl}</p><p>If you didn't request this, you can safely ignore this email.</p>`);
  }
  res.json({ success: true });
});

// POST /api/reset-password
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = await queryOne('SELECT id, password_reset_expires FROM users WHERE password_reset_token = $1', [token]);
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (!user.password_reset_expires || new Date(user.password_reset_expires) < new Date())
    return res.status(400).json({ error: 'Reset link has expired' });
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2', [hash, user.id]);
  res.json({ success: true });
});

// GET /api/verify-email?token=xxx
app.get('/api/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/?verified=0');
  const user = await queryOne('SELECT id FROM users WHERE verification_token = $1', [token]);
  if (!user) return res.redirect('/?verified=0');
  await query('UPDATE users SET email_verified = true, verification_token = NULL WHERE id = $1', [user.id]);
  res.redirect('/?verified=1');
});

// POST /api/resend-verification
app.post('/api/resend-verification', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.emailVerified) return res.json({ success: true, alreadyVerified: true });
  const verificationToken = randomBytes(32).toString('hex');
  await query('UPDATE users SET verification_token = $1 WHERE id = $2', [verificationToken, user.id]);
  const verifyUrl = `${BASE_URL}/api/verify-email?token=${verificationToken}`;
  await sendEmail(user.email, 'Verify your PromptlyPerfect email',
    `<p>Hi ${user.name},</p><p>Click below to verify your email address.</p><p><a href="${verifyUrl}" style="background:#6C63FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Verify Email</a></p><p>Or copy this link: ${verifyUrl}</p>`);
  res.json({ success: true });
});

// GET /cert/:id — public shareable certificate page
app.get('/cert/:id', async (req, res) => {
  const row = await queryOne('SELECT c.*, u.name AS user_name FROM certificates c JOIN users u ON u.id = c.user_id WHERE c.id = $1', [req.params.id]);
  if (!row) return res.status(404).send('<h1>Certificate not found</h1>');
  const earnedDate = new Date(row.earned_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PromptlyPerfect Certificate — ${row.user_name}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f13;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.frame{background:#1a1a24;border:2px solid #6C63FF;border-radius:16px;padding:56px 48px;max-width:540px;width:100%;text-align:center;position:relative}.label{font-size:11px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:#888;margin-bottom:28px}.name{font-size:36px;font-weight:800;color:#fff;margin-bottom:10px}.sub{font-size:13px;color:#888;margin-bottom:10px}.track{font-size:22px;font-weight:700;color:#6C63FF;margin-bottom:24px}.divider{width:60px;height:2px;background:#6C63FF;margin:0 auto 20px}.date{font-size:13px;color:#888;margin-bottom:8px}.certid{font-size:10px;color:#555;margin-bottom:28px}.brand{font-size:13px;font-weight:700;color:#6C63FF;margin-top:8px}@media print{body{background:#fff}.frame{border-color:#6C63FF;background:#fff}.name,.brand{color:#6C63FF}.sub,.date,.certid{color:#666}.label{color:#999}}</style></head><body><div class="frame"><div class="label">Certificate of Completion</div><div class="name">${row.user_name}</div><div class="sub">has successfully completed</div><div class="track">${row.category_name || row.category_id || 'Prompt Engineering'}</div><div class="divider"></div><div class="date">Completed on ${earnedDate}</div><div class="certid">Certificate ID: ${row.id}</div><div class="brand">PromptlyPerfect</div></div></body></html>`);
});

// ── OAuth ─────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

async function oauthFindOrCreateUser(email, name) {
  const existing = await queryOne('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) return rowToUser(existing);
  const id = randomUUID();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  await query(
    `INSERT INTO users (id, name, email, password_hash, plan, sb_runs_this_month, sb_reset_month, xp, streak, last_visit, completed_lessons, passed_missions, team_id, team_role, email_verified)
     VALUES ($1,$2,$3,NULL,'free',0,$4,0,0,'','[]','[]',NULL,NULL,true)`,
    [id, name, email.toLowerCase(), monthKey]
  );
  return await getUser(id);
}

// GET /auth/google
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/google/callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth_error=1');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?auth_error=1');
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await userRes.json();
    if (!profile.email) return res.redirect('/?auth_error=1');
    const user = await oauthFindOrCreateUser(profile.email, profile.name || profile.email.split('@')[0]);
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`/?token=${token}`);
  } catch { res.redirect('/?auth_error=1'); }
});

// GET /auth/microsoft
app.get('/auth/microsoft', (req, res) => {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/microsoft/callback`,
    response_type: 'code',
    scope: 'openid email profile User.Read',
    response_mode: 'query',
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

// GET /auth/microsoft/callback
app.get('/auth/microsoft/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth_error=1');
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/microsoft/callback`, grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?auth_error=1');
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await userRes.json();
    const email = profile.mail || profile.userPrincipalName;
    if (!email) return res.redirect('/?auth_error=1');
    const user = await oauthFindOrCreateUser(email, profile.displayName || email.split('@')[0]);
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`/?token=${token}`);
  } catch { res.redirect('/?auth_error=1'); }
});

// ── Stripe ────────────────────────────────────────────────────────────────

// POST /api/stripe/create-checkout
app.post('/api/stripe/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return res.status(503).json({ error: 'Stripe price not configured' });

  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.plan === 'pro') return res.status(400).json({ error: 'Already on Pro plan' });

  // Reuse or create Stripe customer
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
    customerId = customer.id;
    await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${BASE_URL}/?upgraded=1`,
    cancel_url: `${BASE_URL}/?upgraded=0`,
    metadata: { userId: user.id },
  });

  res.json({ url: session.url });
});

// POST /api/stripe/webhook
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'Webhook secret not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe] Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const userId = obj.metadata?.userId;
    const subscriptionId = obj.subscription;
    if (userId && subscriptionId) {
      await query(
        'UPDATE users SET plan = $1, stripe_subscription_id = $2 WHERE id = $3',
        ['pro', subscriptionId, userId]
      );
      console.log('[stripe] Upgraded user to pro:', userId);
    }
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
    const customerId = obj.customer;
    if (customerId) {
      await query(
        'UPDATE users SET plan = $1, stripe_subscription_id = NULL WHERE stripe_customer_id = $2',
        ['free', customerId]
      );
      console.log('[stripe] Downgraded customer to free:', customerId);
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const customerId = obj.customer;
    console.log('[stripe] Payment failed for customer:', customerId);
    // Don't downgrade immediately — Stripe will retry and eventually send subscription.deleted
  }

  res.json({ received: true });
});

// POST /api/stripe/cancel
app.post('/api/stripe/cancel', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.plan !== 'pro') return res.status(400).json({ error: 'Not on Pro plan' });
  if (!user.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription found' });

  // Cancel at period end so user keeps access until billing cycle ends
  await stripe.subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
  res.json({ success: true, message: 'Subscription will cancel at end of billing period' });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`PromptlyPerfect server running at http://localhost:${PORT}`));
}

export default app;

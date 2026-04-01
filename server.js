import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (no dotenv needed for simple case) ─────────────────
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

const JWT_SECRET = process.env.JWT_SECRET || 'promptcraft-secret-change-me';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FREE_RUN_LIMIT = 10;
const PRO_RUN_LIMIT = 140;

// ── Database ──────────────────────────────────────────────────────────────
const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: [], communityPrompts: [] });
await db.read();
if (!db.data.communityPrompts) db.data.communityPrompts = [];

// ── Express setup ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve promptcraft.html at the root and as a static fallback
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'promptcraft.html')));
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

function getUser(id) {
  return db.data.users.find(u => u.id === id);
}

// ── Reset monthly runs if month changed ───────────────────────────────────
function checkMonthReset(user) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  if (user.sbResetMonth !== monthKey) {
    user.sbRunsThisMonth = 0;
    user.sbResetMonth = monthKey;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (db.data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const user = { id, name, email: email.toLowerCase(), passwordHash, plan: 'free', sbRunsThisMonth: 0, sbResetMonth: monthKey, xp: 0, streak: 1, lastVisit: '', completedLessons: [], passedMissions: [] };
  db.data.users.push(user);
  await db.write();
  const token = jwt.sign({ id, email: user.email, name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions } });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.data.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  checkMonthReset(user);
  await db.write();
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions } });
});

// GET /api/me
app.get('/api/me', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);
  await db.write();
  res.json({ id: user.id, name: user.name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions });
});

// PUT /api/me/progress
app.put('/api/me/progress', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { xp, streak, lastVisit, completedLessons, passedMissions } = req.body;
  if (xp !== undefined) user.xp = xp;
  if (streak !== undefined) user.streak = streak;
  if (lastVisit !== undefined) user.lastVisit = lastVisit;
  if (completedLessons !== undefined) user.completedLessons = completedLessons;
  if (passedMissions !== undefined) user.passedMissions = passedMissions;
  
  await db.write();
  res.json({ success: true });
});

// PUT /api/me/plan — toggle between free and pro (dev/demo toggle)
app.put('/api/me/plan', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { plan } = req.body;
  if (plan !== 'free' && plan !== 'pro') return res.status(400).json({ error: 'Plan must be "free" or "pro"' });
  user.plan = plan;
  await db.write();
  const limit = plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  res.json({ plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, limit });
});

// POST /api/sandbox/run  — proxy to Claude + enforce monthly limit
app.post('/api/sandbox/run', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);

  const limit = user.plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit) {
    await db.write();
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  }

  const { systemPrompt, userText } = req.body;
  if (!systemPrompt || !userText) return res.status(400).json({ error: 'systemPrompt and userText are required' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');

    user.sbRunsThisMonth++;
    await db.write();
    res.json({ result: text, sbRunsThisMonth: user.sbRunsThisMonth, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// POST /api/sandbox/dissect  — proxy to Claude to dissect a prompt
app.post('/api/sandbox/dissect', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);

  const limit = user.plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit) {
    await db.write();
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  }

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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Prompt to dissect: ' + userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');

    let parsed;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch(e) {
      throw new Error('Claude did not return valid JSON');
    }

    user.sbRunsThisMonth++;
    await db.write();
    res.json({ result: parsed, sbRunsThisMonth: user.sbRunsThisMonth, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// ── Content filter ────────────────────────────────────────────────────────
const BLOCKED_TERMS = [
  // Violence / harm
  'kill','murder','rape','suicide','bomb','terrorist','weapon','shoot','stab','attack',
  // Hate / slurs (abbreviated to avoid listing them here)
  'nazi','genocide','slur',
  // Sexual / explicit
  'porn','nude','naked','sex','explicit','nsfw','erotic','fetish','masturbat',
  // Personal data / scams
  'social security','credit card','phishing','scam','hack','malware','password',
  // Drugs
  'cocaine','heroin','meth','fentanyl','drug deal',
];
function isAppropriate(text) {
  const lower = text.toLowerCase();
  return !BLOCKED_TERMS.some(term => lower.includes(term));
}

// GET /api/library — public community prompts
app.get('/api/library', (req, res) => {
  res.json(db.data.communityPrompts);
});

// POST /api/library — publish a prompt (pro only, score > 90, content filter)
app.post('/api/library', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.plan !== 'pro') return res.status(403).json({ error: 'Pro plan required to publish prompts' });

  const { prompt, title, category, score } = req.body;
  if (!prompt || !title || !category) return res.status(400).json({ error: 'prompt, title, and category are required' });
  if (!score || score < 90) return res.status(400).json({ error: 'Only prompts scoring 90 or above can be published' });
  if (!isAppropriate(prompt) || !isAppropriate(title)) {
    return res.status(422).json({ error: 'Prompt contains inappropriate content and cannot be published' });
  }

  const entry = {
    id: 'u_' + crypto.randomUUID(),
    cat: category,
    title: title.trim().substring(0, 80),
    prompt: prompt.trim(),
    score,
    uses: 0,
    publishedBy: user.name,
    publishedAt: new Date().toISOString(),
  };
  db.data.communityPrompts.unshift(entry);
  await db.write();
  res.json({ success: true, entry });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PromptCraft server running at http://localhost:${PORT}`));

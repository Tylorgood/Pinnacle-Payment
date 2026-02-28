require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pinnacle-integrated-secret-key';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:10000';

const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;

async function runWebSearch(query, options) {
  return { results: [], error: 'Search not configured' };
}
function shouldTriggerSearch(prompt) { return false; }
function extractSearchQuery(prompt) { return null; }
function buildSearchContext(results) { return ''; }
function addSourceCitations(response, sources) { return response; }
function formatSourcesForDisplay(results) { return []; }

async function runOperatorTask(objective, url, options) {
  return { success: false, error: 'Operator not configured' };
}
function checkOperatorStatus(taskId) { return { status: 'unknown' }; }
function shouldUseOperator(prompt) { return false; }
function extractOperatorTask(prompt) { return null; }
function getOperatorCost() { return 5; }
const OPERATOR_COST_PER_TASK = 5;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

let db;

async function initDatabase() {
  const SQL = await initSqlJs();
  
  const dbPath = path.join(__dirname, 'pinnacle.db');
  
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      stripe_customer_id TEXT,
      subscription_id TEXT,
      subscription_status TEXT DEFAULT 'inactive',
      tokens_total INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      reset_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      action TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT UNIQUE NOT NULL,
      label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS search_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credits_total INTEGER DEFAULT 0,
      credits_used INTEGER DEFAULT 0,
      purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT,
      results_count INTEGER,
      credits_used INTEGER,
      sources TEXT,
      response_time_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS operator_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credits_total INTEGER DEFAULT 0,
      credits_used INTEGER DEFAULT 0,
      purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS operator_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      objective TEXT,
      url TEXT,
      success INTEGER,
      steps_taken INTEGER,
      duration_ms INTEGER,
      credits_used INTEGER,
      result_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  saveDatabase();
  console.log('Database initialized');
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'pinnacle.db'), buffer);
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function resetTokensIfNeeded(user) {
  if (!user || !user.reset_date) return user;
  
  const now = new Date();
  const resetDate = new Date(user.reset_date);
  
  if (now >= resetDate) {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);
    nextMonth.setHours(0, 0, 0, 0);
    
    run(`UPDATE users SET tokens_used = 0, reset_date = ? WHERE id = ?`, 
      [nextMonth.toISOString(), user.id]);
    
    return { ...user, tokens_used: 0, reset_date: nextMonth };
  }
  return user;
}

function getTokenCost(promptLength, responseLength) {
  const inputTokens = Math.ceil(promptLength / 4);
  const outputTokens = Math.ceil(responseLength / 4);
  const totalTokens = inputTokens + outputTokens;
  return Math.max(10, totalTokens);
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const existing = get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);
    resetDate.setDate(1);
    
    let stripeCustomerId = null;
    if (stripe) {
      try {
        const customer = await stripe.customers.create({ email });
        stripeCustomerId = customer.id;
      } catch (e) {
        console.log('Stripe not configured');
      }
    }
    
    run(`INSERT INTO users (email, password, stripe_customer_id, tokens_total, tokens_used, reset_date)
         VALUES (?, ?, ?, 0, 0, ?)`,
      [email, hashedPassword, stripeCustomerId, resetDate.toISOString()]);
    
    const user = get('SELECT id, email FROM users WHERE email = ?', [email]);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    run(`INSERT INTO search_credits (user_id, credits_total, credits_used) VALUES (?, 5, 0)`, [user.id]);
    run(`INSERT INTO operator_credits (user_id, credits_total, credits_used) VALUES (?, 10, 0)`, [user.id]);
    
    res.json({ token, user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/user/me', authenticate, (req, res) => {
  let user = get(`
    SELECT id, email, tokens_total, tokens_used, subscription_status, reset_date, stripe_customer_id 
    FROM users WHERE id = ?
  `, [req.userId]);
  user = resetTokensIfNeeded(user);
  
  const usageThisMonth = get(`
    SELECT SUM(tokens_used) as total FROM usage_logs 
    WHERE user_id = ? AND created_at >= ?
  `, [req.userId, user.reset_date])?.total || 0;
  
  const requestsThisMonth = get(`
    SELECT COUNT(*) as total FROM usage_logs 
    WHERE user_id = ? AND created_at >= ?
  `, [req.userId, user.reset_date])?.total || 0;
  
  res.json({
    id: user.id,
    email: user.email,
    tokensTotal: user.tokens_total,
    tokensUsed: user.tokens_used,
    tokensRemaining: Math.max(0, user.tokens_total - user.tokens_used),
    usageThisMonth,
    requestsThisMonth,
    subscriptionStatus: user.subscription_status,
    resetDate: user.reset_date,
    hasApiKey: get('SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?', [req.userId])?.count > 0
  });
});

app.get('/api/tokens/usage', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = all(`SELECT * FROM usage_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [req.userId, limit]);
  res.json(logs);
});

app.get('/api/tokens/stats', authenticate, (req, res) => {
  const user = get('SELECT tokens_total, tokens_used, reset_date FROM users WHERE id = ?', [req.userId]);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayUsage = get(`
    SELECT SUM(tokens_used) as total, COUNT(*) as requests
    FROM usage_logs WHERE user_id = ? AND created_at >= ?
  `, [req.userId, today.toISOString()]) || { total: 0, requests: 0 };
  
  const weekUsage = new Date(today);
  weekUsage.setDate(weekUsage.getDate() - 7);
  
  const weekData = get(`
    SELECT SUM(tokens_used) as total, COUNT(*) as requests
    FROM usage_logs WHERE user_id = ? AND created_at >= ?
  `, [req.userId, weekUsage.toISOString()]) || { total: 0, requests: 0 };
  
  res.json({
    total: user.tokens_total,
    used: user.tokens_used,
    remaining: Math.max(0, user.tokens_total - user.tokens_used),
    resetDate: user.reset_date,
    today: todayUsage,
    week: weekData
  });
});

function requireTokens(req, res, next) {
  let user = get('SELECT * FROM users WHERE id = ?', [req.userId]);
  user = resetTokensIfNeeded(user);
  
  const remaining = user.tokens_total - user.tokens_used;
  
  if (remaining <= 0) {
    return res.status(402).json({ 
      error: 'Insufficient tokens',
      code: 'NO_TOKENS',
      tokensRemaining: 0,
      tokensNeeded: 100,
      subscriptionUrl: '/dashboard#/subscribe'
    });
  }
  
  if (remaining < 100) {
    req.lowBalance = true;
  }
  
  req.user = user;
  req.startTime = Date.now();
  next();
}

const SEARCH_COST_PER_USE = 1;

function requireSearchCredits(req, res, next) {
  let credits = get('SELECT * FROM search_credits WHERE user_id = ?', [req.userId]);
  
  if (!credits) {
    run('INSERT INTO search_credits (user_id, credits_total, credits_used) VALUES (?, 5, 0)', [req.userId]);
    credits = { credits_total: 5, credits_used: 0 };
  }
  
  const remaining = credits.credits_total - credits.credits_used;
  
  if (remaining <= 0) {
    return res.status(402).json({
      error: 'No search credits remaining',
      code: 'NO_SEARCH_CREDITS',
      creditsRemaining: 0,
      purchaseUrl: '/dashboard#/search-credits'
    });
  }
  
  req.searchCredits = remaining;
  req.searchCost = SEARCH_COST_PER_USE;
  next();
}

app.post('/api/search', authenticate, requireSearchCredits, async (req, res) => {
  const { query, maxResults = 5 } = req.body;
  
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  
  const startTime = Date.now();
  
  try {
    const searchResults = await runWebSearch(query, { maxResults });
    
    const responseTime = Date.now() - startTime;
    const creditsUsed = SEARCH_COST_PER_USE;
    
    run('UPDATE search_credits SET credits_used = credits_used + ? WHERE user_id = ?',
      [creditsUsed, req.userId]);
    
    run(`INSERT INTO search_history (user_id, query, results_count, credits_used, sources, response_time_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.userId,
        query,
        searchResults.results.length,
        creditsUsed,
        JSON.stringify(searchResults.results.map(r => ({ title: r.title, url: r.url }))),
        responseTime
      ]);
    
    const updatedCredits = get('SELECT credits_total, credits_used FROM search_credits WHERE user_id = ?', [req.userId]);
    
    res.json({
      ...searchResults,
      sources: formatSourcesForDisplay(searchResults),
      credits: {
        used: creditsUsed,
        remaining: updatedCredits.credits_total - updatedCredits.credits_used
      },
      responseTime
    });
    
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

app.get('/api/search/history', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  
  const history = all(`SELECT * FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [req.userId, limit]);
  
  res.json(history.map(h => ({
    ...h,
    sources: JSON.parse(h.sources || '[]')
  })));
});

app.get('/api/search/credits', authenticate, (req, res) => {
  let credits = get('SELECT * FROM search_credits WHERE user_id = ?', [req.userId]);
  
  if (!credits) {
    run('INSERT INTO search_credits (user_id, credits_total, credits_used) VALUES (?, 5, 0)', [req.userId]);
    credits = { id: null, credits_total: 5, credits_used: 0, expires_at: null };
  }
  
  res.json({
    total: credits.credits_total,
    used: credits.credits_used,
    remaining: credits.credits_total - credits.credits_used,
    expiresAt: credits.expires_at
  });
});

app.get('/api/operator/status', authenticate, async (req, res) => {
  try {
    const status = await checkOperatorStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/operator/run', authenticate, async (req, res) => {
  const { objective, url, options } = req.body;
  
  if (!objective) {
    return res.status(400).json({ error: 'Objective is required' });
  }
  
  let credits = get('SELECT * FROM operator_credits WHERE user_id = ?', [req.userId]);
  
  if (!credits) {
    run('INSERT INTO operator_credits (user_id, credits_total, credits_used) VALUES (?, 10, 0)', [req.userId]);
    credits = { credits_total: 10, credits_used: 0 };
  }
  
  const remaining = credits.credits_total - credits.credits_used;
  
  if (remaining < OPERATOR_COST_PER_TASK) {
    return res.status(402).json({
      error: 'No operator credits remaining',
      code: 'NO_OPERATOR_CREDITS',
      creditsRemaining: remaining,
      costPerTask: OPERATOR_COST_PER_TASK,
      purchaseUrl: '/dashboard#/operator-credits'
    });
  }
  
  const targetUrl = url || 'https://www.google.com';
  const costEstimate = getOperatorCost(objective, targetUrl, options);
  
  try {
    const result = await runOperatorTask(objective, targetUrl, options);
    
    const actualCost = result.cost || OPERATOR_COST_PER_TASK;
    
    run('UPDATE operator_credits SET credits_used = credits_used + ? WHERE user_id = ?',
      [actualCost, req.userId]);
    
    run(`INSERT INTO operator_history (user_id, objective, url, success, steps_taken, duration_ms, credits_used, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.userId,
        objective,
        targetUrl,
        result.success ? 1 : 0,
        result.stepsTaken || 0,
        result.duration || 0,
        actualCost,
        JSON.stringify(result)
      ]);
    
    const updatedCredits = get('SELECT credits_total, credits_used FROM operator_credits WHERE user_id = ?', [req.userId]);
    
    res.json({
      ...result,
      credits: {
        used: actualCost,
        remaining: updatedCredits.credits_total - updatedCredits.credits_used
      },
      costEstimate
    });
    
  } catch (error) {
    console.error('Operator error:', error.message);
    res.status(500).json({ error: 'Operator task failed', message: error.message });
  }
});

app.get('/api/operator/history', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  const history = all(`SELECT * FROM operator_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [req.userId, limit]);
  
  res.json(history.map(h => ({
    ...h,
    result: JSON.parse(h.result_json || '{}')
  })));
});

app.get('/api/operator/credits', authenticate, (req, res) => {
  let credits = get('SELECT * FROM operator_credits WHERE user_id = ?', [req.userId]);
  
  if (!credits) {
    run('INSERT INTO operator_credits (user_id, credits_total, credits_used) VALUES (?, 10, 0)', [req.userId]);
    credits = { credits_total: 10, credits_used: 0 };
  }
  
  res.json({
    total: credits.credits_total,
    used: credits.credits_used,
    remaining: credits.credits_total - credits.credits_used,
    costPerTask: OPERATOR_COST_PER_TASK
  });
});

app.post('/api/assistant/chat', authenticate, requireTokens, async (req, res) => {
  const { messages, mode, enableSearch = false } = req.body;
  const prompt = messages?.[messages.length - 1]?.content || '';
  
  let searchResults = null;
  let searchQuery = null;
  let operatorResult = null;
  
  if (enableSearch || shouldTriggerSearch(prompt)) {
    searchQuery = extractSearchQuery(prompt);
    
    try {
      searchResults = await runWebSearch(searchQuery, { maxResults: 5 });
      
      const creditsUsed = SEARCH_COST_PER_USE;
      run('UPDATE search_credits SET credits_used = credits_used + ? WHERE user_id = ?',
        [creditsUsed, req.userId]);
      
      run(`INSERT INTO search_history (user_id, query, results_count, credits_used, sources, response_time_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.userId,
          searchQuery,
          searchResults.results.length,
          creditsUsed,
          JSON.stringify(searchResults.results.map(r => ({ title: r.title, url: r.url }))),
          0
        ]);
    } catch (searchError) {
      console.error('Search error (non-fatal):', searchError.message);
    }
  }
  
  let useOperator = false;
  if (shouldUseOperator(prompt)) {
    const taskInfo = extractOperatorTask(prompt);
    try {
      const opCredits = get('SELECT credits_total, credits_used FROM operator_credits WHERE user_id = ?', [req.userId]);
      const opRemaining = (opCredits?.credits_total || 10) - (opCredits?.credits_used || 0);
      
      if (opRemaining >= OPERATOR_COST_PER_TASK) {
        operatorResult = await runOperatorTask(taskInfo.objective, taskInfo.url);
        
        const actualCost = operatorResult.cost || OPERATOR_COST_PER_TASK;
        run('UPDATE operator_credits SET credits_used = credits_used + ? WHERE user_id = ?',
          [actualCost, req.userId]);
        
        useOperator = true;
      }
    } catch (opError) {
      console.error('Operator error (non-fatal):', opError.message);
    }
  }
  
  let messagesToSend = messages;
  
  if (searchResults) {
    const searchContext = buildSearchContext(searchResults);
    const lastMessage = { ...messages[messages.length - 1] };
    
    if (lastMessage.role === 'user') {
      lastMessage.content = lastMessage.content + searchContext;
      messagesToSend = [...messages.slice(0, -1), lastMessage];
    }
  }
  
  try {
    const response = await axios.post(`${OPENCODE_URL}/api/chat`, {
      messages: messagesToSend,
      mode: mode || 'expert'
    }, {
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    let content = response.data?.content || '';
    
    if (searchResults) {
      content = addSourceCitations(content, searchResults);
    }
    
    if (operatorResult) {
      content += `\n\n[Operator Task: ${operatorResult.success ? 'Completed' : 'Failed'}] ${operatorResult.finalUrl ? `Final URL: ${operatorResult.finalUrl}` : ''}`;
    }
    
    const durationMs = Date.now() - req.startTime;
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(content.length / 4);
    const tokensUsed = Math.max(10, inputTokens + outputTokens);
    
    const remainingBefore = req.user.tokens_total - req.user.tokens_used;
    const willExceed = remainingBefore < tokensUsed;
    
    if (!willExceed) {
      run(`UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?`,
        [tokensUsed, req.userId]);
      
      run(`INSERT INTO usage_logs (user_id, tokens_used, duration_ms, action, input_tokens, output_tokens, model)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          req.userId, 
          tokensUsed, 
          durationMs, 
          mode || 'chat',
          inputTokens,
          outputTokens,
          'opencode'
        ]);
    }
    
    const updated = get('SELECT tokens_used, tokens_total FROM users WHERE id = ?', [req.userId]);
    const searchCredits = get('SELECT credits_total, credits_used FROM search_credits WHERE user_id = ?', [req.userId]);
    const opCredits = get('SELECT credits_total, credits_used FROM operator_credits WHERE user_id = ?', [req.userId]);
    
    res.json({
      content,
      tokenInfo: {
        tokensUsed,
        inputTokens,
        outputTokens,
        tokensRemaining: updated.tokens_total - updated.tokens_used,
        durationMs
      },
      searchInfo: searchResults ? {
        query: searchQuery,
        resultsCount: searchResults.results.length,
        sources: formatSourcesForDisplay(searchResults),
        creditsUsed: SEARCH_COST_PER_USE,
        creditsRemaining: searchCredits ? searchCredits.credits_total - searchCredits.credits_used : 0
      } : null,
      operatorInfo: operatorResult ? {
        success: operatorResult.success,
        objective: operatorResult.objective,
        url: operatorResult.url,
        finalUrl: operatorResult.finalUrl,
        stepsTaken: operatorResult.stepsTaken,
        objectiveMet: operatorResult.objectiveMet,
        creditsUsed: operatorResult.cost,
        summary: operatorResult.success 
          ? `Completed in ${operatorResult.stepsTaken} steps. Final URL: ${operatorResult.finalUrl}`
          : `Failed: ${operatorResult.error}`
      } : null
    });
    
  } catch (error) {
    console.error('Assistant error:', error.message);
    
    const durationMs = Date.now() - req.startTime;
    const estimatedTokens = Math.ceil((prompt.length + 100) / 4);
    
    run(`UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?`,
      [estimatedTokens, req.userId]);
    
    res.status(500).json({ 
      error: 'Assistant request failed',
      message: error.message
    });
  }
});

app.post('/api/keys/generate', authenticate, (req, res) => {
  const { label } = req.body;
  const key = 'pk_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
  
  run(`INSERT INTO api_keys (user_id, key, label) VALUES (?, ?, ?)`,
    [req.userId, key, label || 'API Key']);
  
  res.json({ key, label: label || 'API Key' });
});

app.get('/api/keys', authenticate, (req, res) => {
  const keys = all(`SELECT id, label, key, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`, [req.userId]);
  res.json(keys.map(k => ({ ...k, key: k.key.substring(0, 12) + '...' })));
});

app.delete('/api/keys/:id', authenticate, (req, res) => {
  run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
  const totalUsers = get('SELECT COUNT(*) as count FROM users')?.count || 0;
  const activeSubscriptions = get("SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active'")?.count || 0;
  const totalTokensUsed = get('SELECT SUM(tokens_used) as total FROM usage_logs')?.total || 0;
  
  res.json({ totalUsers, activeSubscriptions, totalTokensUsed });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log(`Pinnacle Integrated Server running on port ${PORT}`);
    console.log(`OpenCode URL: ${OPENCODE_URL}`);
  });
}

startServer().catch(console.error);

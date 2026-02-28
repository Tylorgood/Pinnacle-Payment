require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const {
  runWebSearch,
  shouldTriggerSearch,
  extractSearchQuery,
  buildSearchContext,
  addSourceCitations,
  formatSourcesForDisplay
} = require('./search-controller');

const {
  runOperatorTask,
  checkOperatorStatus,
  shouldUseOperator,
  extractOperatorTask,
  getOperatorCost,
  OPERATOR_COST_PER_TASK
} = require('./operator-controller');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pinnacle-integrated-secret-key';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:10000';

const stripe = require('stripe')(STRIPE_SECRET);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const db = new Database('pinnacle.db');

db.exec(`
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
  );

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
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS search_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credits_total INTEGER DEFAULT 0,
    credits_used INTEGER DEFAULT 0,
    purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

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
  );

  CREATE TABLE IF NOT EXISTS operator_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credits_total INTEGER DEFAULT 0,
    credits_used INTEGER DEFAULT 0,
    purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

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
  );

  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_logs(created_at);
`);

function resetTokensIfNeeded(user) {
  if (!user.reset_date) return user;
  
  const now = new Date();
  const resetDate = new Date(user.reset_date);
  
  if (now >= resetDate) {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);
    nextMonth.setHours(0, 0, 0, 0);
    
    db.prepare(`
      UPDATE users 
      SET tokens_used = 0, reset_date = ?
      WHERE id = ?
    `).run(nextMonth.toISOString(), user.id);
    
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
    
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);
    resetDate.setDate(1);
    
    let stripeCustomerId = null;
    if (STRIPE_SECRET) {
      try {
        const customer = await stripe.customers.create({ email });
        stripeCustomerId = customer.id;
      } catch (e) {
        console.log('Stripe not configured');
      }
    }
    
    const result = db.prepare(`
      INSERT INTO users (email, password, stripe_customer_id, tokens_total, tokens_used, reset_date)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(email, hashedPassword, stripeCustomerId, resetDate.toISOString());
    
    const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ token, user: { id: result.lastInsertRowid, email } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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
  let user = db.prepare(`
    SELECT id, email, tokens_total, tokens_used, subscription_status, reset_date, stripe_customer_id 
    FROM users WHERE id = ?
  `).get(req.userId);
  user = resetTokensIfNeeded(user);
  
  const usageThisMonth = db.prepare(`
    SELECT SUM(tokens_used) as total FROM usage_logs 
    WHERE user_id = ? AND created_at >= ?
  `).get(req.userId, user.reset_date)?.total || 0;
  
  const requestsThisMonth = db.prepare(`
    SELECT COUNT(*) as total FROM usage_logs 
    WHERE user_id = ? AND created_at >= ?
  `).get(req.userId, user.reset_date)?.total || 0;
  
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
    hasApiKey: db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?').get(req.userId)?.count > 0
  });
});

app.get('/api/tokens', authenticate, (req, res) => {
  let user = db.prepare('SELECT tokens_total, tokens_used FROM users WHERE id = ?').get(req.userId);
  user = resetTokensIfNeeded(user);
  const remaining = user.tokens_total - user.tokens_used;
  res.json({ balance: Math.max(0, remaining) });
});

app.get('/api/tokens/usage', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = db.prepare(`
    SELECT * FROM usage_logs 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.userId, limit);
  
  res.json(logs);
});

app.get('/api/tokens/stats', authenticate, (req, res) => {
  const user = db.prepare('SELECT tokens_total, tokens_used, reset_date FROM users WHERE id = ?').get(req.userId);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayUsage = db.prepare(`
    SELECT SUM(tokens_used) as total, COUNT(*) as requests
    FROM usage_logs WHERE user_id = ? AND created_at >= ?
  `).get(req.userId, today.toISOString()) || { total: 0, requests: 0 };
  
  const weekUsage = new Date(today);
  weekUsage.setDate(weekUsage.getDate() - 7);
  
  const weekData = db.prepare(`
    SELECT SUM(tokens_used) as total, COUNT(*) as requests
    FROM usage_logs WHERE user_id = ? AND created_at >= ?
  `).get(req.userId, weekUsage.toISOString()) || { total: 0, requests: 0 };
  
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
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
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
      db.prepare('UPDATE search_credits SET credits_used = credits_used + ? WHERE user_id = ?')
        .run(creditsUsed, req.userId);
      
      db.prepare(`
        INSERT INTO search_history (user_id, query, results_count, credits_used, sources, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        req.userId,
        searchQuery,
        searchResults.results.length,
        creditsUsed,
        JSON.stringify(searchResults.results.map(r => ({ title: r.title, url: r.url }))),
        0
      );
    } catch (searchError) {
      console.error('Search error (non-fatal):', searchError.message);
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
    
    const durationMs = Date.now() - req.startTime;
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(content.length / 4);
    const tokensUsed = Math.max(10, inputTokens + outputTokens);
    
    const remainingBefore = req.user.tokens_total - req.user.tokens_used;
    const willExceed = remainingBefore < tokensUsed;
    
    if (!willExceed) {
      db.prepare(`
        UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?
      `).run(tokensUsed, req.userId);
      
      db.prepare(`
        INSERT INTO usage_logs (user_id, tokens_used, duration_ms, action, input_tokens, output_tokens, model)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.userId, 
        tokensUsed, 
        durationMs, 
        mode || 'chat',
        inputTokens,
        outputTokens,
        'opencode'
      );
    }
    
    const updated = db.prepare('SELECT tokens_used, tokens_total FROM users WHERE id = ?').get(req.userId);
    const searchCredits = db.prepare('SELECT credits_total, credits_used FROM search_credits WHERE user_id = ?').get(req.userId);
    
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
    const estimatedTokens = Math.ceil((prompt.length + (error.response?.data?.content?.length || 100)) / 4);
    
    db.prepare(`
      UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?
    `).run(estimatedTokens, req.userId);
    
    res.status(500).json({ 
      error: 'Assistant request failed',
      message: error.message
    });
  }
});

app.post('/api/assistant/execute', authenticate, requireTokens, async (req, res) => {
  const { code, language, action } = req.body;
  
  try {
    const startTime = Date.now();
    
    const response = await axios.post(`${OPENCODE_URL}/api/execute`, {
      code,
      language
    }, {
      timeout: 60000
    });
    
    const durationMs = Date.now() - startTime;
    const tokensUsed = Math.ceil(durationMs / 1000) * 10;
    
    db.prepare(`
      UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?
    `).run(tokensUsed, req.userId);
    
    db.prepare(`
      INSERT INTO usage_logs (user_id, tokens_used, duration_ms, action)
      VALUES (?, ?, ?, ?)
    `).run(req.userId, tokensUsed, durationMs, action || 'execute');
    
    res.json({
      ...response.data,
      tokenInfo: {
        tokensUsed,
        durationMs
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const SEARCH_COST_PER_USE = 1;

function requireSearchCredits(req, res, next) {
  let credits = db.prepare('SELECT * FROM search_credits WHERE user_id = ?').get(req.userId);
  
  if (!credits) {
    credits = { credits_total: 5, credits_used: 0 };
    db.prepare('INSERT INTO search_credits (user_id, credits_total, credits_used) VALUES (?, 5, 0)').run(req.userId);
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
    
    db.prepare('UPDATE search_credits SET credits_used = credits_used + ? WHERE user_id = ?')
      .run(creditsUsed, req.userId);
    
    db.prepare(`
      INSERT INTO search_history (user_id, query, results_count, credits_used, sources, response_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.userId,
      query,
      searchResults.results.length,
      creditsUsed,
      JSON.stringify(searchResults.results.map(r => ({ title: r.title, url: r.url }))),
      responseTime
    );
    
    const updatedCredits = db.prepare('SELECT credits_total, credits_used FROM search_credits WHERE user_id = ?').get(req.userId);
    
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
  
  const history = db.prepare(`
    SELECT * FROM search_history 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.userId, limit);
  
  res.json(history.map(h => ({
    ...h,
    sources: JSON.parse(h.sources || '[]')
  })));
});

app.get('/api/search/credits', authenticate, (req, res) => {
  let credits = db.prepare('SELECT * FROM search_credits WHERE user_id = ?').get(req.userId);
  
  if (!credits) {
    credits = { id: null, credits_total: 5, credits_used: 0, expires_at: null };
    db.prepare('INSERT INTO search_credits (user_id, credits_total, credits_used) VALUES (?, 5, 0)').run(req.userId);
    credits = db.prepare('SELECT * FROM search_credits WHERE user_id = ?').get(req.userId);
  }
  
  res.json({
    total: credits.credits_total,
    used: credits.credits_used,
    remaining: credits.credits_total - credits.credits_used,
    expiresAt: credits.expires_at
  });
});

app.post('/api/search/credits/purchase', authenticate, async (req, res) => {
  const { credits, priceId } = req.body;
  
  const creditPackages = {
    'small': { credits: 10, price: 500 },
    'medium': { credits: 50, price: 2000 },
    'large': { credits: 100, price: 3500 }
  };
  
  const pkg = creditPackages[credits] || creditPackages.medium;
  
  if (priceId) {
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.userId);
    
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer' });
  }
  
  let useOperator = false;
  if (shouldUseOperator(prompt)) {
    const taskInfo = extractOperatorTask(prompt);
    try {
      const credits = db.prepare('SELECT credits_total, credits_used FROM operator_credits WHERE user_id = ?').get(req.userId);
      const remaining = (credits?.credits_total || 10) - (credits?.credits_used || 0);
      
      if (remaining >= OPERATOR_COST_PER_TASK) {
        operatorResult = await runOperatorTask(taskInfo.objective, taskInfo.url);
        
        const actualCost = operatorResult.cost || OPERATOR_COST_PER_TASK;
        db.prepare('UPDATE operator_credits SET credits_used = credits_used + ? WHERE user_id = ?')
          .run(actualCost, req.userId);
        
        useOperator = true;
      }
    } catch (opError) {
      console.error('Operator error (non-fatal):', opError.message);
    }
  }
  
  try {
      const session = await stripe.checkout.sessions.create({
        customer: user.stripe_customer_id,
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${pkg.credits} Search Credits` },
            unit_amount: pkg.price
          },
          quantity: 1
        }],
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#/dashboard?search_credits_success=true`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#/dashboard?canceled=true`,
        metadata: {
          user_id: req.userId,
          credits: pkg.credits
        }
      });
      
      return res.json({ url: session.url });
    } catch (error) {
      console.error('Stripe error:', error.message);
      return res.status(500).json({ error: 'Purchase failed' });
    }
  } else {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 12);
    
    db.prepare(`
      UPDATE search_credits 
      SET credits_total = credits_total + ?, expires_at = ?
      WHERE user_id = ?
    `).run(pkg.credits, expiresAt.toISOString(), req.userId);
    
    const updated = db.prepare('SELECT * FROM search_credits WHERE user_id = ?').get(req.userId);
    
    res.json({
      success: true,
      credits: {
        total: updated.credits_total,
        used: updated.credits_used,
        remaining: updated.credits_total - updated.credits_used
      }
    });
  }
});

const OPERATOR_COST_PER_TASK = 5;

function requireOperatorCredits(req, res, next) {
  let credits = db.prepare('SELECT * FROM operator_credits WHERE user_id = ?').get(req.userId);
  
  if (!credits) {
    db.prepare('INSERT INTO operator_credits (user_id, credits_total, credits_used) VALUES (?, 10, 0)').run(req.userId);
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
  
  req.operatorCredits = remaining;
  next();
}

app.get('/api/operator/status', authenticate, async (req, res) => {
  try {
    const status = await checkOperatorStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/operator/run', authenticate, requireOperatorCredits, async (req, res) => {
  const { objective, url, options } = req.body;
  
  if (!objective) {
    return res.status(400).json({ error: 'Objective is required' });
  }
  
  const targetUrl = url || 'https://www.google.com';
  
  const costEstimate = getOperatorCost(objective, targetUrl, options);
  
  try {
    const result = await runOperatorTask(objective, targetUrl, options);
    
    const actualCost = result.cost || OPERATOR_COST_PER_TASK;
    
    db.prepare('UPDATE operator_credits SET credits_used = credits_used + ? WHERE user_id = ?')
      .run(actualCost, req.userId);
    
    db.prepare(`
      INSERT INTO operator_history (user_id, objective, url, success, steps_taken, duration_ms, credits_used, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.userId,
      objective,
      targetUrl,
      result.success ? 1 : 0,
      result.stepsTaken || 0,
      result.duration || 0,
      actualCost,
      JSON.stringify(result)
    );
    
    const updatedCredits = db.prepare('SELECT credits_total, credits_used FROM operator_credits WHERE user_id = ?').get(req.userId);
    
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
  
  const history = db.prepare(`
    SELECT * FROM operator_history 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.userId, limit);
  
  res.json(history.map(h => ({
    ...h,
    result: JSON.parse(h.result_json || '{}')
  })));
});

app.get('/api/operator/credits', authenticate, (req, res) => {
  let credits = db.prepare('SELECT * FROM operator_credits WHERE user_id = ?').get(req.userId);
  
  if (!credits) {
    db.prepare('INSERT INTO operator_credits (user_id, credits_total, credits_used) VALUES (?, 10, 0)').run(req.userId);
    credits = { credits_total: 10, credits_used: 0 };
  }
  
  res.json({
    total: credits.credits_total,
    used: credits.credits_used,
    remaining: credits.credits_total - credits.credits_used,
    costPerTask: OPERATOR_COST_PER_TASK
  });
});

app.post('/api/stripe/create-subscription', authenticate, async (req, res) => {
  try {
    const { priceId } = req.body;
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.userId);
    
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer' });
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: user.stripe_customer_id,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#/dashboard?success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#/dashboard?canceled=true`,
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    
    const tokens = subscription.items?.data[0]?.price?.id === process.env.STRIPE_PRICE_2000 
      ? 2000 
      : (subscription.items?.data[0]?.quantity || 0);
    
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);
    
    db.prepare(`
      UPDATE users 
      SET subscription_id = ?, subscription_status = ?, tokens_total = ?, reset_date = ?
      WHERE stripe_customer_id = ?
    `).run(
      subscription.id,
      subscription.status,
      tokens,
      nextMonth.toISOString(),
      customerId
    );
  }
  
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    db.prepare(`
      UPDATE users 
      SET subscription_status = 'canceled', tokens_total = 0
      WHERE stripe_customer_id = ?
    `).run(subscription.customer);
  }
  
  res.json({ received: true });
});

app.post('/api/keys/generate', authenticate, (req, res) => {
  const { label } = req.body;
  const key = 'pk_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
  
  db.prepare(`
    INSERT INTO api_keys (user_id, key, label) VALUES (?, ?, ?)
  `).run(req.userId, key, label || 'API Key');
  
  res.json({ key, label: label || 'API Key' });
});

app.get('/api/keys', authenticate, (req, res) => {
  const keys = db.prepare(`
    SELECT id, label, key, created_at FROM api_keys 
    WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.userId);
  
  res.json(keys.map(k => ({ ...k, key: k.key.substring(0, 12) + '...' })));
});

app.delete('/api/keys/:id', authenticate, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const activeSubscriptions = db.prepare("SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active'").get().count;
  const totalTokensUsed = db.prepare('SELECT SUM(tokens_used) as total FROM usage_logs').get().total || 0;
  
  res.json({ totalUsers, activeSubscriptions, totalTokensUsed });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Pinnacle Integrated Server running on port ${PORT}`);
  console.log(`OpenCode URL: ${OPENCODE_URL}`);
});

# PINNACLE INTEGRATED — Implementation Guide

## Overview
Full token-integrated AI assistant with:
- User authentication
- Token-based usage tracking
- Stripe subscription integration
- Real-time token balance in UI
- Usage metering per request
- Enforcement (blocks when tokens depleted)

---

## FILE STRUCTURE

```
Pinnacle_Integrated/
├── server.js              # Main server (auth, tokens, proxy, API)
├── package.json           # Dependencies
├── .env                   # Environment variables (secret)
├── .env.example           # Template for env vars
├── .gitignore            
├── public/
│   └── index.html         # Full UI with token display
└── pinnacle.db           # SQLite database (auto-created)
```

---

## TOKEN SYSTEM ARCHITECTURE

### Token Calculation
- **Input tokens:** `Math.ceil(prompt.length / 4)`
- **Output tokens:** `Math.ceil(response.length / 4)`
- **Minimum charge:** 10 tokens per request
- **Execution tokens:** `Math.ceil(duration_ms / 1000) * 10`

### Database Schema

```sql
-- Users table
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  password TEXT,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  tokens_total INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  reset_date TEXT,
  created_at DATETIME
);

-- Usage logs
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  tokens_used INTEGER,
  duration_ms INTEGER,
  action TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model TEXT,
  created_at DATETIME
);

-- API Keys
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  key TEXT UNIQUE,
  label TEXT,
  created_at DATETIME
);
```

### Token Flow
```
1. User sends message
2. Middleware checks token balance
3. If balance <= 0 → 402 error, redirect to subscribe
4. If balance < 100 → warning flag
5. Forward to OpenCode
6. Calculate token cost (input + output)
7. Deduct from balance
8. Log usage
9. Return response + token info
```

---

## API ENDPOINTS

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, returns JWT |

### User
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user/me` | Get user info + token balance |
| GET | `/api/tokens/stats` | Usage statistics |
| GET | `/api/tokens/usage` | Usage history |

### Assistant
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/assistant/chat` | Chat with AI (checks tokens) |
| POST | `/api/assistant/execute` | Execute code (checks tokens) |

### Billing
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/stripe/create-subscription` | Create Stripe checkout |
| POST | `/api/stripe/webhook` | Handle subscription events |

### Keys
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/keys/generate` | Generate API key |
| GET | `/api/keys` | List user API keys |
| DELETE | `/api/keys/:id` | Delete API key |

---

## ENVIRONMENT VARIABLES

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | Yes | Stripe secret (sk_live_...) |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook secret |
| `STRIPE_PRICE_2000` | Yes | Price ID for $160 subscription |
| `JWT_SECRET` | Yes | Secret for JWT signing |
| `FRONTEND_URL` | No | For Stripe redirect |
| `PORT` | No | Server port (default 3000) |
| `OPENCODE_URL` | No | OpenCode backend URL |

---

## DEPLOYMENT

### Local Development
```bash
npm install
cp .env.example .env
# Edit .env with your values
npm start
# Visit http://localhost:3000
```

### Render Deployment
1. Push to GitHub
2. Create Web Service on Render
3. Build: `npm install`
4. Start: `node server.js`
5. Add environment variables
6. Deploy

---

## TOKEN ENFORCEMENT

### In Server (server.js)
```javascript
function requireTokens(req, res, next) {
  const user = getUser(req.userId);
  const remaining = user.tokens_total - user.tokens_used;
  
  if (remaining <= 0) {
    return res.status(402).json({ 
      error: 'Insufficient tokens',
      code: 'NO_TOKENS',
      subscriptionUrl: '/#/dashboard?tab=subscribe'
    });
  }
  next();
}
```

### In UI (index.html)
```javascript
if (user.tokensRemaining <= 0) {
  alert('No tokens remaining! Please subscribe.');
  showDashboard();
  return;
}
```

---

## SUBSCRIPTION FLOW

1. User clicks "Subscribe" in dashboard
2. Server creates Stripe Checkout Session
3. User pays $160 on Stripe
4. Stripe sends webhook to `/api/stripe/webhook`
5. Server updates user:
   - `tokens_total = 2000`
   - `subscription_status = 'active'`
   - `reset_date = next_month`
6. User can now use assistant

---

## TEST PLAN

### 1. Registration Flow
- [ ] Register new user
- [ ] Login with correct credentials
- [ ] Login with wrong credentials (should fail)
- [ ] Token balance shows 0 for new user

### 2. Token Deduction
- [ ] Send message → tokens deducted
- [ ] Check usage log in database
- [ ] Token balance updates in UI
- [ ] Multiple messages accumulate correctly

### 3. Enforcement
- [ ] Use all tokens
- [ ] Send new message → gets 402 error
- [ ] UI shows "Subscribe to continue"

### 4. Subscription
- [ ] Subscribe via Stripe
- [ ] Webhook updates tokens to 2000
- [ ] Status shows "active"
- [ ] Token balance resets on 1st of month

### 5. Dashboard
- [ ] Shows correct token balance
- [ ] Shows usage history
- [ ] Shows subscription status

---

## PRICING MATH

| Metric | Value |
|--------|-------|
| Subscription | $160/month |
| Tokens | 2000/month |
| Cost per token | $0.08 |
| OpenAI API cost | ~$0.01-0.03/request |
| **Profit margin** | ~95% |

---

## INTEGRATION POINTS

### Connecting to OpenCode
Set `OPENCODE_URL` to your OpenCode instance:
- Local: `http://localhost:10000`
- Remote: `https://assistant.onrender.com`

### Alternative AI Backends
Replace the axios call in `/api/assistant/chat` to use:
- OpenAI API
- Anthropic Claude
- Any LLM endpoint

---

## PRODUCTION CHECKLIST

- [ ] Change JWT_SECRET to random string
- [ ] Use PostgreSQL instead of SQLite
- [ ] Add HTTPS
- [ ] Set up Stripe webhooks
- [ ] Add rate limiting
- [ ] Add email verification
- [ ] Add password reset
- [ ] Add analytics
- [ ] Add support ticket system

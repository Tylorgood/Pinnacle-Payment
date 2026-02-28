require('dotenv').config();
const path = require('path');

let orchestrator = null;
let isInitialized = false;

async function getOrchestrator() {
  if (!isInitialized) {
    try {
      const awndePath = path.join(__dirname, '..', 'AWNDE', 'dist', 'index.js');
      const awnde = require(awndePath);
      await awnde.initialize();
      orchestrator = awnde.orchestrator;
      isInitialized = true;
      console.log('AWNDE initialized for Operator');
    } catch (error) {
      console.error('Failed to initialize AWNDE:', error.message);
      throw new Error('Operator service unavailable');
    }
  }
  return orchestrator;
}

const OPERATOR_COST_PER_TASK = 5;
const OPERATOR_COST_PER_MINUTE = 2;

async function runOperatorTask(objective, url, options = {}) {
  const awnde = await getOrchestrator();
  
  const {
    maxSteps = 20,
    maxTimeMs = 120000,
    headless = true
  } = options;

  const startTime = Date.now();

  try {
    const result = await awnde.executeTask(objective, url, {
      maxSteps,
      maxTimeMs,
      headless,
      allowPaymentInteraction: false,
      allowCredentialAccess: false
    });

    const durationMinutes = (Date.now() - startTime) / 60000;
    const cost = Math.max(
      OPERATOR_COST_PER_TASK,
      Math.ceil(durationMinutes * OPERATOR_COST_PER_MINUTE)
    );

    return {
      success: result.success,
      objective,
      url,
      finalUrl: result.finalUrl,
      stepsTaken: result.stepsTaken,
      duration: result.duration,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      objectiveMet: result.objectiveMet,
      actions: result.actions?.map(a => ({
        type: a.action?.type,
        success: a.success,
        error: a.error?.type
      })) || [],
      cost,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      objective,
      url,
      error: error.message,
      duration: Date.now() - startTime,
      cost: OPERATOR_COST_PER_TASK,
      timestamp: new Date().toISOString()
    };
  }
}

async function checkOperatorStatus() {
  try {
    const awnde = await getOrchestrator();
    return {
      available: true,
      status: 'ready',
      services: ['browser-automation', 'dom-parsing', 'decision-engine', 'recovery']
    };
  } catch (error) {
    return {
      available: false,
      status: 'error',
      error: error.message
    };
  }
}

async function shutdownOperator() {
  if (isInitialized && orchestrator) {
    try {
      await orchestrator.shutdown();
      isInitialized = false;
      orchestrator = null;
      console.log('AWNDE shutdown complete');
    } catch (error) {
      console.error('Error shutting down AWNDE:', error.message);
    }
  }
}

function getOperatorCost(objective, url, options = {}) {
  const { maxSteps = 20, estimatedTimeMinutes = 2 } = options;
  
  const baseCost = OPERATOR_COST_PER_TASK;
  const timeCost = Math.ceil(estimatedTimeMinutes * OPERATOR_COST_PER_MINUTE);
  
  return {
    taskCost: OPERATOR_COST_PER_TASK,
    estimatedTimeCost: timeCost,
    totalEstimate: baseCost + timeCost,
    currency: 'operator_credits'
  };
}

function shouldUseOperator(userInput) {
  const input = userInput.toLowerCase();
  
  const operatorKeywords = [
    'navigate to', 'go to', 'visit website',
    'fill out', 'fill in', 'submit form',
    'click on', 'login to', 'sign in',
    'search on', 'find on page', 'scrape',
    'book', 'buy', 'purchase', 'order',
    'download', 'upload', 'create account',
    'check', 'verify', 'monitor',
    'extract', 'get data from'
  ];
  
  if (input.startsWith('operator:') || input.startsWith('run:') || input.startsWith('browse:')) {
    return true;
  }
  
  return operatorKeywords.some(kw => input.includes(kw));
}

function extractOperatorTask(userInput) {
  let task = userInput.trim();
  
  const prefixes = ['operator:', 'run:', 'browse:'];
  for (const prefix of prefixes) {
    if (task.toLowerCase().startsWith(prefix)) {
      task = task.substring(prefix.length).trim();
    }
  }
  
  const urlMatch = task.match(/(https?:\/\/[^\s]+)/i);
  const url = urlMatch ? urlMatch[1] : null;
  
  let objective = task;
  if (url) {
    objective = task.replace(url, '').trim();
  }
  
  return {
    url: url || 'https://www.google.com',
    objective: objective || 'Browse the page'
  };
}

module.exports = {
  runOperatorTask,
  checkOperatorStatus,
  shutdownOperator,
  getOperatorCost,
  shouldUseOperator,
  extractOperatorTask,
  OPERATOR_COST_PER_TASK,
  OPERATOR_COST_PER_MINUTE
};

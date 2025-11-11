// server.js - FINAL, 100% WORKING, BASED ON YOUR ORIGINAL
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(express.json());

// CORS: Allow dashboard
app.use(cors({
  origin: 'http://localhost:8080',
  credentials: true
}));

const PORT = process.env.PORT || 8080;
const AGENT_URL = `http://localhost:${process.env.AGENT_PORT || 3001}`;
const ACCOUNTS_FILE = './data/accounts.json';
const OVERLAYS_FILE = './data/overlays.json';
const SETTINGS_FILE = './data/settings.json';

// === GLOBAL SETTINGS (for Discord webhook, etc.) ===
let globalSettings = loadSettings();

// GET: Load settings
app.get('/api/settings', (req, res) => {
  console.log('GET /api/settings →', globalSettings);
  res.json(globalSettings);
});

// POST: Save settings
app.post('/api/settings', (req, res) => {
  globalSettings = { ...globalSettings, ...req.body };
  if (saveSettings(globalSettings)) {
    console.log('Settings saved to disk:', globalSettings);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// TEST WEBHOOK
app.post('/api/test-webhook', async (req, res) => {
  const { webhook, username, error } = req.body;
  if (!webhook) return res.status(400).json({ error: 'No webhook URL' });

  const payload = {
    content: `@here **PAccountBuilder Test Alert**`,
    embeds: [{
      title: `Test: ${username}`,
      description: `\`\`\`${error}\`\`\``,
      color: 0x00FF00,
      timestamp: new Date().toISOString(),
      footer: { text: "OSRS Bot Farm" }
    }]
  };

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      res.json({ success: true });
    } else {
      const text = await response.text();
      res.status(500).json({ error: 'Discord rejected', details: text });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==== Load & Save Settings =====
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading settings:', err);
  }
  return {};
}

function saveSettings(settings) {
  try {
    const dataDir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving settings:', err);
    return false;
  }
}

// === Load/Save accounts (your original, perfect) ===
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading accounts:', err);
  }
  return [];
}

function saveAccounts(accounts) {
  try {
    const dataDir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving accounts:', err);
    return false;
  }
}

// === /api/accounts - YOUR ORIGINAL, PERFECT ===
app.get('/api/accounts', async (req, res) => {
  const accounts = loadAccounts();
  
  try {
    const agentResponse = await fetch(`${AGENT_URL}/api/bots`);
    const agentAccounts = await agentResponse.json();
    
    accounts.forEach(acc => {
      const agentAcc = agentAccounts.find(a => a.username === acc.username);
      if (agentAcc) {
        acc.status = agentAcc.status;
        acc.pid = agentAcc.pid;
        acc.startTime = agentAcc.startTime;
      } else {
        acc.status = 'stopped';
        acc.pid = null;
        acc.startTime = null;
      }
    });
  } catch (err) {
    console.error('Failed to get agent status:', err.message);
    accounts.forEach(acc => {
      acc.status = 'offline';
      acc.pid = null;
      acc.startTime = null;
    });
  }
  
  console.log(`GET /api/accounts - Returning ${accounts.length} accounts`);
  res.json(accounts);
});

// === UPDATE ACCOUNT ===
app.put('/api/accounts/:username', (req, res) => {
  const username = decodeURIComponent(req.params.username);
  const updates = req.body;
  
  const accounts = loadAccounts();
  const account = accounts.find(a => a.username === username);
  
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  Object.assign(account, updates);
  
  if (saveAccounts(accounts)) {
    console.log(`Updated ${username}:`, updates);
    res.json(account);
  } else {
    res.status(500).json({ error: 'Failed to save' });
  }
});

// === START BOT ===
app.post('/api/accounts/:username/start', async (req, res) => {
  const username = decodeURIComponent(req.params.username);
  const { plugin, args } = req.body;
  
  console.log(`Starting bot: ${username} with ${plugin}`);
  
  try {
    const response = await fetch(`${AGENT_URL}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, plugin, args })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log(`Started ${username}`);
      res.json(data);
    } else {
      console.error(`Failed to start ${username}:`, data);
      res.status(response.status).json(data);
    }
  } catch (err) {
    console.error(`Error starting ${username}:`, err.message);
    res.status(500).json({ error: 'Failed to start bot', details: err.message });
  }
});

// === STOP BOT ===
app.post('/api/accounts/:username/stop', async (req, res) => {
  const username = decodeURIComponent(req.params.username);
  
  console.log(`Stopping bot: ${username}`);
  
  try {
    const response = await fetch(`${AGENT_URL}/agent/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log(`Stopped ${username}`);
      res.json(data);
    } else {
      console.error(`Failed to stop ${username}:`, data);
      res.status(response.status).json(data);
    }
  } catch (err) {
    console.error(`Error stopping ${username}:`, err.message);
    res.status(500).json({ error: 'Failed to stop bot', details: err.message });
  }
});

// === STATS ===
app.get('/api/accounts/:username/stats', async (req, res) => {
  const username = decodeURIComponent(req.params.username);
  
  try {
    const response = await fetch(`${AGENT_URL}/api/stats/${encodeURIComponent(username)}`);
    const stats = await response.json();
    res.json(stats);
  } catch (err) {
    console.error(`Error getting stats for ${username}:`, err.message);
    res.status(500).json({ error: 'Failed to get stats', details: err.message });
  }
});

// === HISCORES ===
app.get('/api/hiscores', async (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const response = await fetch(`https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodeURIComponent(username)}`);
    const text = await response.text();
    if (!response.ok) return res.status(404).json({ error: 'Player not found' });

    const lines = text.trim().split('\n');
    const skills = ['overall', 'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 
                    'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 
                    'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 
                    'slayer', 'farming', 'runecraft', 'hunter', 'construction'];
    
    const result = { meta: { username }, skills: {} };
    skills.forEach((skill, i) => {
      if (lines[i]) {
        const [rank, level, xp] = lines[i].split(',');
        result.skills[skill] = {
          rank: parseInt(rank),
          level: parseInt(level),
          xp: parseInt(xp)
        };
      }
    });
    res.json(result);
  } catch (err) {
    console.error('Hiscores error:', err);
    res.status(500).json({ error: 'Failed to fetch hiscores' });
  }
});

// === OVERLAYS ===
app.get('/overlay/:username', (req, res) => {
  try {
    if (fs.existsSync(OVERLAYS_FILE)) {
      const overlays = JSON.parse(fs.readFileSync(OVERLAYS_FILE, 'utf8'));
      const username = decodeURIComponent(req.params.username);
      res.json(overlays[username] || {});
    } else {
      res.json({});
    }
  } catch (err) {
    res.json({});
  }
});

app.post('/overlay/:username', (req, res) => {
  try {
    const username = decodeURIComponent(req.params.username);
    let overlays = {};
    
    if (fs.existsSync(OVERLAYS_FILE)) {
      overlays = JSON.parse(fs.readFileSync(OVERLAYS_FILE, 'utf8'));
    }
    
    overlays[username] = { ...overlays[username], ...req.body };
    
    const dataDir = path.dirname(OVERLAYS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    fs.writeFileSync(OVERLAYS_FILE, JSON.stringify(overlays, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Overlay save error:', err);
    res.status(500).json({ error: 'Failed to save overlay' });
  }
});

const jwt = require('jsonwebtoken');

// === LOGIN ENDPOINT ===
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // TEMP: Hardcoded admin
  if (username === 'admin' && password === 'password') {
    const token = jwt.sign(
      { username },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '7d' }
    );
    return res.json({ success: true, token });
  }

  res.status(401).json({ error: 'Invalid username or password' });
});

// === SERVE DASHBOARD STATIC FILES ===
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`   Accounts file: ${ACCOUNTS_FILE}`);
  const accounts = loadAccounts();
  console.log(`   Loaded ${accounts.length} accounts`);
  const withRSN = accounts.filter(a => a.rsn && a.rsn.trim()).length;
  console.log(`   Accounts with RSN: ${withRSN}`);
});
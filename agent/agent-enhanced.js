// agent-enhanced.js - FINAL: CLEAN, NO DUPLICATES, FULLY WORKING
require('dotenv').config({ path: '/opt/render/project/src/.env' });
const express = require('express');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Tail = require('tail').Tail;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const WebSocket = require('ws'); // ONLY ONCE
const { BankWealthParser } = require('./bank-wealth-parser');
const { decrypt, detectJavaPath } = require('./utils');

const bankWealthParser = new BankWealthParser();
const app = express();
const PORT = process.env.AGENT_PORT || 3001;

let DISCORD_WEBHOOK = '';
let webhookRetryCount = 0;
const MAX_RETRIES = 30;
const RETRY_DELAY = 2000;

async function loadDiscordWebhook() {
  if (webhookRetryCount >= MAX_RETRIES) {
    console.warn('Max retries reached. Discord webhook disabled until restart.');
    return;
  }

  try {
    console.log(`Attempt ${webhookRetryCount + 1}/${MAX_RETRIES}: Fetching webhook from http://localhost:8080/api/settings`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch('http://localhost:8080/api/settings', {
      signal: controller.signal,
      cache: 'no-store'
    });
    
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (data.discordWebhook && data.discordWebhook.includes('discord.com/api/webhooks')) {
      DISCORD_WEBHOOK = data.discordWebhook;
      console.log('DISCORD WEBHOOK LOADED:', DISCORD_WEBHOOK);
      webhookRetryCount = 0; // Reset
      return;
    } else {
      throw new Error('No valid webhook in response');
    }
  } catch (e) {
    webhookRetryCount++;
    console.warn(`Webhook load failed (attempt ${webhookRetryCount}/${MAX_RETRIES}):`, e.message);
    
    setTimeout(loadDiscordWebhook, RETRY_DELAY);
  }
}

// Start with delay
setTimeout(loadDiscordWebhook, 3000);

// Keep trying every 15s
setInterval(() => {
  if (!DISCORD_WEBHOOK) loadDiscordWebhook();
}, 15000);

// === CORS & RATE LIMIT ===
app.use(cors({ origin: 'http://localhost:8080' }));
app.use(express.json());
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// === PATHS ===
const ACCOUNTS_FILE = './data/accounts.json';
const PURELAUNCHER_PATH = process.env.PURELAUNCHER_PATH || 'C:\\Users\\Craig\\Desktop\\PureLauncher\\PureLauncher.jar';
const LOG_DIR = '/tmp/bot-logs'; // ← DOCKER MOUNT
const RUNELITE_HOME = process.env.RUNELITE_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.runelite');
const runningBots = new Map();
fs.mkdirSync(LOG_DIR, { recursive: true });

// === WEBSOCKET SERVER (PORT 3002) ===
const wss = new WebSocket.Server({ port: 3002 });
console.log('WebSocket server running on ws://localhost:3002');

let currentTasks = new Map(); // ONLY ONCE

wss.on('connection', (ws) => {
  console.log('WebSocket: Dashboard connected');
  const sendState = () => {
    const state = Array.from(runningBots.entries()).map(([u, b]) => ({
      username: u,
      status: b.status,
      currentTask: b.currentTask || 'Idle',
      pid: b.pid
    }));
    ws.send(JSON.stringify({ type: 'state', data: state }));
  };
  sendState();
  const interval = setInterval(sendState, 2000);
  ws.on('close', () => {
    clearInterval(interval);
    console.log('WebSocket: Dashboard disconnected');
  });
});

function broadcastTask(username, task) {
  const msg = JSON.stringify({ type: 'task', username, task });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// === LOGGING ===
function writeToCustomLog(username, message) {
  const sanitized = username.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';
  const line = `${timestamp} ${message}\n`;
  try {
    fs.appendFileSync(logFile, line);
    const stats = fs.statSync(logFile);
    if (stats.size > 500000) {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n');
      fs.writeFileSync(logFile, lines.slice(-500).join('\n'));
    }
  } catch (err) {
    console.error(`Log error:`, err);
  }
}

// === ACCOUNTS ===
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Load error:', err);
  }
  return [];
}

function getAccountDetails(username) {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if (acc) acc.password = decrypt(acc.password);
  return acc;
}

// === LAUNCH COMMAND ===
function buildLaunchCommand(config) {
  const javaPath = process.env.JAVA_PATH || detectJavaPath() || 'C:\\Users\\Craig\\.PureLauncher\\jdk\\jdk-11\\bin\\java.exe';
  
  const jvmArgs = [
    `-Dusername=${config.username}`,
    `-Dpassword=${config.password}`,
    '-Xms512m',
    '-Xmx4096m'
  ];

  // Add PAB args with quotes
  if (config.args) {
    config.args.split('&').forEach(pair => {
      if (pair.includes('=')) {
        const [k, v] = pair.split('=');
        jvmArgs.push(`-D${k}="${v}"`);
      }
    });
  }

  const parts = [
    'cmd', '/c', 'start', '/B', '""',
    `"${javaPath}"`,
    ...jvmArgs,
    '-cp', 'PureInstaller.jar;RuneLite.jar',
    'ca.arnah.runelite.LauncherHijack'
  ];

  return parts;
}

// === START BOT ===
async function startBot(username, body, res) {
  const account = getAccountDetails(username);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!account.password) return res.status(400).json({ error: 'No password' });

  const cfg = { ...account, plugin: body.plugin || account.plugin, args: body.args || account.args };
  console.log(`\nStarting bot: ${username} | Plugin: ${cfg.plugin} | Args: ${cfg.args}`);

  const logFile = path.join(LOG_DIR, `${username.replace(/[^a-zA-Z0-9_@.-]/g, '_')}.log`);
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  writeToCustomLog(username, `[AGENT] Starting bot`);

	const cmd = buildLaunchCommand(cfg);
	const child = spawn(cmd[0], cmd.slice(1), {
	  detached: true,
	  stdio: 'ignore',
	  shell: true,
	  cwd: 'C:\\Users\\Craig\\.PureLauncher\\runelite',
	  env: { ...process.env, LAUNCH_MODE: 'JVM' }
	});
	child.unref();

	// Store initial PID (from spawn)
	const bot = {
	  process: child,
	  pid: child.pid || null,
	  startTime: Date.now(),
	  config: cfg,
	  status: 'starting',
	  currentTask: null,
	  tailProcess: null
	};
	runningBots.set(username, bot);
  writeToCustomLog(username, `[AGENT] Launched with PID ${child.pid}`);

  setTimeout(async () => {
    try {
      const { stdout } = await execAsync(`wmic process where "name='java.exe' and CommandLine like '%${username}%'" get ProcessId /format:value`);
      const match = stdout.match(/ProcessId=(\d+)/);
      if (match) {
        const realPid = parseInt(match[1]);
        bot.pid = realPid;
        console.log(`[${username}] Found java.exe PID: ${realPid}`);
        writeToCustomLog(username, `[AGENT] Java PID: ${realPid}`);
      }
    } catch (e) {}

    const sharedLogDir = path.join(RUNELITE_HOME, 'logs');
    if (fs.existsSync(sharedLogDir)) {
      const files = fs.readdirSync(sharedLogDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(sharedLogDir, f), time: fs.statSync(path.join(sharedLogDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);
      let targetLog = null;
      for (const file of files.slice(0, 5)) {
        const snippet = fs.readFileSync(file.path, 'utf8').slice(-5000);
        if (snippet.includes(username)) {
          targetLog = file.path;
          break;
        }
      }
      const latestLog = targetLog || files[0]?.path;
      if (latestLog) {
        console.log(`[${username}] Tailing: ${latestLog}`);
        writeToCustomLog(username, `[AGENT] Tailing: ${latestLog}`);
        const tail = new Tail(latestLog, { follow: true, useWatchFile: true });
        bot.tailProcess = tail;
		tail.on('line', (line) => {
		  writeToCustomLog(username, line);

		  // DETECT PAB FAILURE
		if (line.includes('PAccountBuilder: Failed to execute task') || 
			line.includes('Failed tasks four times in a row')) {
		  
		  const errorMsg = line.match(/PAccountBuilder: (.*)/)?.[1] || line;
			sendDiscordAlert(username, errorMsg, bot);
		}

		  if (line.includes('Executing task:')) {
			const match = line.match(/Executing task:\s*(.+)/);
			if (match) {
			  const task = match[1].trim();
			  bot.currentTask = task;
			  broadcastTask(username, task);
			}
		  }
		  if (line.includes('LOGGED_IN')) bot.status = 'running';
		  if (line.includes('ERROR') || line.includes('Exception')) writeToCustomLog(username, `[ERROR] ${line}`);
		});
        tail.on('error', (err) => {
          writeToCustomLog(username, `[AGENT] Tail error: ${err.message}`);
        });
      }
    }

    const checkInterval = setInterval(async () => {
      if (!bot.pid) return;
      try {
        await execAsync(`tasklist /FI "PID eq ${bot.pid}" /NH`);
      } catch {
        clearInterval(checkInterval);
        if (bot.tailProcess) bot.tailProcess.unwatch();
        bot.status = 'stopped';
        setTimeout(() => runningBots.delete(username), 5000);
        console.log(`\nBot exited: ${username}`);
        writeToCustomLog(username, `[AGENT] Process exited`);
      }
    }, 5000);
  }, 3000);

  res.json({ success: true, pid: child.pid });
}

// === ROUTES ===
app.get('/api/bots', (req, res) => {
  const bots = Array.from(runningBots.entries()).map(([u, b]) => ({
    username: u,
    status: b.status,
    pid: b.pid,
    startTime: b.startTime
  }));
  res.json(bots);
});

app.get('/api/stats/:username', async (req, res) => {
  const stats = await getBotStats(req.params.username);
  res.json(stats);
});

app.get('/api/logs/:username', async (req, res) => {
  try {
    const username = decodeURIComponent(req.params.username);
    const logFile = path.join(LOG_DIR, `${username.replace(/[^a-zA-Z0-9_@.-]/g, '_')}.log`);
    let logs = '';
    if (fs.existsSync(logFile)) {
      logs = fs.readFileSync(logFile, 'utf8').split('\n').slice(-1000).join('\n');
    }

    const currentTask = extractCurrentTask(logs);
    const oldTask = currentTasks.get(username);

    if (oldTask !== currentTask) {
      currentTasks.set(username, currentTask);
      broadcastTask(username, currentTask);
    }

    const bot = runningBots.get(username);
    res.json({
      logs,
      status: bot?.status || 'stopped',
      currentTask: currentTask
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function extractCurrentTask(logs) {
  const lines = logs.split('\n').reverse();
  for (const line of lines) {
    if (line.includes('Executing task:')) {
      return line.split('Executing task:')[1].trim();
    }
    if (line.includes('PAccountBuilder: Stopped')) {
      return 'Stopped';
    }
  }
  return 'Idle';
}

async function getBotStats(username) {
  const account = loadAccounts().find(a => a.username === username);
  if (!account) return { error: 'Not found' };
  const stats = { username, rsn: account.rsn, bankValue: null, coins: null, membershipDays: null };
  if (stats.rsn) {
    const wealth = bankWealthParser.getBankWealth(stats.rsn);
    if (wealth) {
      stats.bankValue = wealth.bankValue;
      stats.coins = wealth.coins;
    }
    const memFile = path.join(RUNELITE_HOME, 'membership-days', `${stats.rsn}.json`);
    if (fs.existsSync(memFile)) {
      const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      stats.membershipDays = data.days;
    }
  }
  return stats;
}

app.post('/agent/start', async (req, res) => {
  await startBot(req.body.username, req.body, res);
});

app.post('/agent/stop', async (req, res) => {
  const username = req.body.username;
  const bot = runningBots.get(username);
  if (!bot) return res.json({ success: true });

  try {
    // Stop tailing logs
    if (bot.tailProcess) {
      bot.tailProcess.unwatch();
      bot.tailProcess = null;
    }

    // Kill process ONLY if PID exists and is a number
    if (bot.pid && typeof bot.pid === 'number') {
      try {
        await execAsync(`taskkill /PID ${bot.pid} /T /F`);
        writeToCustomLog(username, `[AGENT] Stopped via taskkill PID ${bot.pid}`);
      } catch (killErr) {
        console.warn(`Failed to kill PID ${bot.pid}:`, killErr.message);
        writeToCustomLog(username, `[AGENT] taskkill failed: ${killErr.message}`);
      }
    } else {
      writeToCustomLog(username, `[AGENT] No valid PID to kill`);
    }

    runningBots.delete(username);
    res.json({ success: true });
  } catch (e) {
    console.error('Stop error:', e);
    writeToCustomLog(username, `[AGENT] Stop error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

async function sendDiscordAlert(username, error, bot) {
  if (!DISCORD_WEBHOOK) return;

  const payload = {
    content: `@here **PAccountBuilder Error**`,
    embeds: [{
      title: `Bot Failed: ${username}`,
      description: `\`\`\`${error}\`\`\``,
      color: 0xFF0000,
      timestamp: new Date().toISOString(),
      fields: [
        { name: "Status", value: "Stopped", inline: true },
        { name: "PID", value: bot?.pid?.toString() || "N/A", inline: true }
      ],
      footer: { text: "OSRS Bot Farm" }
    }]
  };

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('Discord alert sent for:', username);
  } catch (e) {
    console.error('Discord send failed:', e);
  }
}

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`Agent running on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  for (const [u, b] of runningBots) {
    if (b.tailProcess) b.tailProcess.unwatch();
    if (b.pid) await execAsync(`taskkill /PID ${b.pid} /T /F`).catch(() => {});
  }
  process.exit(0);
});
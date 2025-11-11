// utils.js - FIXED for Node v22 (createCipheriv)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is missing in .env!');
  process.exit(1);
}

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// FIXED: encrypt - Uses createCipheriv(key, iv)
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = Buffer.from(ENCRYPTION_KEY, 'base64');
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from('osrs-dashboard', 'utf8'));
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// FIXED: decrypt
function decrypt(encryptedBase64) {
  const data = Buffer.from(encryptedBase64, 'base64');
  const iv = data.slice(0, IV_LENGTH);
  const authTag = data.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.slice(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = Buffer.from(ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from('osrs-dashboard', 'utf8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Detect Java path
function detectJavaPath() {
  try {
    const result = execSync('where java', { encoding: 'utf8', stdio: 'pipe' });
    return result.split('\n')[0].trim();
  } catch {
    return null;
  }
}

// Kill process tree
function killTree(pid) {
  return new Promise((resolve, reject) => {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGTERM');
      }
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { encrypt, decrypt, detectJavaPath, killTree };
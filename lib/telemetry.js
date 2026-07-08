'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const ENDPOINT = 'https://teamlore.io/api/telemetry';
const TIMEOUT_MS = 1000;

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '0.0.0';
  }
}

function disabled() {
  return (
    process.env.TEAMLORE_TELEMETRY_DISABLED === '1' ||
    process.env.DO_NOT_TRACK === '1'
  );
}

function configDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'teamlore');
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'teamlore');
}

function anonymousId() {
  const file = path.join(configDir(), 'telemetry.json');

  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing && typeof existing.anonymousId === 'string' && existing.anonymousId) {
      return existing.anonymousId;
    }
  } catch (_) {
    // Missing or malformed telemetry state should not affect the CLI.
  }

  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ anonymousId: id }, null, 2) + '\n', {
      mode: 0o600,
    });
  } catch (_) {
    // If the config dir is not writable, this run can still be counted.
  }
  return id;
}

async function sendTelemetry(fields) {
  if (disabled() || typeof fetch !== 'function') return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'cli_completed',
        packageName: 'teamlore',
        packageVersion: packageVersion(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        anonymousId: anonymousId(),
        ...fields,
      }),
      signal: controller.signal,
    });
  } catch (_) {
    // Telemetry is best-effort and must never change CLI behavior.
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendTelemetry };

#!/usr/bin/env node
'use strict';

// Exit quietly if output is piped into a reader that closes early (head, less …).
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const cmd = process.argv[2];

function version() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '0.0.0';
  }
}

function help() {
  const ui = require('../lib/ui');
  const { bold, dim, cyan, amber, symbols, padEnd } = ui;
  const line = (s) => process.stdout.write(s + '\n');
  const cmdRow = (name, desc) => line('    ' + cyan(padEnd(name, 25)) + dim(desc));

  line(ui.banner(version()));
  line('  ' + bold('Usage'));
  cmdRow('npx teamlore init', 'Install the skill, hooks & .lore/ in this repo');
  cmdRow('npx teamlore remove', 'Uninstall (keeps .lore/; --purge deletes it too)');
  cmdRow('npx teamlore --help', 'Show this help');
  cmdRow('npx teamlore --version', 'Print the version');
  line('');
  line('  ' + dim('After ') + cyan('init') + dim(', review the changes and commit them.'));
  line('  ' + dim('Teammates get teamlore on their next ') + cyan('git pull') + dim('.'));
  line('');
  line('  ' + symbols.spark + '  ' + dim('https://github.com/lak7/teamlore'));
  line('');
}

function commandName() {
  switch (cmd) {
    case 'init':
    case 'remove':
    case 'uninstall':
      return cmd;
    case '-v':
    case '--version':
      return 'version';
    case undefined:
    case '-h':
    case '--help':
      return 'help';
    default:
      return 'unknown';
  }
}

async function main() {
  const started = Date.now();
  const command = commandName();
  const fields = { command };
  let threw = false;

  try {
    switch (cmd) {
      case 'init': {
        const { run } = require('../lib/init');
        process.exitCode = run(process.cwd());
        return;
      }
      case 'remove':
      case 'uninstall': {
        const { run } = require('../lib/remove');
        const purge = process.argv.slice(3).some((a) => a === '--purge');
        fields.purge = purge;
        process.exitCode = run(process.cwd(), { purge });
        return;
      }
      case '-v':
      case '--version':
        console.log(version());
        return;
      case undefined:
      case '-h':
      case '--help':
        help();
        return;
      default:
        console.error('Unknown command: ' + cmd);
        help();
        process.exitCode = 1;
    }
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    const { sendTelemetry } = require('../lib/telemetry');
    await sendTelemetry({
      ...fields,
      outcome: threw || (process.exitCode && process.exitCode !== 0) ? 'failure' : 'success',
      durationMs: Date.now() - started,
    });
  }
}

main().catch((err) => {
  setImmediate(() => {
    throw err;
  });
});

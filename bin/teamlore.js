#!/usr/bin/env node
'use strict';

const cmd = process.argv[2];

function version() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '0.0.0';
  }
}

const USAGE = `teamlore — shared memory for your team's AI agents

Usage:
  npx teamlore init        Install the skill, hooks, and .lore/ folder in this repo
  npx teamlore --help      Show this help
  npx teamlore --version   Show the version

After \`init\`, review the changes and commit them. Teammates get teamlore on
their next \`git pull\`. Docs: https://github.com/lak7/teamlore`;

function main() {
  switch (cmd) {
    case 'init': {
      const { run } = require('../lib/init');
      process.exitCode = run(process.cwd());
      return;
    }
    case '-v':
    case '--version':
      console.log(version());
      return;
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main();

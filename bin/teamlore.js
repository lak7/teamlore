#!/usr/bin/env node

const cmd = process.argv[2];

if (cmd === "init") {
  console.log("Welcome to teamlore.");
} else {
  console.log("Usage: teamlore init");
  process.exitCode = 1;
}

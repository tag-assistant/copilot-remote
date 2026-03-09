#!/usr/bin/env node

import { runCli } from './cli-runner.js';

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

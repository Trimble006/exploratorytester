const fs = require('fs');

let fileContent = fs.readFileSync('src/agent.ts', 'utf8');

// 1. Add tracked state to AgentSession
fileContent = fileContent.replace(
  'public iterationsExecuted = 0;',
  'public iterationsExecuted = 0;\n  public lastAction = "Initializing...";'
);

// 2. Hide console.logs based on a VERBOSE check. We will wrap console.log and console.error with a helper inside the file, or just locally conditionally log it.
const logHelper = `
const isVerbose = process.env.VERBOSE === "true";
export function vlog(...args: any[]) {
  if (isVerbose) {
    console.log(...args);
  }
}
export function verror(...args: any[]) {
  if (isVerbose) {
    console.error(...args);
  }
}

const SYSTEM_PROMPT`;

fileContent = fileContent.replace(
  'const SYSTEM_PROMPT',
  logHelper
);

// Replace all console.log with vlog in AgentSession methods
const sessionStartIndex = fileContent.indexOf('export class AgentSession');
const sessionEndIndex = fileContent.indexOf('export async function runAgent', sessionStartIndex);

let sessionBody = fileContent.substring(sessionStartIndex, sessionEndIndex);

sessionBody = sessionBody.replace(/console\.log\(/g, 'vlog(');
sessionBody = sessionBody.replace(/console\.error\(/g, 'verror(');

// Now update specific state transitions to inform the dashboard
sessionBody = sessionBody.replace(
  'vlog(`\\n${this.rolePrefix} [Agent]: ${textResponse}\\n`);',
  'vlog(`\\n${this.rolePrefix} [Agent]: ${textResponse}\\n`);\n      this.lastAction = "Reasoning & Emitting Tool Calls...";'
);

sessionBody = sessionBody.replace(
  'vlog(`${this.rolePrefix} -> Calling tool: ${fc.name}`);',
  'this.lastAction = `Using tool: ${fc.name}`; vlog(`${this.rolePrefix} -> Calling tool: ${fc.name}`);'
);


// Find string: vlog(`${this.rolePrefix} Agent has completed exploratory testing.`);
sessionBody = sessionBody.replace(
  'vlog(`${this.rolePrefix} Agent has completed exploratory testing.`);',
  'this.lastAction = "TESTING COMPLETE"; vlog(`${this.rolePrefix} Agent has completed exploratory testing.`);'
);


fileContent = fileContent.substring(0, sessionStartIndex) + sessionBody + fileContent.substring(sessionEndIndex);

fs.writeFileSync('src/agent.ts', fileContent);
console.log('src/agent.ts instrumented successfully.');

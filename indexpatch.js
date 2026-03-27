const fs = require('fs');

let indexContent = fs.readFileSync('src/index.ts', 'utf8');

const importString = 'import logUpdate from "log-update";\nimport chalk from "chalk";\n\nfunction renderDashboard(sessions: { roleName: string; session: AgentSession }[], maxIterations: number): string {\n  const lines: string[] = [];\n  lines.push(chalk.bold.blue("Exploratory Tester - execution status"));\n  lines.push(chalk.dim("".repeat(60)));\n  for (const { roleName, session } of sessions) {\n    const perc = Math.min(100, Math.round((session.iterationsExecuted / maxIterations) * 100));\n    const statusColor = session.completed ? chalk.green : chalk.yellow;\n    const statusText = session.completed ? "Done" : "Active";\n    const stateColor = session.completed ? chalk.dim : chalk.white;\n    lines.push(\n      \ [\%] \ | Iteration: \/\\n    );\n    lines.push(  \);\n  }\n  lines.push(chalk.dim("".repeat(60)));\n  return lines.join("\\n");\n}\n\n';

if (!indexContent.includes('const interleaveRoles =')) {
    console.error('Cannot find interleave execution point');
    process.exit(1);
}

// Inject imports
indexContent = indexContent.replace('dotenv.config();', importString + 'dotenv.config();');

// Inject the log update render loop logic
const iterLoopStr =       // Interleaved Turn Phase
      for (let iter = 1; iter <= maxIterations; iter++) {
        let anyActive = false;
        for (const { session } of sessions) {
          if (!session.completed && session.iterationsExecuted < maxIterations) {
            anyActive = true;
            try {
              if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
              await session.step();
            } catch (err) {
              console.error(\Error during interleaved step for \:\, err);
              session.completed = true; 
            }
          }
        }
        if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
        if (!anyActive) break;
      }
      if (process.env.VERBOSE !== "true") logUpdate.clear();
;

const oldIterLoopRegex = /\/\/ Interleaved Turn Phase[\s\S]*?(?=\n      \/\/ Teardown and Format Results)/m;

indexContent = indexContent.replace(oldIterLoopRegex, iterLoopStr);

fs.writeFileSync('src/index.ts', indexContent);

console.log('src/index.ts patched successfully');


const fs = require('fs');

let indexContent = fs.readFileSync('src/index.ts', 'utf8');

const importString = `import logUpdate from "log-update";
import chalk from "chalk";

function renderDashboard(sessions: { roleName: string; session: AgentSession }[], maxIterations: number): string {
  const lines: string[] = [];
  lines.push(chalk.bold.blue("Exploratory Tester - execution status"));
  lines.push(chalk.dim("—".repeat(60)));
  for (const { roleName, session } of sessions) {
    const perc = Math.min(100, Math.round((session.iterationsExecuted / maxIterations) * 100));
    const statusColor = session.completed ? chalk.green : chalk.yellow;
    const statusText = session.completed ? "Done" : "Active";
    const stateColor = session.completed ? chalk.dim : chalk.white;
    lines.push(
      \`\${chalk.bold(roleName.padEnd(20))} [\${perc.toString().padStart(3)}%] \${statusColor(statusText.padEnd(8))} | Iteration: \${session.iterationsExecuted}/\${maxIterations}\`
    );
    lines.push(\`  \${stateColor("> " + (session.lastAction || "Idle").substring(0, 70))}\`);
  }
  lines.push(chalk.dim("—".repeat(60)));
  return lines.join("\\n");
}
`;

if (!indexContent.includes('const interleaveRoles =')) {
    console.error('Cannot find interleave execution point');
    process.exit(1);
}

// Inject imports
indexContent = indexContent.replace('dotenv.config();', importString + '\ndotenv.config();');

// Inject the log update render loop logic
const iterLoopStr = `      // Interleaved Turn Phase
      for (let iter = 1; iter <= maxIterations; iter++) {
        let anyActive = false;
        if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));

        for (const { session } of sessions) {
          if (!session.completed && session.iterationsExecuted < maxIterations) {
            anyActive = true;
            try {
              if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
              await session.step();
            } catch (err) {
              console.error(\`Error during interleaved step for \${session.options.roleName}:\`, err);
              session.completed = true; 
            }
          }
        }
        if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
        if (!anyActive) break;
      }
      if (process.env.VERBOSE !== "true") logUpdate.clear();
`;

const oldIterLoopRegex = /\/\/ Interleaved Turn Phase[\s\S]*?(?=\n      \/\/ Teardown and Format Results)/m;

indexContent = indexContent.replace(oldIterLoopRegex, iterLoopStr);

fs.writeFileSync('src/index.ts', indexContent);

console.log('src/index.ts patched successfully');
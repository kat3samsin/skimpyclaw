/**
 * Context usage benchmark — measures token consumption across a simulated
 * multi-turn agentic conversation.
 *
 * Simulates what the tool loop does: builds messages, appends tool results,
 * measures estimated tokens at each iteration.
 */

import { estimateTokens } from '../src/providers/context-manager.js';
import { splitToolResult, truncateToolResult, TOOL_GUARD, buildSystemParam, compactOldResults } from '../src/providers/utils.js';
import { BUILTIN_TOOL_DEFINITIONS, BROWSER_TOOL_DEFINITION, FETCH_TOOL_DEFINITION, CODE_WITH_AGENT_TOOL, CHECK_CODE_AGENT_TOOL, getActiveToolDefs } from '../src/tools/definitions.js';

// --- Simulated data ---

const SYSTEM_PROMPT = `You are a personal assistant called SkimpyClaw. You help users with coding tasks, file management, and general questions.

## Capabilities
- Read and write files
- Execute bash commands
- Browse the web
- Manage projects

## Rules
- Always confirm before destructive operations
- Use tools to verify information
- Be concise but thorough

## User Context
The user is a software developer working on TypeScript projects. They prefer concise answers.

## Memory
- Yesterday: helped user set up a new project
- Last week: debugged a CI pipeline issue
`;

// Realistic tool results of varying sizes
const TOOL_RESULTS = {
  small_read: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  medium_read: Array.from({ length: 80 }, (_, i) =>
    `import { module${i} } from './module${i}.js';`
  ).join('\n') + '\n\nexport class AppController {\n' + Array.from({ length: 40 }, (_, i) =>
    `  private readonly svc${i} = new Service${i}();`
  ).join('\n') + '\n}\n',
  large_read: Array.from({ length: 500 }, (_, i) =>
    `// Line ${i}: ${Array(80).fill('x').join('')}`
  ).join('\n'),
  bash_ls: Array.from({ length: 50 }, (_, i) =>
    `src/module-${i}.ts`
  ).join('\n'),
  bash_test: `\n ✓ src/__tests__/app.test.ts (25 tests)\n ✓ src/__tests__/utils.test.ts (12 tests)\n ✓ src/__tests__/api.test.ts (8 tests)\n\n Test Files  3 passed (3)\n      Tests  45 passed (45)\n   Duration  2.34s\n`,
  bash_build: `tsc --noEmit\n\nfound 0 errors\n\n> build\n> esbuild src/index.ts --outdir=dist\n\n  dist/index.js  45.2kb\n\nDone in 1.23s\n`,
  large_bash: Array.from({ length: 300 }, (_, i) =>
    `Processing file ${i}... OK (${Math.random().toFixed(3)}s)`
  ).join('\n') + '\n\nDone. 300 files processed.\n',
  fetch_html: `<html><body><h1>Documentation</h1>${Array.from({ length: 200 }, (_, i) =>
    `<p>Paragraph ${i}: ${Array(100).fill('word').join(' ')}</p>`
  ).join('')}</body></html>`,
};

// Simulated assistant responses
const ASSISTANT_RESPONSES = [
  "I'll read the main source file to understand the project structure.",
  "I can see the project layout. Let me check the test files next.",
  "The tests look good. I'll now run the build to check for type errors.",
  "Build succeeded with no errors. Let me run the test suite.",
  "All 45 tests pass. Now I'll check the API endpoint implementation.",
  "I found the issue in the API handler. Let me fix it.",
  "I've updated the file. Let me run the tests again to verify.",
  "Tests still pass. Let me also check the integration tests.",
  "The large output shows all files processed correctly. Let me fetch the docs for the library we're using.",
  "Based on the documentation, I can confirm the implementation is correct. Here's a summary of what I found and fixed.",
];

// Simulated turns: each has tool calls + results
interface SimulatedTurn {
  assistantText: string;
  toolCalls: { name: string; args: Record<string, any>; result: string }[];
}

const TURNS: SimulatedTurn[] = [
  {
    assistantText: ASSISTANT_RESPONSES[0],
    toolCalls: [
      { name: 'Read', args: { path: '/project/src/index.ts' }, result: TOOL_RESULTS.medium_read },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[1],
    toolCalls: [
      { name: 'Bash', args: { cmd: 'ls src/__tests__/' }, result: TOOL_RESULTS.bash_ls },
      { name: 'Read', args: { path: '/project/src/__tests__/app.test.ts' }, result: TOOL_RESULTS.small_read },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[2],
    toolCalls: [
      { name: 'Bash', args: { cmd: 'pnpm build' }, result: TOOL_RESULTS.bash_build },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[3],
    toolCalls: [
      { name: 'Bash', args: { cmd: 'pnpm test --run' }, result: TOOL_RESULTS.bash_test },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[4],
    toolCalls: [
      { name: 'Read', args: { path: '/project/src/api.ts' }, result: TOOL_RESULTS.large_read },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[5],
    toolCalls: [
      { name: 'Write', args: { path: '/project/src/api.ts', content: 'fixed code' }, result: 'OK' },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[6],
    toolCalls: [
      { name: 'Bash', args: { cmd: 'pnpm test --run' }, result: TOOL_RESULTS.bash_test },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[7],
    toolCalls: [
      { name: 'Bash', args: { cmd: 'pnpm test:integration' }, result: TOOL_RESULTS.large_bash },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[8],
    toolCalls: [
      { name: 'Fetch', args: { url: 'https://docs.example.com/api' }, result: TOOL_RESULTS.fetch_html },
    ],
  },
  {
    assistantText: ASSISTANT_RESPONSES[9],
    toolCalls: [],
  },
];

// --- Benchmark ---

function buildToolDefs(): any[] {
  return [
    ...BUILTIN_TOOL_DEFINITIONS,
    FETCH_TOOL_DEFINITION,
    BROWSER_TOOL_DEFINITION,
    CODE_WITH_AGENT_TOOL,
    CHECK_CODE_AGENT_TOOL,
  ];
}

function runBenchmark() {
  // Build system prompt (simulating what buildSystemParam does)
  const systemParam = buildSystemParam(SYSTEM_PROMPT, true);
  const systemTokens = estimateTokens(Array.isArray(systemParam) ? systemParam : [systemParam]);

  // Simulate the conversation
  const messages: any[] = [];
  let totalTokensAcrossIterations = 0;
  let totalResultTokens = 0;
  let totalToolDefTokens = 0;

  // Add initial user message
  messages.push({ role: 'user', content: 'Help me debug the API endpoint in my project at /project' });

  for (const turn of TURNS) {
    // Compact old tool results before measuring (simulates production behavior)
    compactOldResults(messages);

    // Use dynamic tool set — only include extended tools if conversation references them
    const activeDefs = getActiveToolDefs(messages);

    // Measure tokens before this iteration (what would be sent to the API)
    const iterationPayload = [
      ...(Array.isArray(systemParam) ? systemParam : [systemParam]),
      ...activeDefs,
      ...messages,
    ];
    const iterationTokens = estimateTokens(iterationPayload);
    totalTokensAcrossIterations += iterationTokens;
    totalToolDefTokens += estimateTokens(activeDefs);

    // Append assistant response
    if (turn.toolCalls.length > 0) {
      // Assistant message with tool use
      const content: any[] = [];
      if (turn.assistantText) {
        content.push({ type: 'text', text: turn.assistantText });
      }
      for (const tc of turn.toolCalls) {
        content.push({
          type: 'tool_use',
          id: `tool_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.name,
          input: tc.args,
        });
      }
      messages.push({ role: 'assistant', content });

      // Process and append tool results
      const toolResults: any[] = [];
      for (const tc of turn.toolCalls) {
        const processed = splitToolResult(
          tc.name.toLowerCase() === 'read' ? 'read_file' : tc.name.toLowerCase(),
          tc.args,
          tc.result,
        );
        totalResultTokens += estimateTokens([processed]);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: `tool_${Math.random().toString(36).slice(2, 8)}`,
          content: processed,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      // Final text-only response
      messages.push({ role: 'assistant', content: turn.assistantText });
    }
  }

  // Final payload size (using dynamic tool set)
  const finalActiveDefs = getActiveToolDefs(messages);
  const finalPayload = [
    ...(Array.isArray(systemParam) ? systemParam : [systemParam]),
    ...finalActiveDefs,
    ...messages,
  ];
  const finalTokens = estimateTokens(finalPayload);

  // Output metrics
  console.log(`METRIC total_tokens=${totalTokensAcrossIterations}`);
  console.log(`METRIC system_tokens=${systemTokens}`);
  console.log(`METRIC tool_def_tokens=${Math.round(totalToolDefTokens / TURNS.length)}`);
  console.log(`METRIC result_tokens=${totalResultTokens}`);
  console.log(`METRIC final_context_tokens=${finalTokens}`);
  console.log(`METRIC message_count=${messages.length}`);
}

runBenchmark();

// Interactive setup wizard for SkimpyClaw

import * as readline from 'readline';
import { writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.skimpyclaw');
const AGENTS_DIR = join(CONFIG_DIR, 'agents', 'main');
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const GATEWAY_PLIST_LABEL = 'com.skimpyclaw.gateway';
const GATEWAY_PLIST_TEMPLATE = join(__dirname, '..', 'com.skimpyclaw.gateway.plist.example');

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function maskInput(input: string): string {
  if (input.length <= 8) return '****';
  return input.slice(0, 4) + '****' + input.slice(-4);
}

function renderGatewayPlist(workspaceDir: string): string {
  if (!existsSync(GATEWAY_PLIST_TEMPLATE)) {
    throw new Error(`Gateway launchd template not found: ${GATEWAY_PLIST_TEMPLATE}`);
  }

  const nodeBin = process.execPath;
  const nodeBinDir = dirname(nodeBin);
  const homeDir = homedir();
  const pnpmBinDir = process.env.PNPM_HOME || join(homeDir, 'Library', 'pnpm');
  const systemPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

  return readFileSync(GATEWAY_PLIST_TEMPLATE, 'utf-8')
    .replaceAll('__NODE_BIN__', nodeBin)
    .replaceAll('__NODE_BIN_DIR__', nodeBinDir)
    .replaceAll('__PNPM_BIN_DIR__', pnpmBinDir)
    .replaceAll('__SYSTEM_PATH__', systemPath)
    .replaceAll('__REPO_DIR__', workspaceDir)
    .replaceAll('__HOME_DIR__', homeDir);
}

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('\n👙🦞 SkimpyClaw Setup\n');

    // 1. Telegram Bot Token
    console.log('1. Telegram Bot Token');
    console.log('   Get one from @BotFather: https://t.me/BotFather');
    const telegramToken = await ask(rl, '   Enter token: ');
    console.log(`   ✓ ${maskInput(telegramToken)}\n`);

    // 2. Telegram ID
    console.log('2. Your Telegram ID');
    console.log('   Get it from @userinfobot: https://t.me/userinfobot');
    const telegramId = await ask(rl, '   Enter ID: ');
    console.log(`   ✓ ${telegramId}\n`);

    // 3. Anthropic API Key
    console.log('3. Anthropic API Key');
    console.log('   Get one from: https://console.anthropic.com/');
    const anthropicKey = await ask(rl, '   Enter key: ');
    console.log(`   ✓ ${maskInput(anthropicKey)}\n`);

    // 4. Agent Name
    console.log('4. Agent Name');
    const agentName = (await ask(rl, '   What should I call myself? [Claw]: ')) || 'Claw';
    console.log(`   ✓ ${agentName}\n`);

    // 5. Your Name
    console.log('5. Your Name');
    const userName = (await ask(rl, '   What should I call you? [Katrina]: ')) || 'Katrina';
    console.log(`   ✓ ${userName}\n`);

    // 6. Timezone
    console.log('6. Timezone');
    const timezone = (await ask(rl, '   Enter timezone [America/Chicago]: ')) || 'America/Chicago';
    console.log(`   ✓ ${timezone}\n`);

    const workspaceDir = process.cwd();

    // Create directories
    console.log('Creating directories...');
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(join(CONFIG_DIR, 'logs'), { recursive: true });
    mkdirSync(join(CONFIG_DIR, 'sessions'), { recursive: true });
    mkdirSync(join(CONFIG_DIR, 'cron'), { recursive: true });
    mkdirSync(AGENTS_DIR, { recursive: true });
    mkdirSync(join(AGENTS_DIR, 'memory'), { recursive: true });

    // Create config
    const config = {
      gateway: {
        port: 18790,
        mode: 'local',
      },
      agents: {
        default: 'main',
        list: {
          main: {
            identity: {
              name: agentName,
              emoji: '👙🦞',
            },
            model: 'anthropic/claude-sonnet-4-20250514',
            thinking: 'low',
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            apiKey: '${ANTHROPIC_API_KEY}',
          },
          codex: {
            authToken: 'codex',
            authPath: '${HOME}/.codex/auth.json',
            baseURL: 'https://chatgpt.com/backend-api',
          },
        },
        aliases: {
          fast: 'anthropic/claude-3-5-haiku-20241022',
          smart: 'anthropic/claude-sonnet-4-20250514',
          opus: 'anthropic/claude-opus-4-20250514',
        },
      },
      channels: {
        telegram: {
          enabled: true,
          token: '${TELEGRAM_BOT_TOKEN}',
          allowFrom: [parseInt(telegramId, 10) || telegramId],
          dailyNotesDir: '${HOME}/Daily Notes',
          defaultAllowedPaths: [
            '${HOME}/.skimpyclaw',
            workspaceDir,
          ],
        },
      },
      cron: {
        jobs: [
          {
            id: 'morning',
            name: 'Morning Routine',
            schedule: { kind: 'cron', expr: '30 7 * * 1-5', tz: timezone },
            payload: { kind: 'agentTurn', message: 'good morning today is {{date}}' },
          },
          {
            id: 'eod',
            name: 'EOD Review',
            schedule: { kind: 'cron', expr: '0 17 * * 1-5', tz: timezone },
            payload: { kind: 'agentTurn', message: 'run EOD review' },
          },
        ],
      },
      heartbeat: {
        intervalMs: 1800000,
        prompt: 'Read HEARTBEAT.md. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.',
        tools: {
          enabled: true,
          allowedPaths: [
            '${HOME}/.skimpyclaw',
            workspaceDir,
          ],
          maxIterations: 10,
          bashTimeout: 15000,
        },
      },
    };

    const configPath = join(CONFIG_DIR, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`✓ Config written to ${configPath}`);

    // Copy templates
    if (existsSync(TEMPLATES_DIR)) {
      const templates = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md'));
      for (const template of templates) {
        const src = join(TEMPLATES_DIR, template);
        const dst = join(AGENTS_DIR, template);
        if (!existsSync(dst)) {
          copyFileSync(src, dst);
        }
      }
      console.log(`✓ Templates copied to ${AGENTS_DIR}`);
    } else {
      console.log(`⚠ Templates directory not found. Create templates manually in ${AGENTS_DIR}`);
    }

    // Create .env file for secrets
    const envPath = join(CONFIG_DIR, '.env');
    const envContent = `# SkimpyClaw secrets\nANTHROPIC_API_KEY=${anthropicKey}\nTELEGRAM_BOT_TOKEN=${telegramToken}\n`;
    writeFileSync(envPath, envContent);
    console.log(`✓ Secrets written to ${envPath}`);

    // Update USER.md with name
    const userMdPath = join(AGENTS_DIR, 'USER.md');
    if (existsSync(userMdPath)) {
      // Will be created from template, but let's create a basic one
    }
    writeFileSync(userMdPath, `# USER.md - About ${userName}\n\nName: ${userName}\n\n## Preferences\n\n- Direct communication, no fluff\n- Obsidian vault for notes (PARA method)\n- Team Forno at Automattic\n\n## Routines\n\n- Morning: Check PRs, Linear, Slack\n- EOD: Review completed work, plan tomorrow\n`);

    // Create launchd plist from template
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${GATEWAY_PLIST_LABEL}.plist`);
    const plistContent = renderGatewayPlist(workspaceDir);

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plistContent);
    console.log(`✓ Daemon plist written to ${plistPath}`);

    console.log('\n✅ Setup complete!\n');
    console.log('Next steps:');
    console.log('1. Review templates in ~/.skimpyclaw/agents/main/');
    console.log('2. Start the daemon:');
    console.log(`   launchctl load ~/Library/LaunchAgents/${GATEWAY_PLIST_LABEL}.plist`);
    console.log('3. Check health:');
    console.log('   curl http://localhost:18790/health');
    console.log('4. Send /start to your Telegram bot');
    console.log('\n👙🦞 Enjoy!');
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  await runSetup();
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

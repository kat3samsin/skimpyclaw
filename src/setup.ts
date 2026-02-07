// Interactive setup wizard for SkimpyClaw

import * as readline from 'readline';
import { writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.skimpyclaw');
const AGENTS_DIR = join(CONFIG_DIR, 'agents', 'main');
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
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

async function main(): Promise<void> {
  console.log('\n👙🦞 SkimpyClaw Setup\n');

  // 1. Telegram Bot Token
  console.log('1. Telegram Bot Token');
  console.log('   Get one from @BotFather: https://t.me/BotFather');
  const telegramToken = await ask('   Enter token: ');
  console.log(`   ✓ ${maskInput(telegramToken)}\n`);

  // 2. Telegram ID
  console.log('2. Your Telegram ID');
  console.log('   Get it from @userinfobot: https://t.me/userinfobot');
  const telegramId = await ask('   Enter ID: ');
  console.log(`   ✓ ${telegramId}\n`);

  // 3. Anthropic API Key
  console.log('3. Anthropic API Key');
  console.log('   Get one from: https://console.anthropic.com/');
  const anthropicKey = await ask('   Enter key: ');
  console.log(`   ✓ ${maskInput(anthropicKey)}\n`);

  // 4. Agent Name
  console.log('4. Agent Name');
  const agentName = (await ask('   What should I call myself? [Claw]: ')) || 'Claw';
  console.log(`   ✓ ${agentName}\n`);

  // 5. Your Name
  console.log('5. Your Name');
  const userName = (await ask('   What should I call you? [Katrina]: ')) || 'Katrina';
  console.log(`   ✓ ${userName}\n`);

  // 6. Timezone
  console.log('6. Timezone');
  const timezone = (await ask('   Enter timezone [America/Chicago]: ')) || 'America/Chicago';
  console.log(`   ✓ ${timezone}\n`);

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
        allowFrom: [parseInt(telegramId) || telegramId],
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
    },
  };

  const configPath = join(CONFIG_DIR, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✓ Config written to ${configPath}`);

  // Copy templates
  if (existsSync(TEMPLATES_DIR)) {
    const templates = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.md'));
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
  const envContent = `# SkimpyClaw secrets
ANTHROPIC_API_KEY=${anthropicKey}
TELEGRAM_BOT_TOKEN=${telegramToken}
`;
  writeFileSync(envPath, envContent);
  console.log(`✓ Secrets written to ${envPath}`);

  // Update USER.md with name
  const userMdPath = join(AGENTS_DIR, 'USER.md');
  if (existsSync(userMdPath)) {
    // Will be created from template, but let's create a basic one
  }
  writeFileSync(userMdPath, `# USER.md - About ${userName}

Name: ${userName}

## Preferences

- Direct communication, no fluff
- Obsidian vault for notes (PARA method)
- Team Forno at Automattic

## Routines

- Morning: Check PRs, Linear, Slack
- EOD: Review completed work, plan tomorrow
`);

  // Create launchd plist
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.katre.skimpyclaw.plist');
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.katre.skimpyclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>--import</string>
        <string>tsx</string>
        <string>${join(homedir(), 'Sites', 'skimpyclaw', 'src', 'index.ts')}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>WorkingDirectory</key>
    <string>${join(homedir(), 'Sites', 'skimpyclaw')}</string>
    <key>StandardOutPath</key>
    <string>${join(CONFIG_DIR, 'logs', 'stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(CONFIG_DIR, 'logs', 'stderr.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.local', 'share', 'pnpm')}</string>
        <key>HOME</key>
        <string>${homedir()}</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>${anthropicKey}</string>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>${telegramToken}</string>
    </dict>
</dict>
</plist>`;

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plistContent);
  console.log(`✓ Daemon plist written to ${plistPath}`);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log('1. Review templates in ~/.skimpyclaw/agents/main/');
  console.log('2. Start the daemon:');
  console.log('   launchctl load ~/Library/LaunchAgents/com.katre.skimpyclaw.plist');
  console.log('3. Check health:');
  console.log('   curl http://localhost:18790/health');
  console.log('4. Send /start to your Telegram bot');
  console.log('\n👙🦞 Enjoy!');

  rl.close();
}

main().catch((error) => {
  console.error('Setup failed:', error);
  rl.close();
  process.exit(1);
});

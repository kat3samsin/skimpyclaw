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

type ProviderChoice = 'anthropic-api' | 'anthropic-oauth' | 'openai-api' | 'codex-oauth';

const PROVIDER_OPTIONS: { key: ProviderChoice; label: string }[] = [
  { key: 'anthropic-api', label: 'Anthropic API key' },
  { key: 'anthropic-oauth', label: 'Anthropic OAuth (Claude Code)' },
  { key: 'openai-api', label: 'OpenAI API key' },
  { key: 'codex-oauth', label: 'OpenAI Codex OAuth' },
];

async function askProviders(rl: readline.Interface): Promise<Set<ProviderChoice>> {
  while (true) {
    console.log('3. Model Providers (pick one or more)');
    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      console.log(`   ${i + 1}. ${PROVIDER_OPTIONS[i].label}`);
    }
    const input = await ask(rl, '   Enter numbers separated by commas (e.g. 1,3): ');
    const nums = input.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    const choices = new Set<ProviderChoice>();
    for (const n of nums) {
      if (n >= 1 && n <= PROVIDER_OPTIONS.length) {
        choices.add(PROVIDER_OPTIONS[n - 1].key);
      }
    }
    if (choices.size === 0) {
      console.log('   ✗ Pick at least one provider.\n');
      continue;
    }
    // Can't pick both Anthropic API and Anthropic OAuth
    if (choices.has('anthropic-api') && choices.has('anthropic-oauth')) {
      console.log('   ✗ Pick either Anthropic API key or Anthropic OAuth, not both.\n');
      continue;
    }
    return choices;
  }
}

interface ProviderSecrets {
  anthropicKey?: string;
  openaiKey?: string;
}

async function collectProviderSecrets(
  rl: readline.Interface,
  providers: Set<ProviderChoice>,
): Promise<ProviderSecrets> {
  const secrets: ProviderSecrets = {};

  if (providers.has('anthropic-api')) {
    console.log('\n   Anthropic API Key');
    console.log('   Get one from: https://console.anthropic.com/');
    secrets.anthropicKey = await ask(rl, '   Enter key: ');
    console.log(`   ✓ ${maskInput(secrets.anthropicKey)}`);
  }

  if (providers.has('anthropic-oauth')) {
    console.log('\n   Anthropic OAuth (Claude Code)');
    console.log('   Run `claude setup-token` first to configure your OAuth token.');
    console.log('   The token is read from CLAUDE_CODE_OAUTH_TOKEN env var at runtime.');
    console.log('   ✓ Will use ${CLAUDE_CODE_OAUTH_TOKEN}');
  }

  if (providers.has('openai-api')) {
    console.log('\n   OpenAI API Key');
    console.log('   Get one from: https://platform.openai.com/api-keys');
    secrets.openaiKey = await ask(rl, '   Enter key: ');
    console.log(`   ✓ ${maskInput(secrets.openaiKey)}`);
  }

  if (providers.has('codex-oauth')) {
    console.log('\n   OpenAI Codex OAuth');
    console.log('   No key needed — uses ~/.codex/auth.json at runtime.');
    console.log('   ✓ Will use codex auth');
  }

  console.log('');
  return secrets;
}

function buildProviders(providers: Set<ProviderChoice>): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  if (providers.has('anthropic-api')) {
    result.anthropic = { apiKey: '${ANTHROPIC_API_KEY}' };
  } else if (providers.has('anthropic-oauth')) {
    result.anthropic = { authToken: '${CLAUDE_CODE_OAUTH_TOKEN}' };
  }

  if (providers.has('openai-api')) {
    result.openai = { apiKey: '${OPENAI_API_KEY}', baseURL: 'https://api.openai.com/v1' };
  }

  if (providers.has('codex-oauth')) {
    result.codex = {
      authToken: 'codex',
      authPath: '${HOME}/.codex/auth.json',
      baseURL: 'https://chatgpt.com/backend-api',
    };
  }

  return result;
}

function buildDefaultModel(providers: Set<ProviderChoice>): string {
  const hasAnthropic = providers.has('anthropic-api') || providers.has('anthropic-oauth');
  if (hasAnthropic) return 'anthropic/claude-opus-4-6';
  if (providers.has('codex-oauth')) return 'codex/codex-5.3';
  return 'openai/gpt-4o';
}

function buildAliases(providers: Set<ProviderChoice>): Record<string, string> {
  const aliases: Record<string, string> = {};
  const hasAnthropic = providers.has('anthropic-api') || providers.has('anthropic-oauth');

  if (hasAnthropic) {
    aliases.fast = 'anthropic/claude-3-5-haiku-20241022';
    aliases.smart = 'anthropic/claude-sonnet-4-20250514';
    aliases.opus = 'anthropic/claude-opus-4-6';
    aliases['claude-think'] = 'anthropic/claude-sonnet-4-20250514';
  }

  if (providers.has('openai-api')) {
    aliases['gpt-fast'] = 'openai/gpt-4o-mini';
    aliases.gpt = 'openai/gpt-4o';
  }

  if (providers.has('codex-oauth')) {
    aliases.codex = 'codex/codex-5.3';
  }

  return aliases;
}

function buildEnvContent(
  telegramToken: string,
  providers: Set<ProviderChoice>,
  secrets: ProviderSecrets,
): string {
  const lines = ['# SkimpyClaw secrets'];

  if (providers.has('anthropic-api') && secrets.anthropicKey) {
    lines.push(`ANTHROPIC_API_KEY=${secrets.anthropicKey}`);
  }

  if (providers.has('anthropic-oauth')) {
    lines.push('# Anthropic OAuth — set by `claude setup-token`, read at runtime');
    lines.push('# CLAUDE_CODE_OAUTH_TOKEN=');
  }

  if (providers.has('openai-api') && secrets.openaiKey) {
    lines.push(`OPENAI_API_KEY=${secrets.openaiKey}`);
  }

  lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  lines.push('');
  return lines.join('\n');
}

export async function runSetup(options?: { dryRun?: boolean }): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('\n👙🦞 SkimpyClaw Setup\n');
    if (dryRun) console.log('   ⚠ DRY RUN — nothing will be written to disk.\n');

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

    // 3. Model Providers
    const selectedProviders = await askProviders(rl);
    const providerSecrets = await collectProviderSecrets(rl, selectedProviders);

    // 4. Agent Name
    console.log('4. Agent Name');
    const agentName = (await ask(rl, '   What should I call myself? [Claw]: ')) || 'Claw';
    console.log(`   ✓ ${agentName}\n`);

    // 5. Your Name
    console.log('5. Your Name');
    const userName = (await ask(rl, '   What should I call you? ')) || 'User';
    console.log(`   ✓ ${userName}\n`);

    // 6. Timezone
    console.log('6. Timezone');
    const timezone = (await ask(rl, '   Enter timezone [America/Chicago]: ')) || 'America/Chicago';
    console.log(`   ✓ ${timezone}\n`);

    const workspaceDir = process.cwd();

    // Build config
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
            model: buildDefaultModel(selectedProviders),
            thinking: 'low',
          },
        },
      },
      models: {
        providers: buildProviders(selectedProviders),
        aliases: buildAliases(selectedProviders),
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
        jobs: [],
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

    const configJson = JSON.stringify(config, null, 2);
    const envContent = buildEnvContent(telegramToken, selectedProviders, providerSecrets);

    if (dryRun) {
      console.log('\n--- config.json ---');
      console.log(configJson);
      console.log('\n--- .env ---');
      console.log(envContent);
      console.log('--- end dry run ---\n');
    } else {
      // Create directories
      console.log('Creating directories...');
      mkdirSync(CONFIG_DIR, { recursive: true });
      mkdirSync(join(CONFIG_DIR, 'logs'), { recursive: true });
      mkdirSync(join(CONFIG_DIR, 'sessions'), { recursive: true });
      mkdirSync(join(CONFIG_DIR, 'cron'), { recursive: true });
      mkdirSync(AGENTS_DIR, { recursive: true });
      mkdirSync(join(AGENTS_DIR, 'memory'), { recursive: true });

      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, configJson);
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
      writeFileSync(envPath, envContent);
      console.log(`✓ Secrets written to ${envPath}`);

      // Update USER.md with name
      writeFileSync(join(AGENTS_DIR, 'USER.md'), `# USER.md - About ${userName}\n\nName: ${userName}\n\n## Preferences\n\n- Direct communication, no fluff\n\n## Routines\n\n- Morning: Review tasks and messages\n- EOD: Review completed work, plan tomorrow\n`);

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
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await runSetup({ dryRun });
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

// Interactive setup wizard for SkimpyClaw

import * as readline from 'readline';
import { chmodSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { runDoctor as runDoctorChecks } from './doctor/runner.js';
import { secureStoreAvailable, setSecureValue } from './secure-store.js';
import { saveConfig } from './config.js';
import type { Config } from './types.js';
import {
  ensureCoreTemplates,
  ensureStarterSkills,
  buildStarterCronJobs,
  type SetupStarters,
} from './setup-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color helpers (no chalk dependency)
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function sectionHeader(title: string): void {
  console.log(`\n${c.bold(c.cyan(`─── ${title} ───`))}`);
}

function statusOk(msg: string): void {
  console.log(`   ${c.green('✓')} ${msg}`);
}

function statusWarn(msg: string): void {
  console.log(`   ${c.yellow('⚠')} ${msg}`);
}

const CONFIG_DIR = join(homedir(), '.skimpyclaw');
const AGENTS_DIR = join(CONFIG_DIR, 'agents', 'main');
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const GATEWAY_PLIST_LABEL = 'com.skimpyclaw.gateway';
const GATEWAY_PLIST_TEMPLATE = join(__dirname, '..', 'com.skimpyclaw.gateway.plist.example');
interface SetupOptions {
  dryRun?: boolean;
}

interface ExistingSetup {
  config: Record<string, any> | null;
  env: Record<string, string>;
}


function loadExistingSetup(): ExistingSetup {
  let config: Record<string, any> | null = null;
  const env: Record<string, string> = {};

  const configPath = join(CONFIG_DIR, 'config.json');
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* ignore bad config */ }
  }

  const envPath = join(CONFIG_DIR, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
  }

  return { config, env };
}


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

export function renderGatewayPlist(): string {
  if (!existsSync(GATEWAY_PLIST_TEMPLATE)) {
    throw new Error(`Gateway launchd template not found: ${GATEWAY_PLIST_TEMPLATE}`);
  }

  const nodeBin = process.execPath;
  const nodeBinDir = dirname(nodeBin);
  const homeDir = homedir();
  const pnpmBinDir = process.env.PNPM_HOME || join(homeDir, 'Library', 'pnpm');
  const systemPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const packageRoot = join(__dirname, '..');
  const entrypoint = join(packageRoot, 'dist', 'index.js');
  if (!existsSync(entrypoint)) {
    throw new Error(`Gateway entrypoint not found: ${entrypoint}`);
  }

  return readFileSync(GATEWAY_PLIST_TEMPLATE, 'utf-8')
    .replaceAll('__NODE_BIN__', nodeBin)
    .replaceAll('__ENTRYPOINT__', entrypoint)
    .replaceAll('__NODE_BIN_DIR__', nodeBinDir)
    .replaceAll('__PNPM_BIN_DIR__', pnpmBinDir)
    .replaceAll('__SYSTEM_PATH__', systemPath)
    .replaceAll('__REPO_DIR__', packageRoot)
    .replaceAll('__HOME_DIR__', homeDir);
}

type ProviderChoice = 'anthropic-api' | 'anthropic-oauth' | 'codex-oauth';

const PROVIDER_OPTIONS: { key: ProviderChoice; label: string }[] = [
  { key: 'anthropic-api', label: 'Anthropic API key' },
  { key: 'anthropic-oauth', label: 'Anthropic OAuth (Claude Code)' },
  { key: 'codex-oauth', label: 'OpenAI Codex OAuth' },
];

function detectExistingProviders(config: Record<string, any> | null): Set<ProviderChoice> {
  const existing = new Set<ProviderChoice>();
  if (!config?.models?.providers) return existing;
  const providers = config.models.providers;
  if (providers.anthropic?.authToken) existing.add('anthropic-oauth');
  else if (providers.anthropic?.apiKey) existing.add('anthropic-api');
  if (providers.codex || providers.openai?.authToken === 'codex') existing.add('codex-oauth');
  return existing;
}

async function askProviders(rl: readline.Interface, existingProviders?: Set<ProviderChoice>): Promise<Set<ProviderChoice>> {
  const hasExisting = existingProviders && existingProviders.size > 0;
  while (true) {
    sectionHeader('3. Model Providers');
    if (hasExisting) {
      console.log('   Currently configured:');
      for (const opt of PROVIDER_OPTIONS) {
        if (existingProviders.has(opt.key)) {
          console.log(`   ${c.green('✓')} ${opt.label}`);
        }
      }
      console.log('');
    }
    console.log('   Pick providers (pick one or more):');
    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      const marker = hasExisting && existingProviders.has(PROVIDER_OPTIONS[i].key) ? c.green('*') : ' ';
      console.log(`   ${marker}${i + 1}. ${PROVIDER_OPTIONS[i].label}`);
    }
    if (hasExisting) {
      console.log(`   ${c.dim('Press Enter to keep current providers')}`);
    }
    const input = await ask(rl, '   Enter numbers separated by commas (e.g. 1,3): ');
    if (input.trim() === '' && hasExisting) {
      return new Set(existingProviders);
    }
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
  oauthToken?: string;
}

/** Map of secret name → config reference string (KEYCHAIN ref or ENV ref). */
interface SecretRefs {
  anthropicKey?: string;
  oauthToken?: string;
  telegramToken?: string;
  discordToken?: string;
}

const KEYCHAIN_SERVICE = 'skimpyclaw';

/** Secret name → Keychain account name mapping. */
const SECRET_KEYCHAIN_ACCOUNTS: Record<keyof ProviderSecrets | 'telegramToken' | 'discordToken', string> = {
  anthropicKey: 'anthropic-api-key',
  oauthToken: 'anthropic-oauth-token',
  telegramToken: 'telegram-bot-token',
  discordToken: 'discord-bot-token',
};

/** Secret name → env var name mapping (fallback when Keychain unavailable). */
const SECRET_ENV_VARS: Record<keyof ProviderSecrets | 'telegramToken' | 'discordToken', string> = {
  anthropicKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  telegramToken: 'TELEGRAM_BOT_TOKEN',
  discordToken: 'DISCORD_BOT_TOKEN',
};

/**
 * Store secrets securely. On macOS, uses Keychain and returns ${KEYCHAIN:...} refs.
 * On other platforms, returns ${ENV_VAR} refs for .env file fallback.
 * Returns the reference map and whether Keychain was used.
 */
function storeSecretsSecurely(
  secrets: ProviderSecrets,
  telegramToken: string,
  discordToken?: string,
): { refs: SecretRefs; useKeychain: boolean; storedCount: number } {
  const keychainOk = secureStoreAvailable().ok;
  const refs: SecretRefs = {};
  let storedCount = 0;

  const allSecrets: Array<{ key: keyof SecretRefs; value: string | undefined }> = [
    { key: 'anthropicKey', value: secrets.anthropicKey },
    { key: 'oauthToken', value: secrets.oauthToken },
    { key: 'telegramToken', value: telegramToken },
    { key: 'discordToken', value: discordToken },
  ];

  for (const { key, value } of allSecrets) {
    if (!value) continue;
    if (keychainOk) {
      try {
        const account = SECRET_KEYCHAIN_ACCOUNTS[key as keyof typeof SECRET_KEYCHAIN_ACCOUNTS];
        setSecureValue(KEYCHAIN_SERVICE, account, value);
        refs[key] = `\${KEYCHAIN:${KEYCHAIN_SERVICE}/${account}}`;
        storedCount++;
        continue;
      } catch {
        // Fall through to env var ref
      }
    }
    const envVar = SECRET_ENV_VARS[key as keyof typeof SECRET_ENV_VARS];
    refs[key] = `\${${envVar}}`;
  }

  return { refs, useKeychain: keychainOk && storedCount > 0, storedCount };
}

interface SetupFeatures {
  voice: boolean;
  mcp: boolean;
}

interface SetupBuildInput {
  workspaceDir: string;
  extraAllowedPaths?: string[];
  telegramId: string;
  telegramToken: string;
  discordToken?: string;
  discordUserId?: string;
  discordDefaultChannelId?: string;
  agentName: string;
  selectedProviders: Set<ProviderChoice>;
  providerSecrets: ProviderSecrets;
  /** Resolved secret references (KEYCHAIN or ENV). If not provided, falls back to env var refs. */
  secretRefs?: SecretRefs;
  features?: SetupFeatures;
  starters?: SetupStarters;
}

async function collectProviderSecrets(
  rl: readline.Interface,
  providers: Set<ProviderChoice>,
  existingEnv?: Record<string, string>,
): Promise<ProviderSecrets> {
  const secrets: ProviderSecrets = {};
  const env = existingEnv || {};

  if (providers.has('anthropic-api')) {
    const existing = env.ANTHROPIC_API_KEY || '';
    console.log('\n   Anthropic API Key');
    if (existing) {
      const input = await ask(rl, `   Enter key [${maskInput(existing)}]: `);
      secrets.anthropicKey = input || existing;
    } else {
      console.log('   Get one from: https://console.anthropic.com/');
      secrets.anthropicKey = await ask(rl, '   Enter key: ');
    }
    console.log(`   ✓ ${maskInput(secrets.anthropicKey!)}`);
  }

  if (providers.has('anthropic-oauth')) {
    const existing = env.CLAUDE_CODE_OAUTH_TOKEN || '';
    console.log('\n   Anthropic OAuth (Claude Code)');
    if (existing) {
      const input = await ask(rl, `   Enter token [${maskInput(existing)}]: `);
      secrets.oauthToken = input || existing;
    } else {
      console.log('   Run `claude setup-token` to get your token, then paste it here.');
      console.log('   (The daemon can\'t read .zshrc — the token must be in ~/.skimpyclaw/.env)');
      const detected = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
      if (detected) {
        console.log(`   ${c.dim(`Detected in current shell: ${maskInput(detected)}`)}`);
      }
      const oauthInput = await ask(rl, detected ? `   Enter token [${maskInput(detected)}]: ` : '   Enter token: ');
      secrets.oauthToken = oauthInput || detected;
    }
    if (secrets.oauthToken) {
      console.log(`   ✓ ${maskInput(secrets.oauthToken)}`);
    } else {
      console.log(`   ${c.yellow('⚠')} Skipped — run \`claude setup-token\`, then add CLAUDE_CODE_OAUTH_TOKEN to ~/.skimpyclaw/.env`);
    }
  }

  if (providers.has('codex-oauth')) {
    console.log('\n   OpenAI Codex OAuth');
    console.log('   No key needed — uses ~/.codex/auth.json at runtime.');
    console.log('   ✓ Will use codex auth');
  }

  console.log('');
  return secrets;
}

function buildProviders(providers: Set<ProviderChoice>, refs?: SecretRefs): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  if (providers.has('anthropic-api')) {
    result.anthropic = { apiKey: refs?.anthropicKey || '${ANTHROPIC_API_KEY}' };
  } else if (providers.has('anthropic-oauth')) {
    result.anthropic = { authToken: refs?.oauthToken || '${CLAUDE_CODE_OAUTH_TOKEN}' };
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
  if (hasAnthropic) return 'anthropic/claude-opus-4-7';
  if (providers.has('codex-oauth')) return 'codex/gpt-5.5';
  return 'anthropic/claude-opus-4-7';
}

function buildAliases(providers: Set<ProviderChoice>): Record<string, string> {
  const aliases: Record<string, string> = {
    'codex5.1': 'codex/gpt-5.1-codex',
    'codex5.2': 'codex/gpt-5.2-codex',
    'codex5.3': 'codex/gpt-5.3-codex',
    'codex5.5': 'codex/gpt-5.5',
  };

  if (providers.has('codex-oauth')) {
    aliases.codex = 'codex/gpt-5.5';
  }

  return aliases;
}

function buildEnvContent(
  telegramToken: string,
  providers: Set<ProviderChoice>,
  secrets: ProviderSecrets,
  discordToken?: string,
  keychainRefs?: SecretRefs,
): string {
  const lines = ['# SkimpyClaw secrets'];
  // Helper: only write to .env if NOT stored in Keychain
  const isInKeychain = (key: keyof SecretRefs) => keychainRefs?.[key]?.includes('KEYCHAIN:');

  if (providers.has('anthropic-api') && secrets.anthropicKey && !isInKeychain('anthropicKey')) {
    lines.push(`ANTHROPIC_API_KEY=${secrets.anthropicKey}`);
  }

  if (providers.has('anthropic-oauth') && !isInKeychain('oauthToken')) {
    if (secrets.oauthToken) {
      lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${secrets.oauthToken}`);
    } else {
      lines.push('# Anthropic OAuth — paste token here (from .zshrc or `echo $CLAUDE_CODE_OAUTH_TOKEN`)');
      lines.push('CLAUDE_CODE_OAUTH_TOKEN=');
    }
  }

  if (!isInKeychain('telegramToken')) {
    lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  }
  if (discordToken && !isInKeychain('discordToken')) {
    lines.push(`DISCORD_BOT_TOKEN=${discordToken}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function buildSetupConfig(input: SetupBuildInput): Record<string, unknown> {
  const useDiscord = Boolean(input.discordToken);
  const features = input.features ?? { voice: false, mcp: false };
  const starters = input.starters ?? {
    cronTechNews: false,
    cronWeather: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    weatherLocation: 'New York, NY',
    skillDailyNotes: false,
    skillWeather: false,
    skillWebSearch: false,
  };
  const basePaths = ['${HOME}/.skimpyclaw'];
  const allPaths = [...basePaths, ...(input.extraAllowedPaths || [])];
  const starterCronJobs = buildStarterCronJobs(starters);
  const starterSkillEntries: Record<string, boolean> = {};
  if (starters.skillDailyNotes) starterSkillEntries['daily-notes'] = true;
  if (starters.skillWeather) starterSkillEntries['weather'] = true;
  if (starters.skillWebSearch) starterSkillEntries['web-search'] = true;
  return {
    gateway: {
      port: 18790,
      host: '127.0.0.1',
      mode: 'local',
    },
    agents: {
      default: 'main',
      list: {
        main: {
          identity: {
            name: input.agentName,
            emoji: '👙🦞',
          },
          model: buildDefaultModel(input.selectedProviders),
          thinking: 'low',
        },
      },
    },
    models: {
      providers: buildProviders(input.selectedProviders, input.secretRefs),
      aliases: buildAliases(input.selectedProviders),
    },
    channels: {
      active: useDiscord ? 'discord' : 'telegram',
      telegram: {
        enabled: true,
        token: input.secretRefs?.telegramToken || '${TELEGRAM_BOT_TOKEN}',
        allowFrom: [parseInt(input.telegramId, 10) || input.telegramId],
        dailyNotesDir: '${HOME}/.skimpyclaw/Daily Notes',
        defaultAllowedPaths: allPaths,
        tools: {
          enabled: true,
          allowedPaths: allPaths,
          maxIterations: 100,
          bashTimeout: 15000,
        },
      },
      discord: {
        enabled: useDiscord,
        token: useDiscord ? (input.secretRefs?.discordToken || '${DISCORD_BOT_TOKEN}') : '',
        allowFrom: useDiscord ? [input.discordUserId || ''] : [],
        defaultAllowedPaths: allPaths,
        ...(input.discordDefaultChannelId ? { defaultChannelId: input.discordDefaultChannelId } : {}),
        tools: {
          enabled: true,
          allowedPaths: allPaths,
          maxIterations: 100,
          bashTimeout: 15000,
        },
      },
    },
    cron: {
      jobs: starterCronJobs,
    },
    heartbeat: {
      intervalMs: 3600000,
      prompt: 'Read ~/.skimpyclaw/agents/main/HEARTBEAT.md. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.',
      tools: {
        enabled: true,
        allowedPaths: allPaths,
        maxIterations: 10,
        bashTimeout: 15000,
      },
    },
    ...(features.voice ? {
      voice: {
        enabled: true,
        defaultProvider: 'macos',
        providers: {
          macos: { tts: { voice: 'Samantha' } },
        },
        channels: {
          telegram: { enabled: true, acceptVoice: true, sendVoice: true },
          discord: { enabled: true, acceptVoice: true, sendVoice: true },
        },
      },
    } : {}),
    ...(Object.keys(starterSkillEntries).length > 0 ? {
      skills: {
        enabled: true,
        entries: starterSkillEntries,
      },
    } : {}),
    dashboard: {
      token: randomUUID(),
    },
  };
}

export function buildSetupArtifacts(input: SetupBuildInput): { configJson: string; envContent: string; config: Record<string, unknown> } {
  const config = buildSetupConfig(input);
  return {
    configJson: JSON.stringify(config, null, 2),
    envContent: buildEnvContent(input.telegramToken, input.selectedProviders, input.providerSecrets, input.discordToken, input.secretRefs),
    config,
  };
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    console.log(`\n${c.bold('👙🦞✨ SkimpyClaw Setup')} ${c.dim('(dry run)')}\n`);
    if (!existsSync(TEMPLATES_DIR)) {
      throw new Error(`Templates directory not found: ${TEMPLATES_DIR}`);
    }
    const templates = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md'));
    if (templates.length === 0) {
      throw new Error(`No markdown templates found in ${TEMPLATES_DIR}`);
    }
    // Validate launchd template exists. Full render validation requires built dist/
    // which may not be present in dry-run contexts (e.g. CI test-only jobs).
    if (!existsSync(GATEWAY_PLIST_TEMPLATE)) {
      throw new Error(`Gateway launchd template not found: ${GATEWAY_PLIST_TEMPLATE}`);
    }

    console.log('✅ Onboarding dry run successful.');
    console.log(`Would create config under: ${CONFIG_DIR}`);
    console.log(`Would copy ${templates.length} templates to: ${AGENTS_DIR}`);
    console.log(`Would render launchd plist from: ${GATEWAY_PLIST_TEMPLATE}`);
    return;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const existing = loadExistingSetup();
    const isReconfigure = existing.config !== null;

    if (isReconfigure) {
      console.log(`\n${c.bold('👙🦞✨ SkimpyClaw Setup')} ${c.dim('(reconfigure — press Enter to keep current values)')}\n`);
    } else {
      console.log(`\n${c.bold('👙🦞✨ SkimpyClaw Setup')}\n`);
    }

    // 1. Telegram Bot Token
    const existingTgToken = existing.env.TELEGRAM_BOT_TOKEN || '';
    sectionHeader('1. Telegram Bot Token');
    console.log('   Get one from @BotFather: https://t.me/BotFather');
    let telegramToken: string;
    if (existingTgToken) {
      const input = await ask(rl, `   Enter token [${maskInput(existingTgToken)}]: `);
      telegramToken = input || existingTgToken;
    } else {
      telegramToken = await ask(rl, '   Enter token: ');
    }
    console.log(`   ✓ ${maskInput(telegramToken)}\n`);

    // 2. Telegram ID
    const existingTgId = String(existing.config?.channels?.telegram?.allowFrom?.[0] || '');
    sectionHeader('2. Your Telegram ID');
    console.log('   Get it from @userinfobot: https://t.me/userinfobot');
    let telegramId: string;
    while (true) {
      const defaultHint = existingTgId ? ` [${existingTgId}]` : '';
      const input = await ask(rl, `   Enter ID${defaultHint}: `);
      telegramId = input || existingTgId;
      if (/^\d+$/.test(telegramId)) break;
      console.log('   ✗ Telegram user IDs are numbers. Send /start to @userinfobot to find yours.');
    }
    console.log(`   ✓ ${telegramId}\n`);

    // 2b. Optional Discord
    const existingDiscord = existing.config?.channels?.discord?.enabled === true;
    sectionHeader('2b. Discord Bot (optional)');
    const discordDefault = existingDiscord ? 'Y' : 'N';
    const useDiscord = /^y(es)?$/i.test(await ask(rl, `   Enable Discord channel? [${existingDiscord ? 'Y/n' : 'y/N'}]: `) || discordDefault);
    let discordToken = '';
    let discordUserId = '';
    let discordDefaultChannelId = '';
    if (useDiscord) {
      const existingDiscordToken = existing.env.DISCORD_BOT_TOKEN || '';
      const existingDiscordUserId = String(existing.config?.channels?.discord?.allowFrom?.[0] || '');
      const existingDiscordChannelId = existing.config?.channels?.discord?.defaultChannelId || '';
      console.log('   Create bot in Discord Developer Portal, then copy token and user ID.');
      const dtInput = await ask(rl, existingDiscordToken ? `   Enter Discord bot token [${maskInput(existingDiscordToken)}]: ` : '   Enter Discord bot token: ');
      discordToken = dtInput || existingDiscordToken;
      const duInput = await ask(rl, existingDiscordUserId ? `   Enter your Discord user ID [${existingDiscordUserId}]: ` : '   Enter your Discord user ID: ');
      discordUserId = duInput || existingDiscordUserId;
      const dcInput = await ask(rl, existingDiscordChannelId ? `   Optional default channel ID [${existingDiscordChannelId}]: ` : '   Optional default channel ID for proactive alerts: ');
      discordDefaultChannelId = dcInput || existingDiscordChannelId;
      console.log(`   ✓ ${maskInput(discordToken)}\n`);
    } else {
      console.log('   ✓ skipped\n');
    }

    // 3. Model Providers
    const existingProviders = isReconfigure ? detectExistingProviders(existing.config) : undefined;
    const selectedProviders = await askProviders(rl, existingProviders);
    const providerSecrets = await collectProviderSecrets(rl, selectedProviders, isReconfigure ? existing.env : undefined);

    // 4. Agent Name
    const existingAgentName = existing.config?.agents?.list?.main?.identity?.name || '';
    sectionHeader('4. Agent Name');
    const agentNameDefault = existingAgentName || 'SkimpyClaw';
    const agentName = (await ask(rl, `   What should I call myself? [${agentNameDefault}]: `)) || agentNameDefault;
    console.log(`   ✓ ${agentName}\n`);

    // 5. Your Name
    sectionHeader('5. Your Name');
    const userName = (await ask(rl, '   What should I call you? ')) || 'User';
    statusOk(userName);

    // 6. Workspace Directory
    sectionHeader('6. Workspace Directory');
    console.log('   The agent can read/write files in allowed directories.');
    console.log('   ~/.skimpyclaw is always included. Add project directories here.');
    const existingExtraPaths = existing.config?.channels?.telegram?.defaultAllowedPaths
      ?.filter((p: string) => p !== '${HOME}/.skimpyclaw') || [];
    const existingExtra = existingExtraPaths.join(', ');
    const workspaceDirInput = await ask(rl, `   Additional directory to allow (or Enter to skip)${existingExtra ? ` [${existingExtra}]` : ''}: `);
    const extraAllowedPaths: string[] = [];
    if (workspaceDirInput) {
      extraAllowedPaths.push(workspaceDirInput);
      statusOk(`Added: ${workspaceDirInput}`);
    } else if (existingExtra) {
      extraAllowedPaths.push(...existingExtraPaths);
      statusOk(`Keeping: ${existingExtra}`);
    } else {
      statusOk('Only ~/.skimpyclaw (default)');
    }

    // 7. Tool Safety Consent
    sectionHeader('7. Safety Notice');
    console.log('   ⚠ This agent can:');
    console.log('     • Read and write files in allowed directories');
    console.log('     • Run terminal commands (with safety filters and approval gates)');
    console.log('     • Send messages via configured channels (Telegram, Discord)');
    console.log('     • Access MCP tools if configured');
    console.log('');
    const consent = /^y(es)?$/i.test(await ask(rl, '   Do you understand and accept these capabilities? [y/N]: '));
    if (!consent) {
      console.log(`\n${c.red('Setup cancelled.')} Re-run when ready.`);
      rl.close();
      return;
    }
    statusOk('Acknowledged');

    // 8. Optional Features
    const existingVoice = existing.config?.voice?.enabled === true;
    sectionHeader('Optional Features');

    // Voice/TTS
    const voiceDefault = existingVoice ? 'Y' : 'N';
    const enableVoice = /^y(es)?$/i.test(await ask(rl, `   Enable voice/TTS? (requires ffmpeg) [${existingVoice ? 'Y/n' : 'y/N'}]: `) || voiceDefault);
    if (enableVoice) {
      const ffmpeg = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' });
      if (ffmpeg.status === 0) {
        statusOk('ffmpeg detected');
      } else {
        statusWarn('ffmpeg not found — voice features may not work until ffmpeg is installed');
      }

      // Check for STT (speech-to-text) capability
      const whisperCli = spawnSync('which', ['whisper-cli'], { encoding: 'utf-8' });
      const whisperPy = spawnSync('which', ['whisper'], { encoding: 'utf-8' });
      if (whisperCli.status === 0) {
        statusOk('whisper-cli detected (whisper.cpp)');
      } else if (whisperPy.status === 0) {
        statusOk('whisper detected (Python)');
      } else {
        console.log('');
        console.log('   ┌─────────────────────────────────────────────────────────┐');
        console.log('   │  Voice transcription (STT) requires local whisper.cpp:  │');
        console.log('   │                                                         │');
        console.log('   │  Local whisper.cpp (free, recommended)                  │');
        console.log('   │    brew install whisper-cpp                             │');
        console.log('   │    whisper-cpp-download-ggml-model small                │');
        console.log('   │                                                         │');
        console.log('   │  Without either, voice messages cannot be transcribed.  │');
        console.log('   └─────────────────────────────────────────────────────────┘');
        console.log('');
      }
    } else {
      statusOk('voice disabled');
    }

    // MCP tools
    console.log('   Install mcporter: https://github.com/steipete/mcporter');
    const enableMcp = /^y(es)?$/i.test(await ask(rl, '   Enable MCP tools? (requires mcporter at ~/.mcporter/) [y/N]: '));
    if (enableMcp) {
      const mcporterConfig = join(homedir(), '.mcporter', 'mcporter.json');
      if (existsSync(mcporterConfig)) {
        statusOk('mcporter config found');
      } else {
        statusWarn(`mcporter config not found at ${mcporterConfig} — MCP tools won't load until configured`);
      }
    } else {
      statusOk('MCP tools disabled');
    }

    const features: SetupFeatures = {
      voice: enableVoice,
      mcp: enableMcp,
    };

    sectionHeader('Starter Packs (optional)');
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const addTechNewsCron = /^y(es)?$/i.test(await ask(rl, '   Add starter cron: top 10 Hacker News daily? [y/N]: '));
    let cronTimezone = localTz;
    if (addTechNewsCron) {
      const tzInput = await ask(rl, `   Timezone for starter cron jobs [${localTz}]: `);
      cronTimezone = tzInput || localTz;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: cronTimezone });
      } catch {
        console.log(`   ⚠ Invalid timezone "${cronTimezone}", using ${localTz}`);
        cronTimezone = localTz;
      }
    }
    const addDailyNotesSkill = /^y(es)?$/i.test(await ask(rl, '   Add starter skill: daily-notes? [y/N]: '));

    const starters: SetupStarters = {
      cronTechNews: addTechNewsCron,
      cronWeather: false,
      timezone: cronTimezone,
      weatherLocation: '',
      skillDailyNotes: addDailyNotesSkill,
      skillWeather: false,
      skillWebSearch: false,
    };

    // Store secrets in macOS Keychain when available (default on macOS)
    const { refs: secretRefs, useKeychain, storedCount } = storeSecretsSecurely(
      providerSecrets,
      telegramToken,
      useDiscord ? discordToken : undefined,
    );
    if (useKeychain) {
      statusOk(`${storedCount} secret(s) stored in macOS Keychain`);
    }

    const { envContent, config: generatedConfig } = buildSetupArtifacts({
      workspaceDir: extraAllowedPaths[0] || join(homedir(), '.skimpyclaw'),
      extraAllowedPaths,
      telegramId,
      telegramToken,
      discordToken: useDiscord ? discordToken : undefined,
      discordUserId: useDiscord ? discordUserId : undefined,
      discordDefaultChannelId: useDiscord ? discordDefaultChannelId : undefined,
      agentName,
      selectedProviders,
      providerSecrets,
      secretRefs,
      features,
      starters,
    });

    // On reconfigure, preserve dashboard token, cron jobs, codeAgents config, security, langfuse
    if (isReconfigure && existing.config) {
      if (existing.config.dashboard?.token) {
        (generatedConfig as any).dashboard = existing.config.dashboard;
      }
      if (Array.isArray(existing.config.cron?.jobs)) {
        const existingCronJobs = existing.config.cron.jobs;
        const starterCronJobs = ((generatedConfig as any).cron?.jobs || []) as Array<Record<string, unknown>>;
        const mergedCronJobs = [...existingCronJobs];
        for (const starter of starterCronJobs) {
          const id = String((starter as any).id || '');
          if (!id) continue;
          if (!mergedCronJobs.some((job: any) => String(job.id) === id)) {
            mergedCronJobs.push(starter as any);
          }
        }
        (generatedConfig as any).cron = { ...(existing.config.cron || {}), jobs: mergedCronJobs };
      }
      if ((existing.config as any).codeAgents) {
        (generatedConfig as any).codeAgents = (existing.config as any).codeAgents;
      }
      if (existing.config.security) {
        (generatedConfig as any).security = existing.config.security;
      }
      if (existing.config.langfuse) {
        (generatedConfig as any).langfuse = existing.config.langfuse;
      }
      // Preserve voice provider config if voice was already configured
      if (existing.config.voice?.providers && Object.keys(existing.config.voice.providers).length > 0) {
        (generatedConfig as any).voice = existing.config.voice;
      }
      if (existing.config.skills) {
        const generatedSkills = ((generatedConfig as any).skills || {}) as any;
        (generatedConfig as any).skills = {
          ...existing.config.skills,
          ...generatedSkills,
          entries: {
            ...(existing.config.skills.entries || {}),
            ...(generatedSkills.entries || {}),
          },
        };
      }
    }

    // Create directories
    console.log('Creating directories...');
    for (const dir of [
      CONFIG_DIR,
      join(CONFIG_DIR, 'logs'),
      join(CONFIG_DIR, 'sessions'),
      join(CONFIG_DIR, 'cron'),
      AGENTS_DIR,
      join(AGENTS_DIR, 'memory'),
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    const configPath = join(CONFIG_DIR, 'config.json');
    saveConfig(generatedConfig as unknown as Config);
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

    const createdFallbackTemplates = ensureCoreTemplates(AGENTS_DIR);
    if (createdFallbackTemplates.length > 0) {
      console.log(`✓ Added missing core templates: ${createdFallbackTemplates.join(', ')}`);
    }

    const createdSkills = ensureStarterSkills(starters);
    if (createdSkills.length > 0) {
      console.log(`✓ Starter skills created: ${createdSkills.join(', ')}`);
    }

    // Merge secrets into .env (preserve existing keys not in new content)
    const envPath = join(CONFIG_DIR, '.env');
    if (isReconfigure && existsSync(envPath)) {
      const existingLines = readFileSync(envPath, 'utf-8').split('\n');
      const newKeys = new Set<string>();
      for (const line of envContent.split('\n')) {
        const m = line.match(/^([A-Z_]+)=/);
        if (m) newKeys.add(m[1]);
      }
      // Keep existing keys that aren't being replaced
      const preserved = existingLines.filter((line) => {
        const m = line.match(/^([A-Z_]+)=/);
        return m && !newKeys.has(m[1]);
      });
      const merged = envContent.trim() + (preserved.length ? '\n' + preserved.join('\n') : '') + '\n';
      writeSetupEnvFile(envPath, merged);
      console.log(`✓ Secrets merged into ${envPath}`);
    } else {
      writeSetupEnvFile(envPath, envContent);
      console.log(`✓ Secrets written to ${envPath}`);
    }

    // Update USER.md with name
    writeFileSync(join(AGENTS_DIR, 'USER.md'), `# USER.md - About ${userName}\n\nName: ${userName}\n\n## Preferences\n\n- Direct communication, no fluff\n\n## Routines\n\n- Morning: Review tasks and messages\n- EOD: Review completed work, plan tomorrow\n`);

    // Create launchd plist from template
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${GATEWAY_PLIST_LABEL}.plist`);
    const plistContent = renderGatewayPlist();

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plistContent);
    console.log(`✓ Daemon plist written to ${plistPath}`);

    sectionHeader('Post-Setup Validation');
    console.log('   Running doctor checks...\n');
    const { report } = await runDoctorChecks();
    let failCount = 0;
    for (const check of report.checks) {
      if (check.ok) {
        console.log(`   ${c.green('PASS')} ${check.name} ${c.dim(`— ${check.detail}`)}`);
      } else {
        failCount++;
        console.log(`   ${c.red('FAIL')} ${check.name} — ${check.detail}`);
        if (check.remedy) {
          console.log(`         ${c.dim(check.remedy)}`);
        }
      }
    }

    if (failCount === 0) {
      console.log(`\n${c.green('✅ Setup complete. Run `skimpyclaw start` to begin.')}\n`);
    } else {
      console.log(`\n${c.yellow(`⚠ Setup complete with ${failCount} warning${failCount > 1 ? 's' : ''}. Run \`skimpyclaw doctor\` for details.`)}\n`);
    }

    const dashboardToken = (generatedConfig.dashboard as any)?.token || 'unknown';
    console.log(`${c.bold('Dashboard')}`);
    console.log(`   URL:   http://localhost:18790/dashboard`);
    console.log(`   Token: ${c.cyan(dashboardToken)}`);
    console.log(`   ${c.dim('(shown during setup only; skimpyclaw status omits credentials)')}`);

    console.log('\nNext steps:');
    let step = 1;
    console.log(`${step++}. Review templates in ~/.skimpyclaw/agents/main/`);
    console.log(`${step++}. Start the daemon:`);
    console.log('   skimpyclaw start --daemon');
    console.log(`${step++}. Check health:`);
    console.log('   skimpyclaw status');
    console.log(`${step++}. Optional daemon controls: skimpyclaw stop | skimpyclaw restart`);
    console.log(`${step++}. Send /help in your ${useDiscord ? 'Discord bot DM/server' : 'Telegram bot'}`);
    console.log('');
    console.log(`${c.yellow('Note:')} The /code tool requires an external coding CLI on your PATH:`);
    console.log('   • Claude Code CLI  →  https://docs.anthropic.com/en/docs/claude-code');
    console.log('   • Codex CLI        →  https://github.com/openai/codex');
    console.log('   Install at least one to use code_with_agent.');
    console.log('\n👙🦞 Enjoy!');
  } finally {
    rl.close();
  }
}

export function writeSetupEnvFile(path: string, content: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
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

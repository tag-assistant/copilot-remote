import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProviderConfig, type RemoteProviderConfig } from './provider-config.js';

export interface CliRunnerDeps {
  env?: NodeJS.ProcessEnv;
  execSync?: typeof execSync;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  log?: (message: string) => void;
  startMain?: () => Promise<void>;
  runInstaller?: (scriptPath: string, args: string[], env: NodeJS.ProcessEnv) => number;
  installerPath?: string;
}

const HELP_TEXT = `
  copilot-remote — Control GitHub Copilot CLI from Telegram

  Usage:
    copilot-remote install [--hackable]
    copilot-remote daemon-install [--hackable]
    copilot-remote --token <bot-token> --github-token <gh-token>
    copilot-remote --token <bot-token> --provider-base-url <url>

  Commands:
    install              Install the persistent launchd/systemd daemon
    daemon-install       Alias for install

  Options:
    --token, -t          Telegram bot token (or COPILOT_REMOTE_BOT_TOKEN)
    --github-token, -g   GitHub token for Copilot (or GITHUB_TOKEN)
    --cli-url, -c        Existing headless Copilot CLI server URL (or COPILOT_REMOTE_CLI_URL)
    --provider-type      BYOK provider type: openai, azure, anthropic
    --provider-base-url  BYOK provider base URL
    --provider-api-key   BYOK provider API key
    --provider-bearer-token  BYOK static bearer token
    --provider-wire-api  BYOK wire API: completions or responses
    --provider-azure-api-version  Azure API version override
    --fake-telegram      Use local mock Telegram harness (no real bot required)
    --workdir, -w        Working directory (default: ~)
    --binary, -b         Path to copilot binary (auto-detected)
    --allowed-users, -u  Comma-separated Telegram user IDs (default: auto-pair)
    --help, -h           Show this message

  Environment variables:
    COPILOT_REMOTE_BOT_TOKEN    Telegram bot token
    GITHUB_TOKEN                GitHub token for Copilot auth
    COPILOT_REMOTE_CLI_URL      Existing headless Copilot CLI server URL
    COPILOT_REMOTE_PROVIDER_TYPE  BYOK provider type
    COPILOT_REMOTE_PROVIDER_BASE_URL  BYOK provider base URL
    COPILOT_REMOTE_PROVIDER_API_KEY  BYOK API key
    COPILOT_REMOTE_PROVIDER_BEARER_TOKEN  BYOK bearer token
    COPILOT_REMOTE_PROVIDER_WIRE_API  BYOK wire API
    COPILOT_REMOTE_PROVIDER_AZURE_API_VERSION  Azure API version override
    COPILOT_REMOTE_FAKE_TELEGRAM  Set to 1 to use the local mock Telegram harness
    COPILOT_REMOTE_WORKDIR      Working directory
    COPILOT_REMOTE_BINARY       Path to copilot binary
    COPILOT_REMOTE_ALLOWED_USERS  Comma-separated user IDs
`;

function getArg(args: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  }
  return undefined;
}

function resolveGhToken(exec: typeof execSync): string | undefined {
  try {
    return exec('gh auth token 2>/dev/null', { encoding: 'utf-8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultInstallerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');
}

function defaultRunInstaller(scriptPath: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync('bash', [scriptPath, ...args], {
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function runCli(rawArgs: string[], deps: CliRunnerDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const runExecSync = deps.execSync ?? execSync;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const error = deps.error ?? ((message: string) => console.error(message));
  const log = deps.log ?? ((message: string) => console.log(message));
  const startMain = deps.startMain ?? (async () => {
    await import('./index.js');
  });
  const runInstaller = deps.runInstaller ?? defaultRunInstaller;
  const installerPath = deps.installerPath ?? defaultInstallerPath();

  const [command, ...commandArgs] = rawArgs;
  if (command === 'install' || command === 'daemon-install') {
    try {
      return runInstaller(installerPath, commandArgs, env);
    } catch (installerError) {
      error(`Failed to run installer: ${installerError instanceof Error ? installerError.message : String(installerError)}`);
      return 1;
    }
  }

  const args = rawArgs;
  if (args.includes('--help') || args.includes('-h')) {
    log(HELP_TEXT);
    return 0;
  }

  const token = getArg(args, ['--token', '-t']) ?? env.COPILOT_REMOTE_BOT_TOKEN;
  const githubToken = getArg(args, ['--github-token', '-g']) ?? env.GITHUB_TOKEN ?? resolveGhToken(runExecSync);
  const cliUrl = getArg(args, ['--cli-url', '-c']) ?? env.COPILOT_REMOTE_CLI_URL;
  const provider = resolveProviderConfig({
    type: getArg(args, ['--provider-type']) as RemoteProviderConfig['type'] | undefined,
    baseUrl: getArg(args, ['--provider-base-url']),
    apiKey: getArg(args, ['--provider-api-key']),
    bearerToken: getArg(args, ['--provider-bearer-token']),
    wireApi: getArg(args, ['--provider-wire-api']) as 'completions' | 'responses' | undefined,
    azure: {
      apiVersion: getArg(args, ['--provider-azure-api-version']),
    },
  });
  const fakeTelegram = args.includes('--fake-telegram') || env.COPILOT_REMOTE_FAKE_TELEGRAM === '1';
  const workdir = getArg(args, ['--workdir', '-w']) ?? env.COPILOT_REMOTE_WORKDIR ?? env.HOME ?? process.cwd();
  const binary = getArg(args, ['--binary', '-b']) ?? env.COPILOT_REMOTE_BINARY;
  const allowedUsers = getArg(args, ['--allowed-users', '-u']) ?? env.COPILOT_REMOTE_ALLOWED_USERS;

  if (!githubToken && !cliUrl && !provider) {
    warn('Warning: No GITHUB_TOKEN or gh auth token detected.');
    warn('  Copilot auth may fail unless this machine is already authenticated.');
    warn('  Fix with: gh auth login, --github-token, --cli-url, or a BYOK provider.');
  }

  if (token) env.COPILOT_REMOTE_BOT_TOKEN = token;
  if (githubToken && !cliUrl && !provider) env.GITHUB_TOKEN = githubToken;
  if (cliUrl) env.COPILOT_REMOTE_CLI_URL = cliUrl;
  if (fakeTelegram) env.COPILOT_REMOTE_FAKE_TELEGRAM = '1';
  if (provider?.type) env.COPILOT_REMOTE_PROVIDER_TYPE = provider.type;
  if (provider?.baseUrl) env.COPILOT_REMOTE_PROVIDER_BASE_URL = provider.baseUrl;
  if (provider?.apiKey) env.COPILOT_REMOTE_PROVIDER_API_KEY = provider.apiKey;
  if (provider?.bearerToken) env.COPILOT_REMOTE_PROVIDER_BEARER_TOKEN = provider.bearerToken;
  if (provider?.wireApi) env.COPILOT_REMOTE_PROVIDER_WIRE_API = provider.wireApi;
  if (provider?.azure?.apiVersion) env.COPILOT_REMOTE_PROVIDER_AZURE_API_VERSION = provider.azure.apiVersion;
  env.COPILOT_REMOTE_WORKDIR = workdir;
  if (binary) env.COPILOT_REMOTE_BINARY = binary;
  if (allowedUsers) env.COPILOT_REMOTE_ALLOWED_USERS = allowedUsers;

  await startMain();
  return 0;
}
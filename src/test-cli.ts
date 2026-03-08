// Copilot Remote — CLI Test Client
// Tests Session class directly, no Telegram dependency.
// Usage: npx tsx src/test-cli.ts [--debug] [--autopilot] [--cwd /path]
import { Session } from './session.js';
import { log } from './log.js';
import * as readline from 'readline';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const autopilot = args.includes('--autopilot');
const cwdIdx = args.indexOf('--cwd');
const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();

if (debug) log.enabled = true;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(): Promise<string> {
  return new Promise((resolve) => rl.question('\n> ', resolve));
}

async function main() {
  console.log('⚡ Copilot Remote — CLI Test');
  console.log('  cwd: ' + cwd);
  console.log('  autopilot: ' + autopilot);
  console.log('  debug: ' + debug);
  console.log('  Type /help for commands, Ctrl+C to quit\n');

  const session = new Session();

  // Wire up event logging
  session.on('delta', (t: string) => process.stdout.write(t));
  session.on('thinking', (t: string) => {
    if (debug) process.stdout.write('💭 ' + t);
  });
  session.on('tool_start', (t: any) =>
    console.log('\n🔧 ' + t.toolName + (t.arguments?.command ? ' `' + t.arguments.command + '`' : '')),
  );
  session.on('tool_complete', (t: any) => console.log('  ' + (t.success !== false ? '✓' : '✗')));
  session.on('permission_request', (req: any) => {
    const p = req.permissionRequest ?? req;
    console.log('\n⚠️  Permission: ' + p.kind + ' — ' + (p.fullCommandText ?? p.url ?? p.intention ?? ''));
    console.log('  Auto-approving (test mode)');
    session.approve();
  });
  session.on('error', (e: string) => console.error('\n❌ ' + e));

  try {
    await session.start({ cwd, autopilot });
    console.log('✅ Session started: ' + session.sessionId);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }

  // Main loop
  while (true) {
    const text = (await askQuestion()).trim();
    if (!text) continue;

    if (text === '/quit' || text === '/exit') {
      await session.kill();
      process.exit(0);
    }
    if (text === '/debug') {
      log.enabled = !log.enabled;
      continue;
    }
    if (text === '/status') {
      try {
        const [model, mode] = await Promise.all([
          session.getCurrentModel().catch(() => null),
          session.getMode().catch(() => null),
        ]);
        console.log(
          'Model: ' +
            ((model as any)?.modelId ?? '?') +
            ' | Mode: ' +
            (mode ?? '?') +
            ' | Autopilot: ' +
            session.autopilot,
        );
      } catch (e) {
        console.error(e);
      }
      continue;
    }
    if (text === '/new') {
      await session.newSession();
      console.log('🆕 New session');
      continue;
    }
    if (text === '/autopilot') {
      session.autopilot = !session.autopilot;
      console.log('Autopilot: ' + session.autopilot);
      continue;
    }
    if (text === '/models') {
      const models = await session.listModels();
      models.forEach((m) => console.log('  ' + ((m as any).id ?? (m as any).name)));
      continue;
    }
    if (text === '/tools') {
      try {
        const r = await session.listTools();
        const t = (r as any)?.tools ?? r;
        if (Array.isArray(t)) t.forEach((x: any) => console.log('  ' + (x.name ?? x)));
      } catch (e) {
        console.error(e);
      }
      continue;
    }
    if (text === '/compact') {
      try {
        const r = await session.compact();
        console.log('Compacted:', JSON.stringify(r));
      } catch (e) {
        console.error(e);
      }
      continue;
    }
    if (text === '/usage') {
      try {
        const q = await session.getQuota();
        console.log(JSON.stringify(q, null, 2));
      } catch (e) {
        console.error(e);
      }
      continue;
    }
    if (text === '/help') {
      console.log('/status  /new  /debug  /autopilot  /models  /tools  /compact  /usage  /quit');
      continue;
    }

    // Send as prompt
    try {
      console.log('');
      await session.send(text);
      console.log('');
    } catch (err) {
      console.error('❌ ' + err);
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

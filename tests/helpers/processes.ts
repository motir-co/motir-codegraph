import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

/** The `package.json` scripts, as written. */
export function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

/**
 * The arguments `node` is run with by a `package.json` script, so a test
 * starts a program exactly as `pnpm <name>` does (`--env-file-if-exists`
 * included; a `.env` never overrides a variable the test sets).
 */
export function scriptNodeArgs(name: string): string[] {
  const script = packageScripts()[name];
  if (script === undefined) {
    throw new Error(`package.json has no script ${name}`);
  }
  const [command, ...args] = script.split(/\s+/);
  if (command !== 'node') {
    throw new Error(`script ${name} does not run node: ${script}`);
  }
  return args;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a script's command to completion with `env` added to the test's own,
 * and `args` appended to its own arguments, as `pnpm <name> <args…>` does.
 */
export async function runScript(
  name: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = [],
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [...scriptNodeArgs(name), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

export interface ServerProcess {
  child: ChildProcess;
  /** e.g. `http://127.0.0.1:41234` */
  baseUrl: string;
  /** Everything the process wrote so far, stdout and stderr. */
  output(): string;
  stop(): Promise<void>;
}

const LISTENING = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/;

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts one copy of the server as `pnpm serve` does, on a port the kernel
 * picks (`PORT=0`), and resolves once it is listening and `GET /health`
 * answers 200. A copy that does not start is killed and the error names its
 * output.
 */
export async function startServerProcess(appUrl: string): Promise<ServerProcess> {
  const child = spawn(process.execPath, scriptNodeArgs('serve'), {
    cwd: ROOT,
    env: { ...process.env, DATABASE_APP_URL: appUrl, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const stop = () => stopChild(child);
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`server did not start:\n${output}`));
      }, 30_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${String(code)}:\n${output}`));
      });
      child.stdout.on('data', () => {
        const match = LISTENING.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    await waitForHealth(baseUrl, 200, 10_000);
    return { child, baseUrl, output: () => output, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Polls `GET /health` until it answers `status`, or fails after `timeoutMs`. */
export async function waitForHealth(
  baseUrl: string,
  status: number,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; afterMs: number }> {
  const started = Date.now();
  let last = 'no answer';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body: unknown = await response.json();
      if (response.status === status) {
        return { status, body, afterMs: Date.now() - started };
      }
      last = `${String(response.status)} ${JSON.stringify(body)}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`/health did not answer ${String(status)} in ${String(timeoutMs)} ms: ${last}`);
}

/** Stops every process, whether or not some already exited. */
export async function stopAll(processes: (ServerProcess | undefined)[]): Promise<void> {
  await Promise.all(
    processes
      .filter((process): process is ServerProcess => process !== undefined)
      .map((process) => process.stop()),
  );
}

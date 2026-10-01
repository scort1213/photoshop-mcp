import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import { prefixExtendScriptBom } from '../utils/extendscript-file.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
import { ScriptExecutor } from './script-executor.js';
import {
  OperationRunner,
  runOperationBridge,
  registerInspectionPath,
  operationNeedsInspection,
} from './operation-safety.js';
import { getLocalTempRoot, resolveLocalPath, toAdobePath } from '../utils/local-path.js';

const execFileAsync = promisify(execFile);

/** Escape a string for use as a pgrep -f pattern (extended regex). */
export function escapeForPgrep(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envTruthy(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** Slack added to the AppleScript-side timeout beyond the tool timeout, so the
 * JSX gets its full advertised budget plus Apple-event overhead. */
const APPLESCRIPT_TIMEOUT_MARGIN_SECONDS = 5;

/** Extra grace before Node SIGKILLs osascript, beyond the AppleScript timeout.
 * Keeps the AppleScript timeout strictly below the hard kill so Photoshop gets
 * a clean AppleEvent timeout error instead of a dead pipe. */
const KILL_GRACE_MS = 5000;

/**
 * AppleScript `with timeout of N seconds` value for a given tool timeout.
 * Without this block AppleScript's default ~120s Apple-event reply timeout
 * silently caps every `do javascript` call regardless of the tool timeout.
 */
export function appleScriptTimeoutSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) + APPLESCRIPT_TIMEOUT_MARGIN_SECONDS;
}

/** Hard outer bound: osascript is SIGKILLed after this many ms. Always strictly
 * above the AppleScript timeout so the clean AppleEvent error fires first. */
export function killTimeoutMs(timeoutMs: number): number {
  return appleScriptTimeoutSeconds(timeoutMs) * 1000 + KILL_GRACE_MS;
}

function appleScriptStringLiteral(value: string): string {
  return (
    '"' +
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') +
    '"'
  );
}

export class MacOSExecutor implements ScriptExecutor {
  private logger: Logger;
  private operations = new OperationRunner();
  private appName: string = 'Adobe Photoshop 2025';

  constructor() {
    this.logger = new Logger('MacOSExecutor');
  }

  setAppName(appName: string): void {
    this.appName = appName;
    this.logger.debug(`App name set to: ${appName}`);
  }

  async execute(script: string, timeout = 30000): Promise<unknown> {
    return this.operations.run(
      () =>
        runOperationBridge((onChild, beforeDispatch, remainingMs) =>
          this.executeScript(script, remainingMs, onChild, beforeDispatch)
        ),
      timeout
    );
  }

  runTransaction<T>(body: () => Promise<T>, timeout = 30000): Promise<T> {
    return this.operations.run(body, timeout);
  }

  protected async executeScript(
    script: string,
    timeout = 30000,
    onChild: (pid: number) => Promise<void> = async () => {},
    beforeDispatch: () => void = () => {}
  ): Promise<unknown> {
    const temporaryRoot = getLocalTempRoot();
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(temporaryRoot, 'photoshop-mcp-mac-'));
    registerInspectionPath(directory);
    const jsxPath = join(directory, 'script.jsx');
    const appleScriptPath = join(directory, 'bridge.scpt');
    let uncertain = false;
    try {
      await writeFile(jsxPath, prefixExtendScriptBom(script), 'utf8');
      await writeFile(appleScriptPath, this.createAppleScriptWrapper(jsxPath, timeout), 'utf8');
      beforeDispatch();
      const execution = execFileAsync('/usr/bin/osascript', [appleScriptPath], {
        timeout: killTimeoutMs(timeout),
        killSignal: 'SIGKILL',
      });
      const completion = execution.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      );
      let metadataError: unknown;
      try {
        if (execution.child.pid) await onChild(execution.child.pid);
      } catch (error) {
        metadataError = error;
      }
      const { value, error } = await completion;
      if (metadataError) throw new Error('outcome_unknown: failed to record Adobe bridge process');
      if (error)
        throw new Error(
          'outcome_unknown: Adobe bridge failed; inspect document state: ' +
            (error instanceof Error ? error.message : String(error))
        );
      if (!value) throw new Error('outcome_unknown: Adobe bridge returned no result');
      if (value.stderr) this.logger.warn('Script execution warning:', value.stderr);
      return this.parseResult(value.stdout);
    } catch (error) {
      uncertain = String(error).includes('outcome_unknown');
      if (uncertain)
        throw new Error(
          (error instanceof Error ? error.message : String(error)) +
            '; inspection_path=' +
            directory
        );
      throw error;
    } finally {
      if (!uncertain && !operationNeedsInspection())
        await rm(directory, { recursive: true, force: true });
    }
  }

  private createAppleScriptWrapper(jsxPath: string, timeoutMs: number = 30000): string {
    const activateLine = envTruthy('PHOTOSHOP_ACTIVATE') ? '\tactivate\n' : '';
    const loadScript = '$.evalFile(new File(' + JSON.stringify(toAdobePath(jsxPath)) + '))';
    return `tell application ${appleScriptStringLiteral(this.appName)}
${activateLine}\twith timeout of ${appleScriptTimeoutSeconds(timeoutMs)} seconds
\t\tdo javascript ${appleScriptStringLiteral(loadScript)}
\tend timeout
end tell`;
  }

  private parseResult(output: string): unknown {
    const trimmed = output.trim();

    if (trimmed.startsWith('ERROR:')) {
      throw new Error(trimmed.substring(6).trim());
    }

    return parseExtendScriptPayload(trimmed);
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      // Match the specific app we drive, not any Photoshop — with 2025/2026/
      // Beta installed side by side, a generic match reports "running" while
      // the target version is not.
      const pattern = escapeForPgrep(this.appName);
      const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-f', pattern]);
      return stdout.trim().length > 0;
    } catch {
      // pgrep returns non-zero exit code if no process found
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    photoshopPath = resolveLocalPath(photoshopPath);
    return new Promise((resolve, reject) => {
      this.logger.info(`Launching Photoshop: ${photoshopPath}`);

      // Use 'open' command on macOS to launch the app
      const child = spawn('/usr/bin/open', ['-a', photoshopPath], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      // Wait a bit for Photoshop to start
      setTimeout(() => {
        resolve();
      }, 5000);

      child.on('error', (error) => {
        reject(new Error(`Failed to launch Photoshop: ${error.message}`));
      });
    });
  }
}

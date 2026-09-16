import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { prefixExtendScriptBom } from '../utils/extendscript-file.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
import { Logger } from '../utils/logger.js';
import { acquireLease, assertSafe, quarantine, clearQuarantine, access } from './operation-safety.js';
import { ScriptExecutor } from './script-executor.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class AdobeDispatchRejectedError extends Error {
  constructor() {
    super('application_busy: Photoshop rejected the COM request before execution (RPC_E_SERVERCALL_RETRYLATER); no automatic retry was performed');
  }
}

export function isComDispatchRejection(error: unknown, output: string): boolean {
  // Only the VBS transport exit proves rejection. A script body returning an
  // error string with the same number must still be treated as partial failure.
  return !!error && typeof error === 'object' && 'code' in error && error.code === 1 &&
    /^ERROR: COM -2147417846 \([^\r\n]*\):/.test(output.trim());
}

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = 30000): Promise<unknown> {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('invalid_timeout');
    const deadline = Date.now() + timeout;
    const mode = access.getStore() || 'write';
    return new Promise((resolve, reject) => {
      let expired = false;
      let dispatched = false;
      let timeoutWork: Promise<void> | undefined;
      const timeoutId = setTimeout(() => {
        expired = true;
        timeoutWork = (async () => {
          if (dispatched && mode === 'write') await quarantine('Script exceeded deadline; execution may still be running');
          reject(new Error(dispatched ? 'outcome_unknown: execution timeout; inspect state before recovery' : 'queue_timeout: operation was not dispatched'));
        })().catch(reject);
      }, timeout);
      this.scriptQueue.push(async () => access.run(mode, async () => {
        if (expired || Date.now() >= deadline) { clearTimeout(timeoutId); reject(new Error('queue_timeout: operation was not dispatched')); return; }
        let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
        let result: unknown;
        let failure: unknown;
        try {
          lease = await acquireLease(deadline);
          if (expired || Date.now() >= deadline) throw new Error('queue_timeout: operation was not dispatched');
          await assertSafe();
          if (expired || Date.now() >= deadline) throw new Error('queue_timeout: operation was not dispatched');
          if (mode === 'write') await quarantine('Write in progress; inspect state if interrupted');
          if (expired || Date.now() >= deadline) {
            if (mode === 'write') await clearQuarantine();
            throw new Error('queue_timeout: operation was not dispatched');
          }
          dispatched = true;
          result = await this.executeScript(script, lease.child, () => {
            // Filesystem preparation can stall after the queue lease is taken.
            // Do not start a new COM process after the public deadline expires.
            if (expired || Date.now() >= deadline) {
              throw new Error('queue_timeout: bridge preparation expired before Adobe dispatch');
            }
          });
          clearTimeout(timeoutId);
          if (!expired && mode === 'write') await clearQuarantine();
        } catch (error) {
          failure = error;
          if (error instanceof AdobeDispatchRejectedError && !expired && mode === 'write') {
            await clearQuarantine();
          }
        }
        finally {
          clearTimeout(timeoutId);
          await timeoutWork;
          if (lease) await lease.release();
        }
        if (failure) reject(failure);
        else if (!expired) resolve(result);
      }).catch(reject));
      void this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.scriptQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.scriptQueue.length > 0) {
      const task = this.scriptQueue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          this.logger.error('Script execution failed:', error);
        }
      }
    }

    this.isProcessing = false;
  }

  protected async executeScript(script: string, onChild: (pid: number) => Promise<void>, assertDispatchAllowed: () => void = () => {}): Promise<unknown> {
    // For Windows, we'll use a combination of VBScript/JScript to communicate with Photoshop via COM
    // Write script to temporary file
    const directory = await mkdtemp(join(tmpdir(), 'photoshop-mcp-'));
    const tempScriptPath = join(directory, 'script.jsx');
    
    try {
      await writeFile(tempScriptPath, prefixExtendScriptBom(script), 'utf8');

      // Use VBScript to execute the JSX script via COM
      const vbsPath = join(directory, 'bridge.vbs');
      const resultPath = `${vbsPath}.result`;
      const vbsScript = this.createVBSWrapper(tempScriptPath, resultPath);
      
      await writeFile(vbsPath, '\uFEFF' + vbsScript, 'utf16le');

      try {
        // Use a Unicode result file: cscript stdout uses a locale-dependent
        // code page, and //U can emit no output through Node pipes on Windows.
        try {
          assertDispatchAllowed();
          const execution = execFileAsync('cscript.exe', ['//nologo', vbsPath], { windowsHide: true });
          // Attach the rejection handler before awaiting filesystem work.
          const completion = execution.then(() => null, (error: unknown) => error);
          let metadataError: unknown;
          try { if (execution.child.pid) await onChild(execution.child.pid); } catch (error) { metadataError = error; }
          const executionError = await completion;
          if (metadataError) throw new Error('outcome_unknown: failed to record Adobe bridge process');
          if (executionError) throw executionError;
        } catch (error) {
          const details = await readFile(resultPath, 'utf16le').catch(() => '');
          if (isComDispatchRejection(error, details)) throw new AdobeDispatchRejectedError();
          if (details) this.parseResult(details);
          throw error;
        }
        return this.parseResult(await readFile(resultPath, 'utf16le'));
      } finally {
        // Cleanup VBS file
        await unlink(vbsPath).catch(() => {});
        await unlink(resultPath).catch(() => {});
      }
    } finally {
      // Cleanup JSX file
      await rm(directory, { recursive: true, force: true });
    }
  }

  private createVBSWrapper(jsxPath: string, resultPath: string): string {
    const loadScript = `$.evalFile(${JSON.stringify(jsxPath)})`.replace(/"/g, '""');
    return `
Sub Emit(value)
  Dim output
  Set output = CreateObject("Scripting.FileSystemObject").CreateTextFile("${resultPath.replace(/"/g, '""')}", True, True)
  output.Write CStr(value)
  output.Close
End Sub
On Error Resume Next
Dim photoshopApp
Set photoshopApp = CreateObject("Photoshop.Application")

If Err.Number <> 0 Then
    Emit "ERROR: COM " & CStr(Err.Number) & " (" & Err.Source & "): Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Execute the JSX script
Dim result
result = photoshopApp.DoJavaScript("${loadScript}")

If Err.Number <> 0 Then
    Emit "ERROR: COM " & CStr(Err.Number) & " (" & Err.Source & "): " & Err.Description
    WScript.Quit 1
Else
    Emit result
End If
`.trim();
  }

  private parseResult(output: string): unknown {
    const trimmed = output.trim();
    
    // Check for error
    if (trimmed.startsWith('ERROR:')) {
      throw new Error(trimmed.substring(6).trim() || 'Adobe bridge returned an error without a description; inspect document state before recovery');
    }

    return parseExtendScriptPayload(trimmed);
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Photoshop.exe"');
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info(`Launching Photoshop: ${photoshopPath}`);

      const child = spawn(photoshopPath, [], {
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

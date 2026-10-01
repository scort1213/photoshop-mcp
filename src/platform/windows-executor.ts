import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { prefixExtendScriptBom } from '../utils/extendscript-file.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
import { Logger } from '../utils/logger.js';
import {
  DispatchNotStartedError,
  OperationRunner,
  runOperationBridge,
  registerInspectionPath,
  operationNeedsInspection,
} from './operation-safety.js';
import { getLocalTempRoot, resolveLocalPath, toAdobePath } from '../utils/local-path.js';
import { getWindowsSystemTool } from '../utils/system-tools.js';
import { ScriptExecutor } from './script-executor.js';

const execFileAsync = promisify(execFile);

export class AdobeDispatchRejectedError extends DispatchNotStartedError {
  constructor() {
    super(
      'application_busy: Photoshop rejected the COM request before execution (RPC_E_SERVERCALL_RETRYLATER); no automatic retry was performed'
    );
  }
}

export function isComDispatchRejection(error: unknown, output: string): boolean {
  // Only the VBS transport exit proves rejection. A script body returning an
  // error string with the same number must still be treated as partial failure.
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 1 &&
    /^ERROR: COM -2147417846 \([^\r\n]*\):/.test(output.trim())
  );
}

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private operations = new OperationRunner();

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout = 30000): Promise<unknown> {
    return this.operations.run(
      () =>
        runOperationBridge((onChild, beforeDispatch) =>
          this.executeScript(script, onChild, beforeDispatch)
        ),
      timeout
    );
  }

  runTransaction<T>(body: () => Promise<T>, timeout = 30000): Promise<T> {
    return this.operations.run(body, timeout);
  }

  protected async executeScript(
    script: string,
    onChild: (pid: number) => Promise<void>,
    assertDispatchAllowed: () => void = () => {}
  ): Promise<unknown> {
    // For Windows, we'll use a combination of VBScript/JScript to communicate with Photoshop via COM
    // Write script to temporary file
    const temporaryRoot = getLocalTempRoot();
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(temporaryRoot, 'photoshop-mcp-'));
    registerInspectionPath(directory);
    const tempScriptPath = join(directory, 'script.jsx');
    let uncertain = false;

    try {
      await writeFile(tempScriptPath, prefixExtendScriptBom(script), 'utf8');

      // Use VBScript to execute the JSX script via COM
      const vbsPath = join(directory, 'bridge.vbs');
      const resultPath = `${vbsPath}.result`;
      const vbsScript = this.createVBSWrapper(tempScriptPath, resultPath);

      await writeFile(vbsPath, '\uFEFF' + vbsScript, 'utf16le');

      // Use a Unicode result file: cscript stdout uses a locale-dependent
      // code page, and //U can emit no output through Node pipes on Windows.
      let bridgeError: unknown;
      try {
        const cscript = getWindowsSystemTool('cscript');
        assertDispatchAllowed();
        const execution = execFileAsync(cscript, ['//nologo', vbsPath], { windowsHide: true });
        // Attach the rejection handler before awaiting filesystem work.
        const completion = execution.then(
          () => null,
          (error: unknown) => error
        );
        let metadataError: unknown;
        try {
          if (execution.child.pid) await onChild(execution.child.pid);
        } catch (error) {
          metadataError = error;
        }
        const executionError = await completion;
        if (metadataError)
          throw new Error('outcome_unknown: failed to record Adobe bridge process');
        if (executionError) {
          bridgeError = executionError;
          throw executionError;
        }
      } catch (error) {
        const details = await readFile(resultPath, 'utf16le').catch(() => '');
        if (isComDispatchRejection(error, details)) throw new AdobeDispatchRejectedError();
        if (details) this.parseResult(details);
        if (bridgeError)
          throw new Error(
            'outcome_unknown: Adobe bridge failed; inspect document state: ' +
              (error instanceof Error ? error.message : String(error))
          );
        throw error;
      }
      const output = await readFile(resultPath, 'utf16le').catch(() => {
        throw new Error('outcome_unknown: Adobe bridge produced no result file');
      });
      return this.parseResult(output);
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
      // Cleanup JSX file
      if (!uncertain && !operationNeedsInspection())
        await rm(directory, { recursive: true, force: true });
    }
  }

  private createVBSWrapper(jsxPath: string, resultPath: string): string {
    const loadScript = `$.evalFile(new File(${JSON.stringify(toAdobePath(jsxPath))}))`.replace(
      /"/g,
      '""'
    );
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
      throw new Error(
        trimmed.substring(6).trim() ||
          'Adobe bridge returned an error without a description; inspect document state before recovery'
      );
    }

    return parseExtendScriptPayload(trimmed);
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        getWindowsSystemTool('tasklist'),
        ['/FI', 'IMAGENAME eq Photoshop.exe'],
        { windowsHide: true }
      );
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    photoshopPath = resolveLocalPath(photoshopPath);
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

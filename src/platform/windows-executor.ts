import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { prefixExtendScriptBom } from '../utils/extendscript-file.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
import { Logger } from '../utils/logger.js';
import { ScriptExecutor } from './script-executor.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Script execution timeout'));
      }, timeout);

      this.scriptQueue.push(async () => {
        try {
          const result = await this.executeScript(script);
          clearTimeout(timeoutId);
          resolve(result);
          return result;
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
          throw error;
        }
      });

      this.processQueue();
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

  private async executeScript(script: string): Promise<unknown> {
    // For Windows, we'll use a combination of VBScript/JScript to communicate with Photoshop via COM
    // Write script to temporary file
    const tempScriptPath = join(tmpdir(), `photoshop-script-${Date.now()}.jsx`);
    
    try {
      await writeFile(tempScriptPath, prefixExtendScriptBom(script), 'utf8');

      // Use VBScript to execute the JSX script via COM
      const vbsPath = join(tmpdir(), `photoshop-vbs-${Date.now()}.vbs`);
      const resultPath = `${vbsPath}.result`;
      const vbsScript = this.createVBSWrapper(tempScriptPath, resultPath);
      
      await writeFile(vbsPath, '\uFEFF' + vbsScript, 'utf16le');

      try {
        // Use a Unicode result file: cscript stdout uses a locale-dependent
        // code page, and //U can emit no output through Node pipes on Windows.
        try {
          await execFileAsync('cscript.exe', ['//nologo', vbsPath], { windowsHide: true });
        } catch (error) {
          const details = await readFile(resultPath, 'utf16le').catch(() => '');
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
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createVBSWrapper(jsxPath: string, resultPath: string): string {
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
    Emit "ERROR: Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Execute the JSX script
Dim result
result = photoshopApp.DoJavaScript("$.evalFile('" & Replace("${jsxPath}", "\\", "\\\\") & "')")

If Err.Number <> 0 Then
    Emit "ERROR: " & Err.Description
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
      throw new Error(trimmed.substring(6).trim());
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

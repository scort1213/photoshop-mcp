import { access } from './operation-safety.js';
import { platform } from 'os';
import { Logger } from '../utils/logger.js';
import { PhotoshopDetector } from './detector.js';
import { ScriptExecutor } from './script-executor.js';
import { WindowsExecutor } from './windows-executor.js';
import { MacOSExecutor } from './macos-executor.js';

export interface PhotoshopInfo {
  version: string;
  path: string;
  isRunning: boolean;
  appName?: string;
}

export class PhotoshopConnection {
  private logger: Logger;
  private detector: PhotoshopDetector;
  private executor: ScriptExecutor | null = null;
  private photoshopInfo: PhotoshopInfo | null = null;
  private macosExecutor?: MacOSExecutor;

  constructor() {
    this.logger = new Logger('PhotoshopConnection');
    this.detector = new PhotoshopDetector();
    // Executor is initialized lazily on first use so that constructing a
    // PhotoshopConnection on an unsupported platform (e.g. the Linux CI runner
    // used for the verify-photoshop-prompts script) does not throw immediately.
  }

  /** Returns the platform executor, initializing it on first call. */
  private getExecutor(): ScriptExecutor {
    if (this.executor) return this.executor;

    const platformType = platform();
    if (platformType === 'win32') {
      this.executor = new WindowsExecutor();
    } else if (platformType === 'darwin') {
      this.macosExecutor = new MacOSExecutor();
      this.executor = this.macosExecutor;
    } else {
      throw new Error(`Unsupported platform: ${platformType}`);
    }
    return this.executor;
  }

  async ping(): Promise<boolean> {
    try {
      this.logger.debug('Pinging Photoshop...');
      
      // Try to detect Photoshop if not already detected
      if (!this.photoshopInfo) {
        this.photoshopInfo = await this.detector.detect();
      }

      const executor = this.getExecutor();
      this.applyMacOSAppName();
      if (!await executor.isPhotoshopRunning()) return false;
      const version = await access.run('read', () => executor.execute('app.version', 15000));
      return /^\d{1,3}(?:\.\d+)*$/.test(String(version).trim());
    } catch (error) {
      this.logger.error('Ping failed:', error);
      return false;
    }
  }

  async getVersion(): Promise<string> {
    try {
      if (!this.photoshopInfo) {
        this.photoshopInfo = await this.detector.detect();
      }

      // Windows discovery can return a marketing year from the installation
      // path. Query the host before applying numeric feature-version gates.
      if (platform() === 'win32' && /^20\d{2}$/.test(this.photoshopInfo.version)) {
        const runtimeVersion = String(await access.run('read', () => this.executeScript('app.version'))).trim();
        if (!/^\d{1,3}(?:\.\d+)*$/.test(runtimeVersion)) {
          throw new Error(`Unexpected Photoshop runtime version: ${runtimeVersion}`);
        }
        this.photoshopInfo.version = runtimeVersion;
      }

      return this.photoshopInfo?.version || 'Unknown';
    } catch (error) {
      this.logger.error('Failed to get version:', error);
      throw error;
    }
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    try {
      // Ensure Photoshop is detected
      if (!this.photoshopInfo) {
        this.photoshopInfo = await this.detector.detect();
      }

      const executor = this.getExecutor();
      this.applyMacOSAppName();

      // Check if Photoshop is running, launch if needed
      const isRunning = await executor.isPhotoshopRunning();
      if (!isRunning) {
        this.logger.info('Photoshop not running, launching...');
        await executor.launchPhotoshop(this.photoshopInfo.path);
      }

      // Execute the script
      const result = await executor.execute(script, timeout);
      return result;
    } catch (error) {
      this.logger.error('Script execution failed:', error);
      throw error;
    }
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.photoshopInfo;
  }

  async ensurePhotoshopRunning(): Promise<void> {
    if (!this.photoshopInfo) {
      this.photoshopInfo = await this.detector.detect();
    }

    const executor = this.getExecutor();
    this.applyMacOSAppName();
    const isRunning = await executor.isPhotoshopRunning();
    if (!isRunning) {
      this.logger.info('Launching Photoshop...');
      await executor.launchPhotoshop(this.photoshopInfo.path);
    }
  }

  /**
   * Point the macOS executor at the detected app bundle name. Must run after
   * getExecutor(): the executor is created lazily, and before this ordering fix
   * the first script of every session ran against the hard-coded default
   * ("Adobe Photoshop 2025"), so on any other version pgrep reported Photoshop
   * as not running, launchPhotoshop() stole focus for 5s, and osascript failed
   * to compile `do javascript` (-2741) because the app name did not resolve.
   */
  private applyMacOSAppName(): void {
    if (this.macosExecutor && this.photoshopInfo?.appName) {
      this.macosExecutor.setAppName(this.photoshopInfo.appName);
    }
  }
}

import { access, documentManaged, managedMutation, operationContext } from '../platform/operation-safety.js';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { artboardMutationGuard, ARTBOARD_SCOPED_TOOLS, ARTBOARD_GEOMETRY_TOOLS } from '../core/artboard-guard.js';
import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { documentGuardScript, getTargetDocumentId } from '../core/document-target.js';
import { assertLocalPath } from '../utils/local-path.js';

export type APIType = 'UXP' | 'ExtendScript';

export interface PhotoshopAPI {
  /**
   * Execute a script using the appropriate API
   */
  executeScript(script: string, timeoutMs?: number): Promise<unknown>;

  /**
   * Get the API type being used
   */
  getAPIType(): APIType;
}

export class PhotoshopAPIFactory {
  private logger: Logger;
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.logger = new Logger('PhotoshopAPIFactory');
    this.connection = connection;
  }

  async createAPI(): Promise<PhotoshopAPI> {
    let info = this.connection.getPhotoshopInfo();

    // MCP requests can arrive while session.initialize is still detecting the
    // installed host. Use the connection's detection path before constructing
    // an API instead of reporting a transient missing-info error.
    if (!info) {
      await this.connection.getVersion();
      info = this.connection.getPhotoshopInfo();
    }
    
    if (!info) {
      throw new Error('Photoshop info not available. Please detect Photoshop first.');
    }

    // Determine which API to use based on version
    const apiType = this.determineAPIType(info.version);
    
    this.logger.info(`Creating ${apiType} API for Photoshop version ${info.version}`);

    if (apiType === 'UXP') {
      return new UXPPhotoshopAPI(this.connection);
    } else {
      return new ExtendScriptPhotoshopAPI(this.connection);
    }
  }

  private determineAPIType(version: string): APIType {
    // IMPORTANT: When running scripts via AppleScript/COM, we can only use ExtendScript
    // UXP is only available for plugins, not for external script execution
    // Therefore, we always use ExtendScript for external automation
    
    this.logger.debug(`Using ExtendScript for version ${version} (UXP not available for external scripting)`);
    return 'ExtendScript';
  }
}

/**
 * UXP-based API for modern Photoshop (23.5+)
 * NOTE: UXP is not available for external script execution via AppleScript/COM
 * This class is kept for future plugin-based implementation
 */
class UXPPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeoutMs?: number): Promise<unknown> {
    // UXP cannot be executed externally via AppleScript/COM
    // Fall back to ExtendScript
    return await this.connection.executeScript(script, timeoutMs);
  }

  getAPIType(): APIType {
    return 'UXP';
  }
}

/**
 * ExtendScript-based API for legacy Photoshop (< 23.5)
 */
class ExtendScriptPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeoutMs?: number): Promise<unknown> {
    // Wrap script in error handling
    const preflightMarker = 'MCP_PREFLIGHT_' + randomUUID() + ': ';
    const tool = String(managedMutation.getStore());
    let preparation = '';
    if (ARTBOARD_GEOMETRY_TOOLS.has(tool)) {
      const root = resolve(process.env.PHOTOSHOP_RECOVERY_DIR || join(homedir(), '.photoshop-mcp', 'recovery'));
      assertLocalPath(root);
      await mkdir(root, { recursive: true });
      timeoutMs = timeoutMs ?? 120000;
      preparation = 'var __mcpArtboardOperation = ' + JSON.stringify({ tool, args: operationContext.getStore()?.args || {},
        backup: join(root, randomUUID() + '.psb'), deadline: Date.now() + timeoutMs }) + ';\n';
    }
    const wrappedScript = this.wrapInErrorHandling(script, preflightMarker, preparation);
    const result = await this.connection.executeScript(wrappedScript, timeoutMs);
    // A normal bridge completion proves the body was never entered. Let the
    // executor finish its lease before surfacing this definite rejection.
    if (typeof result === 'string' && result.startsWith(preflightMarker)) {
      throw new Error(result.slice(preflightMarker.length));
    }
    if (result && typeof result === 'object' && '__mcpRecoveryResult' in result) {
      const envelope = result as { __mcpRecoveryResult: string; recoveryBackup: string; value: unknown };
      if (envelope.__mcpRecoveryResult === preflightMarker) {
        const context = operationContext.getStore();
        if (context) context.recoveryBackup = envelope.recoveryBackup;
        return envelope.value;
      }
    }
    return result;
  }

  private wrapInErrorHandling(script: string, preflightMarker: string, preparation = ''): string {
    // ExtendScript has no JSON object, so the result is serialized via
    // toSource()/String(). Errors are surfaced with an "ERROR:" prefix
    // that platform executors translate back into thrown Errors.
    //
    // Ruler and type units are temporarily forced to pixels/points so that
    // every DOM API that accepts plain numbers (translate, textItem.size,
    // textItem.position, doc.crop bounds, etc.) behaves consistently
    // regardless of the user's Photoshop preferences. The user's original
    // preferences are restored in the finally block.
    const targetId = getTargetDocumentId();
    const documentGuard =
      typeof targetId === 'number' ? documentGuardScript(targetId) : (access.getStore() === 'read' || documentManaged.getStore()) ? '' : `if (app.documents.length > 1) throw new Error('ambiguous_document: supply document_id when multiple documents are open');`;
    return `
(function() {
  var __originalRulerUnits = null;
  var __originalTypeUnits = null;
  var __originalSmartQuotes = null;
  var __origDialogs = null;
  var __origAlert = null;
  var __origConfirm = null;
  var __origPrompt = null;
  var __mcpBodyEntered = false;
  try { __originalRulerUnits = app.preferences.rulerUnits; } catch (e) {}
  try { __originalTypeUnits = app.preferences.typeUnits; } catch (e) {}
  try { __originalSmartQuotes = app.preferences.smartQuotes; } catch (e) {}
  try { __origDialogs = app.displayDialogs; } catch (e) {}
  try { app.displayDialogs = DialogModes.NO; } catch (e) {}
  if (typeof alert !== 'undefined') {
    __origAlert = alert;
    alert = function(msg) { $.writeln('[MCP] ' + msg); };
  }
  if (typeof confirm !== 'undefined') {
    __origConfirm = confirm;
    confirm = function() { throw new Error('confirmation_required: interactive confirmation is not automatically accepted'); };
  }
  if (typeof prompt !== 'undefined') {
    __origPrompt = prompt;
    prompt = function(msg, def) {
      $.writeln('[MCP] prompt suppressed: ' + msg);
      return def || '';
    };
  }

  try {
    try { app.preferences.rulerUnits = Units.PIXELS; } catch (e) {}
    try { app.preferences.typeUnits = TypeUnits.POINTS; } catch (e) {}
    // Style/position setters can recompose text and substitute quotes too.
    // Keep literal characters throughout the entire call, not only assignment.
    try { app.preferences.smartQuotes = false; } catch (e) {}

    ${documentGuard}
    ${preparation}
    ${managedMutation.getStore() ? `var __mcpArtboardAllowed = ${ARTBOARD_SCOPED_TOOLS.has(String(managedMutation.getStore()))};\n${artboardMutationGuard}` : ''}

    __mcpBodyEntered = true;
    if (typeof __mcpArtboardScope !== 'undefined' && __mcpArtboardScope) __mcpArtboardScope.begin();
    if (typeof __mcpArtboardOperation !== 'undefined' && Date.now() >= __mcpArtboardOperation.deadline)
      throw new Error('queue_timeout: deadline expired during preparation; edit was not started');
    var result = (function() {
      ${script}
    })();
    if (typeof __mcpArtboardScope !== 'undefined' && __mcpArtboardScope) {
      __mcpArtboardScope.restore();
      __mcpArtboardScope.verify();
    }
    if (typeof __mcpVerifiedBackup !== 'undefined' && __mcpVerifiedBackup)
      result = { __mcpRecoveryResult: ${JSON.stringify(preflightMarker)}, value: result, recoveryBackup: __mcpVerifiedBackup };
    if (typeof result === 'object' && result !== null) {
      return result.toSource ? result.toSource() : String(result);
    }
    return String(result);
  } catch (error) {
    if (!__mcpBodyEntered) return ${JSON.stringify(preflightMarker)} + (error.message || String(error));
    return 'ERROR: ' + (error.message || String(error)) +
      (typeof __mcpVerifiedBackup !== 'undefined' && __mcpVerifiedBackup ? '; recovery_backup=' + __mcpVerifiedBackup : '');
  } finally {
    try { if (__originalRulerUnits !== null) app.preferences.rulerUnits = __originalRulerUnits; } catch (e) {}
    try { if (__originalTypeUnits !== null) app.preferences.typeUnits = __originalTypeUnits; } catch (e) {}
    try { if (__originalSmartQuotes !== null) app.preferences.smartQuotes = __originalSmartQuotes; } catch (e) {}
    try { if (__origDialogs !== null) app.displayDialogs = __origDialogs; } catch (e) {}
    if (__origAlert !== null) { alert = __origAlert; }
    if (__origConfirm !== null) { confirm = __origConfirm; }
    if (__origPrompt !== null) { prompt = __origPrompt; }
    if (typeof __mcpArtboardScope !== 'undefined' && __mcpArtboardScope) __mcpArtboardScope.restore();
  }
})();
    `.trim();
  }

  getAPIType(): APIType {
    return 'ExtendScript';
  }
}

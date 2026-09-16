import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { access, acquireLease, clearQuarantine, documentManaged, managedMutation } from '../platform/operation-safety.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { capture, onMcpClientConnected, onMcpClientDisconnected, recordMcpToolCall } from '../analytics/index.js';
import { ToolRegistry, ToolDefinition } from './tool-registry.js';
import { PromptRegistry } from './prompt-registry.js';
import { Session } from './session.js';
import { wrapToolHandler } from '../errors/envelope.js';
import { withOptionalDocumentId, wrapDocumentIdHandler } from './document-target.js';
import { buildPhotoshopInstructions } from '../prompts/instructions.js';
import { registerPhotoshopPrompts } from '../prompts/registry.js';
import { createDocumentTools } from '../tools/document-tools.js';
import { createLayerTools } from '../tools/layer-tools.js';
import { createImageTools } from '../tools/image-tools.js';
import { createImagePlacementTools } from '../tools/image-placement-tools.js';
import { createSmartObjectTools } from '../tools/smart-object-tools.js';
import { createLayerTransformTools } from '../tools/layer-transform-tools.js';
import { createLayerPropertiesTools } from '../tools/layer-properties-tools.js';
import { createFilterTools } from '../tools/filter-tools.js';
import { createAdjustmentTools } from '../tools/adjustment-tools.js';
import { createTextTools } from '../tools/text-tools.js';
import { createSelectionTools } from '../tools/selection-tools.js';
import { createMaskTools } from '../tools/mask-tools.js';
import { createActionTools } from '../tools/action-tools.js';
import { createHistoryTools } from '../tools/history-tools.js';
import { createLayerOrderingTools } from '../tools/layer-ordering-tools.js';
import { createStateTools } from '../tools/state-tools.js';
import { createRecipeTools } from '../tools/recipes/index.js';
import { createGenerativeTools } from '../tools/generative-tools.js';
import { createNeuralTools } from '../tools/neural-tools.js';
import { createStyleTools } from '../tools/style-tools.js';
import { createColorAdjustmentTools } from '../tools/color-adjustment-tools.js';
import { createDataTools } from '../tools/data-tools.js';
import { createStackTools } from '../tools/stack-tools.js';
import { createExportTools } from '../tools/export-tools.js';

const READ_TOOLS = new Set(['photoshop_ping', 'photoshop_get_version', 'photoshop_get_capabilities', 'photoshop_list_documents', 'photoshop_get_document_info', 'photoshop_get_state', 'photoshop_get_layers', 'photoshop_get_history', 'photoshop_list_fonts', 'photoshop_get_selection_bounds', 'photoshop_list_datasets', 'photoshop_recover_connection']);
const ARTBOARD_NON_EDIT_TOOLS = new Set([...READ_TOOLS, 'photoshop_open_image', 'photoshop_create_document', 'photoshop_set_active_document', 'photoshop_close_document', 'photoshop_save_document', 'photoshop_get_preview', 'photoshop_execute_script']);

export interface PhotoshopMCPServerOptions {
  serverVersion: string;
}

export class PhotoshopMCPServer {
  private server: Server;
  private logger: Logger;
  private toolRegistry: ToolRegistry;
  private promptRegistry: PromptRegistry;
  private session: Session;

  constructor(options: PhotoshopMCPServerOptions) {
    this.logger = new Logger('PhotoshopMCPServer');
    this.toolRegistry = new ToolRegistry();
    this.promptRegistry = new PromptRegistry();
    this.session = new Session();

    this.server = new Server(
      {
        name: 'photoshop-mcp',
        version: options.serverVersion,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
        instructions: buildPhotoshopInstructions(),
      }
    );

    registerPhotoshopPrompts(this.promptRegistry);
    this.registerTools();
    this.setupHandlers();
  }

  private registerToolDefinition(definition: ToolDefinition): void {
    const tool = withOptionalDocumentId(definition.tool);
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    this.toolRegistry.register(tool.name, {
      tool,
      handler: wrapToolHandler(tool.name, wrapDocumentIdHandler((args) => { const checked = validate(args); if (!checked.valid) throw new Error('invalid_arguments: ' + checked.errorMessage); return access.run(READ_TOOLS.has(tool.name) ? 'read' : 'write', () => documentManaged.run(['photoshop_open_image', 'photoshop_create_document', 'photoshop_set_active_document'].includes(tool.name), () => managedMutation.run(!ARTBOARD_NON_EDIT_TOOLS.has(tool.name), () => definition.handler(args)))); })),
    });
  }

  private registerToolDefinitions(definitions: ToolDefinition[]): void {
    definitions.forEach((def) => this.registerToolDefinition(def));
  }

  private registerTools() {
    this.registerToolDefinition({
      tool: { name: 'photoshop_recover_connection', description: 'After an outcome_unknown error, inspect document state and acknowledge partial changes. Does not undo or retry operations. Refuses recovery while any call is still running.', inputSchema: { type: 'object', properties: { acknowledge: { type: 'boolean' } }, required: ['acknowledge'] } },
      handler: async (args) => {
        if (args.acknowledge !== true) throw new Error('invalid_argument: acknowledge must be true after inspecting state');
        const state = await this.toolRegistry.execute('photoshop_get_state', {});
        if (state.isError) return state;
        const lease = await acquireLease(Date.now() + 1000);
        try { await clearQuarantine(); } finally { await lease.release(); }
        return { content: [{ type: 'text', text: 'Recovery acknowledged. No operation was retried.' }, ...state.content] };
      },
    });
    this.registerToolDefinition({
      tool: {
        name: 'photoshop_ping',
        description:
          'Verify Photoshop is installed and reachable on this machine.\n\n' +
          'Use when: once at session start if connection status is unknown.\n' +
          'Do NOT use when: on every tool call — call once, then use photoshop_get_state.\n\n' +
          'Returns: connection success or failure message.\n' +
          'Preconditions: none. Side effects: may trigger Photoshop detection.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => this.pingPhotoshop(),
    });

    this.registerToolDefinition({
      tool: {
        name: 'photoshop_get_version',
        description:
          'Return the detected Photoshop version string.\n\n' +
          'Use when: user asks about compatibility or before version-gated features.\n' +
          'Do NOT use when: you need feature flags — prefer photoshop_get_capabilities.\n\n' +
          'Returns: version string.\n' +
          'Preconditions: none. Side effects: none.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => this.getVersion(),
    });

    const connection = this.session.getConnection();

    // Start the optional UXP bridge lazily, only when capability checks need it.

    this.registerToolDefinitions(createDocumentTools(connection));
    this.registerToolDefinitions(createLayerTools(connection));
    this.registerToolDefinitions(createImageTools(connection));
    this.registerToolDefinitions(createImagePlacementTools(connection));
    this.registerToolDefinitions(createSmartObjectTools(connection));
    this.registerToolDefinitions(createLayerTransformTools(connection));
    this.registerToolDefinitions(createLayerPropertiesTools(connection));
    this.registerToolDefinitions(createFilterTools(connection));
    this.registerToolDefinitions(createAdjustmentTools(connection));
    this.registerToolDefinitions(createTextTools(connection));
    this.registerToolDefinitions(createSelectionTools(connection));
    this.registerToolDefinitions(createMaskTools(connection));
    this.registerToolDefinitions(createActionTools(connection));
    this.registerToolDefinitions(createHistoryTools(connection));
    this.registerToolDefinitions(createLayerOrderingTools(connection));
    this.registerToolDefinitions(createStateTools(connection));
    this.registerToolDefinitions(createGenerativeTools(connection));
    this.registerToolDefinitions(createNeuralTools(connection));
    this.registerToolDefinitions(createStyleTools(connection));
    this.registerToolDefinitions(createColorAdjustmentTools(connection));
    this.registerToolDefinitions(createDataTools(connection));
    this.registerToolDefinitions(createStackTools(connection));
    this.registerToolDefinitions(createExportTools(connection));
    this.registerToolDefinitions(createRecipeTools(connection));

    this.logger.info(
      `Registered ${this.toolRegistry.count()} tools and ${this.promptRegistry.count()} prompts`
    );
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Listing available tools');
      return { tools: this.toolRegistry.list() };
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      this.logger.debug('Listing available prompts');
      return { prompts: this.promptRegistry.list() };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments as Record<string, string>) || {};
      this.logger.debug(`Prompt requested: ${name}`);
      capture('mcp_prompt_requested', {
        prompt_name: name,
        event_source: 'mcp',
      });
      return await this.promptRegistry.get(name, args);
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const started = Date.now();
      this.logger.debug(`Tool called: ${toolName}`);

      try {
        const args = (request.params.arguments as Record<string, unknown>) || {};
        const result = await this.toolRegistry.execute(toolName, args);
        this.session.updateActivity();
        return result;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Tool not found:')) {
          recordMcpToolCall({
            toolName,
            ok: false,
            errorCode: 'tool_not_found',
            durationMs: Date.now() - started,
          });
        }
        throw error;
      }
    });
  }

  private async pingPhotoshop() {
    const connection = this.session.getConnection();
    const isConnected = await connection.ping();
    return {
      content: [
        {
          type: 'text' as const,
          text: isConnected
            ? 'Successfully connected to Photoshop'
            : 'Failed to connect to Photoshop',
        },
      ],
      isError: !isConnected,
    };
  }

  private async getVersion() {
    const connection = this.session.getConnection();
    const version = await connection.getVersion();
    return {
      content: [
        {
          type: 'text' as const,
          text: `Photoshop version: ${version}`,
        },
      ],
    };
  }

  isPhotoshopConnected(): boolean {
    return this.session.getConnectionStatus();
  }

  getToolCount(): number {
    return this.toolRegistry.count();
  }

  async getPhotoshopVersion(): Promise<string | undefined> {
    if (!this.session.getConnectionStatus()) return undefined;

    try {
      const version = await this.session.getConnection().getVersion();
      if (!version || version === 'Unknown') return undefined;
      return version;
    } catch {
      return undefined;
    }
  }

  async start() {
    await this.session.initialize();

    this.server.oninitialized = () => {
      onMcpClientConnected(this.server.getClientVersion());
    };
    this.server.onclose = () => {
      onMcpClientDisconnected();
    };

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.logger.info('MCP Server connected via stdio');
  }

  async stop() {
    await this.session.disconnect();
    this.logger.info('MCP Server stopped');
  }
}

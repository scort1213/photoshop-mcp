import { Logger } from '../utils/logger.js';
import { capture, captureAnalyticsMilestoneOnce } from '../analytics/index.js';
import { PhotoshopConnection } from '../platform/connection.js';

export interface SessionConfig {
  autoConnect?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export class Session {
  private logger: Logger;
  private connection: PhotoshopConnection;
  private config: SessionConfig;
  private isConnected: boolean = false;
  private lastActivity: Date;
  private disconnecting = false;
  private disconnectPromise?: Promise<void>;
  private pendingConnections = new Set<Promise<boolean>>();

  constructor(config: SessionConfig = {}) {
    this.logger = new Logger('Session');
    this.connection = new PhotoshopConnection();
    this.config = {
      autoConnect: true,
      reconnectAttempts: 3,
      reconnectDelay: 1000,
      ...config,
    };
    this.lastActivity = new Date();
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing session...');

    if (this.config.autoConnect) {
      const connected = await this.connect();
      this.captureConnectionEvent(connected);
    }
  }

  connect(): Promise<boolean> {
    if (this.disconnecting) return Promise.resolve(false);
    const pending = Promise.resolve().then(() => this.connectOnce());
    this.pendingConnections.add(pending);
    void pending.then(
      () => this.pendingConnections.delete(pending),
      () => this.pendingConnections.delete(pending)
    );
    return pending;
  }

  private async connectOnce(): Promise<boolean> {
    if (this.disconnecting) return false;
    try {
      this.logger.info('Connecting to Photoshop...');
      const connected = await this.connection.ping();
      if (this.disconnecting) return false;
      
      if (connected) {
        this.isConnected = true;
        this.updateActivity();
        this.logger.info('Successfully connected to Photoshop');
        return true;
      } else {
        this.isConnected = false;
        this.logger.warn('Failed to connect to Photoshop');
        return false;
      }
    } catch (error) {
      this.logger.error('Connection error:', error);
      this.isConnected = false;
      return false;
    }
  }

  async reconnect(): Promise<boolean> {
    this.logger.info('Attempting to reconnect...');
    
    for (let attempt = 1; attempt <= (this.config.reconnectAttempts || 3); attempt++) {
      if (this.disconnecting) return false;
      this.logger.debug(`Reconnect attempt ${attempt}/${this.config.reconnectAttempts}`);
      
      const connected = await this.connect();
      if (connected) {
        return true;
      }

      if (attempt < (this.config.reconnectAttempts || 3)) {
        await this.delay(this.config.reconnectDelay || 1000);
      }
    }

    this.logger.error('Failed to reconnect after all attempts');
    this.captureConnectionEvent(false);
    return false;
  }

  disconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      this.logger.info('Disconnecting session...');
      this.disconnecting = true;
      this.isConnected = false;
      this.disconnectPromise = Promise.allSettled([...this.pendingConnections]).then(() => undefined);
    }
    return this.disconnectPromise;
  }

  getConnection(): PhotoshopConnection {
    return this.connection;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  getLastActivity(): Date {
    return this.lastActivity;
  }

  updateActivity(): void {
    this.lastActivity = new Date();
  }

  private captureConnectionEvent(connected: boolean): void {
    capture('mcp_photoshop_connection', {
      ok: connected,
      photoshop_connected: connected,
      ...(connected ? {} : { error_code: 'photoshop_unreachable' }),
      event_source: 'mcp',
    });

    if (connected) {
      captureAnalyticsMilestoneOnce('mcp_photoshop_first_connected', {
        event_source: 'mcp',
      });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

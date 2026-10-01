import { LOCAL_ONLY_UI_ERROR } from './local-only.js';

export interface UIServerOptions {
  port: number;
  host: string;
  token?: string;
}

export interface UIServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Fail before loading provider SDKs, credentials, SQLite or a network listener. */
export async function startUIServer(_opts: UIServerOptions): Promise<UIServer> {
  throw new Error(LOCAL_ONLY_UI_ERROR);
}

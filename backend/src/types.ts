import type { Client } from '@libsql/client/web';
import type { Bindings, Capabilities } from './env';
import type { Logger } from './lib/logger';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  emailVerified: boolean;
  sessionId: string;
  csrfHash: string;
}

export interface Variables {
  requestId: string;
  log: Logger;
  db: Client;
  caps: Capabilities;
  ipHash: string;
  ip: string;
  cspNonce: string;
  user?: SessionUser;
}

export type AppContext = { Bindings: Bindings; Variables: Variables };

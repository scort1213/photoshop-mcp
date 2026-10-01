/** Offline verification: the historical standalone UI cannot start. */
import { strict as assert } from 'node:assert';
import { startUIServer } from '../src/ui/server.js';

await assert.rejects(startUIServer({ host: '127.0.0.1', port: 5174 }), /local-only build/);
console.log('Standalone UI remains unavailable.');

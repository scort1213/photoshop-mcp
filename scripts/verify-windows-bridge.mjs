/** Read-only regressions for the Windows COM bridge. Build the server first. */
import assert from 'node:assert/strict';
import { WindowsExecutor } from '../dist/platform/windows-executor.js';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { getPhotoshopCapabilities } from '../dist/platform/capabilities.js';
import { isUxpBridgeReachable } from '../dist/platform/uxp-bridge-client.js';
import { shutdownUxpBridgeServer } from '../dist/platform/uxp-bridge-server.js';

if (process.platform !== 'win32') throw new Error('This live probe requires Windows and Photoshop.');
const executor = new WindowsExecutor();
try {
  const text = await executor.execute('(function(){return "中文图层测试";})();');
  assert.equal(text, '中文图层测试');
  await assert.rejects(
    executor.execute('(function(){return "ERROR: 中文错误测试";})();'),
    /中文错误测试/
  );
  const connection = new PhotoshopConnection();
  const version = await connection.getVersion();
  assert.match(version, /^\d{1,3}(?:\.\d+)*$/);
  if (Number.parseInt(version) < 25) {
    assert.equal(getPhotoshopCapabilities(version).features.generative_fill, false);
  }
  // On a fresh port no companion plugin has polled, even though HTTP is up.
  assert.equal(await isUxpBridgeReachable(), false);
  console.log(JSON.stringify({ ok: true, version, unicode: true, errorPropagation: true, absentPluginDetected: true }));
} finally {
  await shutdownUxpBridgeServer();
}

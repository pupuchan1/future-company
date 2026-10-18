import { resolve } from 'node:path';
import { createIntegration } from '../integration/server.mjs';
import { createProductionRelay } from './relay.mjs';
import { loadServerEnvironment } from '../integration/environment.mjs';

loadServerEnvironment(new URL('../', import.meta.url));

function port(value, fallback) {
  const result = Number(value || fallback);
  if (!Number.isInteger(result) || result < 1024 || result > 65535) throw new Error('Invalid configured port.');
  return result;
}
function listen(server, number) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(number, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

const integrationPort = port(process.env.INTEGRATION_PORT, 4340);
const relayPort = port(process.env.NODE_RELAY_PORT, 4330);
// Resolve authentication before starting either listener. Do not print secrets or origins.
const relay = createProductionRelay({ secret: process.env.NODE_RELAY_SECRET,
  humanMcpToken: process.env.HUMAN_MCP_TOKEN, target: `http://127.0.0.1:${integrationPort}` });
const app = createIntegration({ env: process.env,
  stateDir: resolve(process.env.INTEGRATION_STATE_DIR || '.integration-state') });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  await relay.close();
  if (app.server.listening) await app.close();
  else { await app.backend?.close(); await app.gateway.close(); await app.events.close(); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
try {
  await listen(app.server, integrationPort);
  await listen(relay.server, relayPort);
  console.log(`Voice integration listening on loopback port ${integrationPort}; authenticated relay on loopback port ${relayPort}.`);
} catch {
  console.error('Voice deployment could not start. Check configured ports and required server settings.');
  await stop(1);
}

import { randomUUID } from 'node:crypto';

// One stateless MCP2 request. The server also accepts legacy MCP clients.
export async function mcpCall(url, token, name, args) {
  const body = { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {
    name, arguments: args,
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'future-company-integration', version: '0.1.0' },
      'io.modelcontextprotocol/clientCapabilities': {} },
  } };
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': name,
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const raw = await response.text();
  const json = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find((line) => line.startsWith('data: ')).slice(6) : raw);
  if (json.error || json.result?.isError) throw new Error('MCP tool rejected the request.');
  return json.result.structuredContent || JSON.parse(json.result.content.find((part) => part.type === 'text').text);
}

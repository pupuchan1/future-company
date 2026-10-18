#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';

const flags = new Set(process.argv.slice(2));
if (flags.has('--help')) {
  console.log('HUMAN_BRIDGE_URL=ws://127.0.0.1:4320/bridge HUMAN_MCP_TOKEN=... node integration/human/simulate-phone.mjs [--auto]');
  console.log('This is a simulator only. It never rings physical hardware or connects audio.');
  process.exit(0);
}
const url = new URL(process.env.HUMAN_BRIDGE_URL || 'ws://127.0.0.1:4320/bridge');
if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('HUMAN_BRIDGE_URL must use ws: or wss:.');
if (url.username || url.password || url.search) throw new Error('Use HUMAN_MCP_TOKEN, not URL credentials.');
const deviceId = process.env.HUMAN_DEVICE_ID || 'black-phone-1';
const token = process.env.HUMAN_MCP_TOKEN;
const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const active = new Map();
const readline = createInterface({ input: process.stdin, output: process.stdout });

function event(call, type, result) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, command_id: call.command_id, handoff_id: call.handoff_id, device_id: deviceId,
    ...(result === undefined ? {} : { result }) }));
}
function remove(call) {
  clearTimeout(call.pickupTimer);
  clearTimeout(call.hangupTimer);
  active.delete(call.handoff_id);
}
function pickup(call) {
  if (!call || call.phase !== 'ringing') return;
  call.phase = 'accepted';
  event(call, 'handset.off_hook');
  console.log(`[SIMULATED] 受話器を上げました ${call.handoff_id}（音声接続なし）`);
}
function hangup(call) {
  if (!call || call.phase !== 'accepted') return;
  const result = flags.has('--auto') ? {
    language: call.language === 'en' ? 'en' : 'ja',
    text: call.language === 'en'
      ? 'The team uses TypeScript and React, reviews changes through pull requests, and runs automated tests in CI.'
      : '開発では TypeScript と React を使い、プルリクエストでコードレビューを行い、CI で自動テストを実行します。',
  } : undefined;
  event(call, 'handset.on_hook', result);
  if (result) console.log('[SIMULATED] 架空の開発環境回答を返しました（実企業情報ではありません）。');
  console.log(`[SIMULATED] 受話器を戻しました ${call.handoff_id}`);
  remove(call);
}

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', device_id: deviceId, simulated: true,
    capabilities: ['ring.start', 'ring.stop', 'handset.events'] }));
  console.log(`[SIMULATED] ${deviceId}: 実機のベル・音声は動きません。p=受話器を上げる / h=戻す / q=終了${flags.has('--auto') ? ' / 自動応答あり' : ''}`);
});
ws.on('message', (bytes) => {
  const message = JSON.parse(bytes.toString('utf8'));
  if (message.type === 'ring.start') {
    const call = { ...message, phase: 'ringing' };
    active.set(call.handoff_id, call);
    console.log(`[SIMULATED] ベル指令を受信 ${call.handoff_id}`);
    event(call, 'ring.started');
    if (flags.has('--auto')) {
      call.pickupTimer = setTimeout(() => pickup(call), 1200);
      call.hangupTimer = setTimeout(() => hangup(call), 3500);
    }
  } else if (message.type === 'ring.stop') {
    const call = active.get(message.handoff_id);
    console.log(`[SIMULATED] ベル停止 ${message.handoff_id}`);
    if (call && message.status !== 'accepted') remove(call);
  } else if (message.type === 'error') {
    console.error(`Bridge rejected a message: ${message.code}`);
  }
});
readline.on('line', (line) => {
  const command = line.trim().toLowerCase();
  const call = [...active.values()].at(-1);
  if (['p', 'pickup'].includes(command)) pickup(call);
  else if (['h', 'hangup', 'complete'].includes(command)) hangup(call);
  else if (['q', 'quit'].includes(command)) ws.close();
});
ws.on('close', () => {
  for (const call of active.values()) remove(call);
  readline.close();
  console.log('[SIMULATED] ブリッジを切断しました。');
});
ws.on('error', (error) => console.error(`Bridge connection failed: ${error.code || error.name}`));
process.once('SIGINT', () => ws.close());

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHumanService } from './service.mjs';

const args = (overrides = {}) => ({
  case_id: 'case-1', reason: 'human_requested', summary: '担当者に確認が必要です。',
  language: 'ja', device_id: 'black-phone-1', idempotency_key: 'request-1', ...overrides,
});
function setup(t, options = {}) {
  const events = [];
  const commands = [];
  const service = createHumanService({ onEvent: (event) => events.push(event), ...options });
  t.after(() => service.close());
  const device = service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop', 'handset.events'] }, (command) => commands.push(command));
  const reply = (type, overrides = {}) => device.handleEvent({ type,
    command_id: commands[0].command_id, handoff_id: commands[0].handoff_id, ...overrides });
  return { service, device, events, commands, reply };
}

test('idempotent retries ring once; payload conflicts do not ring', (t) => {
  const { service, commands } = setup(t);
  const first = service.requestHuman(args());
  assert.deepEqual(service.requestHuman(args()), first);
  assert.equal(commands.length, 1);
  assert.throws(() => service.requestHuman(args({ summary: '別の内容' })), { code: 'idempotency_conflict' });
  assert.equal(commands.length, 1);
  first.status = 'completed';
  assert.equal(service.getHumanRequest(first.handoff_id).status, 'requested');
});

test('offline and incapable devices cannot report success', (t) => {
  const service = createHumanService();
  t.after(() => service.close());
  const offline = service.requestHuman(args());
  assert.equal(offline.status, 'unavailable');
  assert.equal(offline.unavailable_reason, 'device_offline');
  assert.equal(offline.audio_connected, false);
  let sent = false;
  service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: false, capabilities: [] }, () => { sent = true; });
  assert.equal(service.requestHuman(args({ idempotency_key: 'request-2' })).unavailable_reason, 'capability_missing');
  assert.equal(sent, false);
});

test('ACK order and identity gate ringing, pickup and completion; audio stays disconnected', (t) => {
  const { service, events, reply, commands } = setup(t);
  const request = service.requestHuman(args());
  assert.equal(request.status, 'requested');
  assert.equal(reply('handset.off_hook'), false);
  assert.equal(reply('ring.started', { command_id: 'wrong-command' }), false);
  assert.equal(reply('ring.started', { device_id: 'wrong-device' }), false);
  assert.equal(service.getHumanRequest(request.handoff_id).status, 'requested');
  assert.equal(reply('ring.started'), true);
  assert.equal(reply('ring.started'), false);
  assert.equal(reply('handset.on_hook'), false);
  assert.equal(reply('handset.off_hook'), true);
  const accepted = service.getHumanRequest(request.handoff_id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.simulated, true);
  assert.equal(accepted.audio_connected, false);
  assert.equal(commands.at(-1).type, 'ring.stop');
  assert.equal(reply('handset.on_hook'), true);
  assert.equal(service.getHumanRequest(request.handoff_id).status, 'completed');
  assert.deepEqual(events.map((event) => event.name), ['human.requested', 'human.ringing', 'human.accepted', 'human.completed']);
  assert.deepEqual(events.map((event) => event.data.revision), [1, 2, 3, 4]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 4);
});

test('cancel stops ringing and ignores late ACKs', (t) => {
  const { service, commands, reply } = setup(t);
  const request = service.requestHuman(args());
  const cancelled = service.cancelHumanRequest(request.handoff_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(commands.at(-1).type, 'ring.stop');
  assert.equal(commands.at(-1).ring_command_id, commands[0].command_id);
  assert.equal(reply('ring.started'), false);
  assert.equal(reply('handset.off_hook'), false);
  assert.deepEqual(service.cancelHumanRequest(request.handoff_id), cancelled);
  assert.equal(commands.length, 2);
});

test('disconnect marks requests unavailable; reconnect cannot acknowledge old calls', (t) => {
  const { service, device, reply, commands } = setup(t);
  const request = service.requestHuman(args());
  reply('ring.started');
  device.disconnect();
  assert.equal(service.getHumanRequest(request.handoff_id).unavailable_reason, 'device_disconnected');
  const next = service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: false,
    capabilities: ['ring.start', 'ring.stop'] }, () => {});
  assert.equal(next.handleEvent({ type: 'ring.started', command_id: commands[0].command_id, handoff_id: request.handoff_id }), false);
  assert.equal(reply('handset.off_hook'), false);
});

test('missing ACK expires and a delayed ACK cannot revive the request', async (t) => {
  const { service, commands, reply } = setup(t, { ackTimeoutMs: 15 });
  const request = service.requestHuman(args());
  await delay(35);
  assert.equal(service.getHumanRequest(request.handoff_id).unavailable_reason, 'ring_ack_timeout');
  assert.equal(commands.at(-1).type, 'ring.stop');
  assert.equal(reply('ring.started'), false);
});

test('ringing without pickup and pickup without completion have bounded deadlines', async (t) => {
  const { service, reply } = setup(t, { ringTimeoutMs: 15, acceptedTimeoutMs: 15 });
  const first = service.requestHuman(args());
  reply('ring.started');
  await delay(35);
  assert.equal(service.getHumanRequest(first.handoff_id).unavailable_reason, 'no_answer');
  // Use another isolated device for the accepted timeout path.
  const next = setup(t, { acceptedTimeoutMs: 15 });
  const second = next.service.requestHuman(args());
  next.reply('ring.started');
  next.reply('handset.off_hook');
  await delay(35);
  assert.equal(next.service.getHumanRequest(second.handoff_id).unavailable_reason, 'handling_timeout');
});

test('a busy phone cannot be rung for another request', (t) => {
  const { service, commands } = setup(t);
  service.requestHuman(args());
  const second = service.requestHuman(args({ case_id: 'case-2', idempotency_key: 'request-2' }));
  assert.equal(second.unavailable_reason, 'device_busy');
  assert.equal(commands.length, 1);
});

test('event publication errors do not break hardware commands', async (t) => {
  let failures = 0;
  const { service, commands, reply } = setup(t, {
    onEvent: async () => { throw new Error('webhook offline'); }, onEventError: () => { failures++; },
  });
  service.requestHuman(args());
  reply('ring.started');
  await delay(0);
  assert.equal(commands.length, 1);
  assert.equal(failures, 2);
});

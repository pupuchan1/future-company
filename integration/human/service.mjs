import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';

const identifier = z.string().trim().min(1).max(160);
const taskDetail = z.string().trim().min(1).max(500);
export const requestHumanSchema = z.object({
  case_id: identifier,
  reason: z.enum(['human_requested', 'agent_unable', 'approval_required']),
  summary: z.string().trim().min(1).max(4000),
  language: z.enum(['ja', 'en']).default('ja'),
  device_id: identifier.default('black-phone-1'),
  idempotency_key: identifier,
  target_role: taskDetail.optional().describe('Role to consult, not a routing guarantee.'),
  task: taskDetail.optional().describe('The bounded question or task for the human.'),
  expected_result: taskDetail.optional().describe('What answer is needed to continue the conversation.'),
  applicant_summary: z.string().trim().min(1).max(1000).optional().describe('Applicant facts explicitly stated by the caller only. Omit unknown name or experience; never rank or recommend hiring.'),
}).strict();
export const humanResultSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  language: z.enum(['ja', 'en']),
}).strict();
export const handoffIdSchema = z.object({ handoff_id: identifier }).strict();
export const deviceHelloSchema = z.object({
  type: z.literal('hello'),
  device_id: identifier,
  simulated: z.boolean(),
  capabilities: z.array(z.string().min(1).max(80)).max(20),
}).strict();
export const deviceEventSchema = z.object({
  type: z.enum(['ring.started', 'handset.off_hook', 'handset.on_hook', 'device.fault']),
  command_id: identifier,
  handoff_id: identifier,
  device_id: identifier.optional(),
  result: humanResultSchema.optional(),
}).strict().superRefine((event, context) => {
  if (event.result !== undefined && event.type !== 'handset.on_hook') {
    context.addIssue({ code: 'custom', path: ['result'], message: 'Only handset.on_hook can include a result.' });
  }
});

const terminal = new Set(['completed', 'unavailable', 'cancelled']);
const copy = (value) => structuredClone(value);

export class HumanServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HumanServiceError';
    this.code = code;
  }
}

/** Device ACKs are evidence of ringing/pickup; this service never connects audio. */
export function createHumanService({
  onEvent = () => {},
  onEventError = () => {},
  ackTimeoutMs = 10_000,
  ringTimeoutMs = 30_000,
  acceptedTimeoutMs = 300_000,
  maxRequests = 1000,
  slack,
  transportForCase = () => 'phone',
  caseActive = () => true,
} = {}) {
  for (const timeout of [ackTimeoutMs, ringTimeoutMs, acceptedTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Timeouts must be positive.');
  }
  const requests = new Map();
  const idempotency = new Map();
  const devices = new Map();
  let closed = false;

  function reportEventError(error) {
    try { onEventError(error); } catch { /* Reporting cannot block a hardware command. */ }
  }

  function emit(entry) {
    const event = {
      eventId: randomUUID(),
      name: `human.${entry.record.status}`,
      timestamp: entry.record.updated_at,
      data: copy(entry.record),
      cursor: null,
    };
    try { Promise.resolve(onEvent(event)).catch(reportEventError); }
    catch (error) { reportEventError(error); }
  }

  function transition(entry, status, detail) {
    if (terminal.has(entry.record.status)) return false;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.record.status = status;
    if (terminal.has(status)) entry.cancelTransport?.();
    entry.record.revision += 1;
    entry.record.updated_at = new Date().toISOString();
    if (detail) entry.record.unavailable_reason = detail;
    emit(entry);
    return true;
  }

  function send(entry, type) {
    const device = devices.get(entry.record.device_id);
    if (!device || device.connectionId !== entry.connectionId) return false;
    const command = {
      type,
      command_id: type === 'ring.start' ? entry.commandId : randomUUID(),
      handoff_id: entry.record.handoff_id,
      device_id: entry.record.device_id,
      ...(type === 'ring.start' ? {
        case_id: entry.record.case_id,
        reason: entry.record.reason,
        summary: entry.record.summary,
        language: entry.record.language,
        ...(entry.record.target_role === undefined ? {} : { target_role: entry.record.target_role }),
        ...(entry.record.task === undefined ? {} : { task: entry.record.task }),
        ...(entry.record.expected_result === undefined ? {} : { expected_result: entry.record.expected_result }),
        expires_at: new Date(Date.now() + ackTimeoutMs + ringTimeoutMs).toISOString(),
      } : { ring_command_id: entry.commandId, status: entry.record.status }),
    };
    try { return device.send(copy(command)) !== false; }
    catch { return false; }
  }

  function unavailable(entry, reason, stop = true) {
    if (terminal.has(entry.record.status)) return;
    // Record the terminal state before a bridge could acknowledge this command.
    transition(entry, 'unavailable', reason);
    if (stop) send(entry, 'ring.stop');
  }

  function arm(entry, timeout, reason) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => unavailable(entry, reason), timeout);
    entry.timer.unref?.();
  }

  function requestHuman(input) {
    if (closed) throw new HumanServiceError('closed', 'Human gateway is closed.');
    const args = requestHumanSchema.parse(input);
    const { idempotency_key, ...payload } = args;
    const fingerprint = JSON.stringify(payload);
    const previous = idempotency.get(idempotency_key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new HumanServiceError('idempotency_conflict', 'The idempotency key was already used with different arguments.');
      }
      return copy(requests.get(previous.handoffId).record);
    }
    if (requests.size >= maxRequests) {
      throw new HumanServiceError('capacity_reached', 'Human request capacity reached; archive and restart the development gateway.');
    }
    const transport = transportForCase(args.case_id);
    const device = transport === 'phone' ? devices.get(args.device_id) : undefined;
    const now = new Date().toISOString();
    const entry = {
      record: {
        handoff_id: randomUUID(), ...payload,
        status: 'requested', simulated: device?.simulated ?? false,
        audio_connected: false,
        ...(transport === 'slack' ? { transport: 'slack', device_id: 'slack-ai', notification_status: 'queued',
          ...(!slack?.repliesConfigured ? { reply_status: 'unconfigured' } : {}) } : {}),
        revision: 1, created_at: now, updated_at: now,
      },
      commandId: randomUUID(), connectionId: device?.connectionId,
      timer: undefined,
    };
    requests.set(entry.record.handoff_id, entry);
    idempotency.set(idempotency_key, { fingerprint, handoffId: entry.record.handoff_id });
    emit(entry);
    if (!caseActive(args.case_id)) unavailable(entry, 'case_inactive', false);
    else if (transport === 'slack') {
      if (!slack?.configured) unavailable(entry, 'slack_unconfigured', false);
      else if ([...requests.values()].some(other => other !== entry && other.record.case_id === args.case_id
        && other.record.transport === 'slack' && !terminal.has(other.record.status))) unavailable(entry, 'slack_request_pending', false);
      else {
        entry.slackDeadline = Date.now() + 600000;
        arm(entry, 600000, 'slack_answer_timeout');
        const isActive = () => !closed && !terminal.has(entry.record.status) && caseActive(args.case_id);
        entry.cancelTransport = slack.start(copy(entry.record), {
          isActive,
          update(values) { if (isActive()) { Object.assign(entry.record, values); transition(entry, 'requested'); arm(entry, Math.max(1, entry.slackDeadline - Date.now()), 'slack_answer_timeout'); } },
          complete(result, source) { if (isActive()) { entry.record.result = humanResultSchema.parse(result); Object.assign(entry.record, source); transition(entry, 'completed'); } },
          fail(reason) { if (isActive()) unavailable(entry, reason, false); },
        });
      }
      return copy(entry.record);
    }
    if (terminal.has(entry.record.status)) return copy(entry.record);
    if (!device) unavailable(entry, 'device_offline', false);
    else if (!['ring.start', 'ring.stop'].every((cap) => device.capabilities.includes(cap))) {
      unavailable(entry, 'capability_missing', false);
    } else if ([...requests.values()].some((other) => other !== entry
        && other.record.device_id === args.device_id && !terminal.has(other.record.status))) {
      unavailable(entry, 'device_busy', false);
    } else {
      arm(entry, ackTimeoutMs, 'ring_ack_timeout');
      if (!send(entry, 'ring.start')) unavailable(entry, 'command_delivery_failed');
    }
    return copy(entry.record);
  }

  function find(input) {
    const { handoff_id } = typeof input === 'string'
      ? handoffIdSchema.parse({ handoff_id: input }) : handoffIdSchema.parse(input);
    const entry = requests.get(handoff_id);
    if (!entry) throw new HumanServiceError('not_found', 'Human request not found.');
    return entry;
  }

  function getHumanRequest(input) { return copy(find(input).record); }

  function cancelHumanRequest(input) {
    const entry = find(input);
    if (transition(entry, 'cancelled') && entry.record.transport !== 'slack') send(entry, 'ring.stop');
    return copy(entry.record);
  }

  function connectDevice(input, sendCommand) {
    if (closed) throw new HumanServiceError('closed', 'Human gateway is closed.');
    const hello = deviceHelloSchema.parse(input);
    if (typeof sendCommand !== 'function') throw new TypeError('Device command sender required.');
    if (devices.has(hello.device_id)) {
      throw new HumanServiceError('device_already_connected', 'A bridge with this device ID is already connected.');
    }
    const device = {
      device_id: hello.device_id, simulated: hello.simulated,
      capabilities: [...new Set(hello.capabilities)],
      connectionId: randomUUID(), send: sendCommand,
      connected_at: new Date().toISOString(),
    };
    devices.set(device.device_id, device);
    return {
      connection_id: device.connectionId,
      handleEvent(inputEvent) {
        const event = deviceEventSchema.parse(inputEvent);
        const entry = requests.get(event.handoff_id);
        if (!entry || terminal.has(entry.record.status)
          || entry.connectionId !== device.connectionId
          || devices.get(device.device_id) !== device
          || event.command_id !== entry.commandId
          || (event.device_id && event.device_id !== device.device_id)) return false;
        if (event.type === 'device.fault') {
          unavailable(entry, 'device_fault');
          return true;
        }
        if (event.type === 'ring.started' && entry.record.status === 'requested') {
          transition(entry, 'ringing');
          arm(entry, ringTimeoutMs, 'no_answer');
          return true;
        }
        if (event.type === 'handset.off_hook' && entry.record.status === 'ringing') {
          transition(entry, 'accepted');
          arm(entry, acceptedTimeoutMs, 'handling_timeout');
          send(entry, 'ring.stop');
          return true;
        }
        if (event.type === 'handset.on_hook' && entry.record.status === 'accepted') {
          // A bridge answer is untrusted content, never a command to execute.
          // Its provenance remains this record's device_id and simulated flag.
          if (event.result !== undefined) entry.record.result = copy(event.result);
          transition(entry, 'completed');
          return true;
        }
        return false;
      },
      disconnect() {
        if (devices.get(device.device_id) !== device) return;
        devices.delete(device.device_id);
        for (const entry of requests.values()) {
          if (entry.connectionId === device.connectionId) unavailable(entry, 'device_disconnected', false);
        }
      },
    };
  }

  return {
    requestHuman, getHumanRequest, cancelHumanRequest, connectDevice,
    listDevices: () => [...devices.values()].map(({ send: _, connectionId: __, ...device }) => copy({ ...device, online: true })),
    listRequests: () => [...requests.values()].map(({ record }) => copy(record)),
    closeCase(caseId) { for (const entry of requests.values()) if (entry.record.case_id === caseId && !terminal.has(entry.record.status)) cancelHumanRequest(entry.record.handoff_id); },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of requests.values()) unavailable(entry, 'gateway_shutdown');
      devices.clear();
    },
  };
}

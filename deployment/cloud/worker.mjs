import { DurableObject } from 'cloudflare:workers';

const INACTIVITY_MS = 30 * 60 * 1000;
const ENVIRONMENT = ['OPENAI_API_KEY', 'STAFF_API_TOKEN', 'NODE_RELAY_SECRET', 'HUMAN_MCP_TOKEN',
  'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'WORKER_API_URL', 'HUMAN_MCP_URL',
  'SLACK_BOT_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_CHANNEL_ID', 'LIVE_MODEL'];

export class VoiceNode extends DurableObject {
  starting;

  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(INACTIVITY_MS));
    }
  }

  async ready() {
    const container = this.ctx.container;
    if (!container.running) {
      const env = Object.fromEntries(ENVIRONMENT.filter(name => this.env[name]).map(name => [name, this.env[name]]));
      container.start({ image: container.images.base, instance: 'lite', enableInternet: true, env });
    }
    await container.setInactivityTimeout(INACTIVITY_MS);
    const port = container.getTcpPort(4351);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {}
      await scheduler.wait(200);
    }
    throw new Error('Voice Node did not become ready.');
  }

  async fetch(request) {
    this.starting ??= this.ready().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.ctx.container.getTcpPort(4351).fetch(forwarded);
  }
}

export default {
  fetch(request, env) {
    return env.VOICE_NODE.getByName('production').fetch(request);
  },
};

export const voiceMap = Object.freeze({ reception: 'shida', recruiting: 'harema', haas: 'marin' });
export const isVoiceRoute = (route) => Object.hasOwn(voiceMap, route);

// Business context belongs to a case, not to an individual voice transport.
export function createCaseState(id, language = 'ja', route = 'reception', languagePreference = 'auto') {
  return { id, languagePreference, routing: { route, language: languagePreference === 'auto' ? language : languagePreference }, history: [], seen: new Set(), handoffRoutes: new Map(),
    pendingHumanEvents: [], deferredDelegations: new Set(), activeSessionId: null, switching: null, closed: false };
}

export function historyTurns(history) {
  const turns = [];
  for (const event of history) {
    if (typeof event.delta !== 'string') continue;
    const role = event.type.includes('input_') ? 'user' : 'assistant';
    if (turns.at(-1)?.role === role) turns.at(-1).text += event.delta;
    else turns.push({ role, text: event.delta });
  }
  return turns;
}

// Keep well below the SDK's 128-message / default 8,192-token startup limits.
// A UTF-8 byte budget also bounds token bytes without guessing a tokenizer.
export function initialHistory(history, byteBudget = 6000) {
  const selected = [];
  for (const { role, text } of historyTurns(history).slice(-32).reverse()) {
    if (byteBudget <= 0) break;
    const chars = [];
    for (const char of Array.from(text).reverse()) {
      const bytes = Buffer.byteLength(char);
      if (bytes > byteBudget) break;
      byteBudget -= bytes;
      chars.push(char);
    }
    if (chars.length) selected.push({ type: 'message', role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: chars.reverse().join('') }] });
  }
  return selected.reverse();
}

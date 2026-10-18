export function requestedInterviewEnd(text) {
  const value = String(text || '').normalize('NFKC').trim();
  if (/[「『"“].*(?:面接|面談|interview).*[」』"”]|(?:終了|終わ|終え).{0,12}(?:しない|ないで|ません)|(?:送ら|共有し|通知し)ない|(?:don't|do not|not ready to)\s+(?:end|finish|stop|send|share)|[?？]|どう|方法|説明|\b(?:how|explain|what|if)\b/i.test(value)) return false;
  return /^(?:(?:はい|では|それでは)[、,\s]*)?(?:面接|面談)(?:を|は)?\s*(?:終了(?:してください|します|したいです)|終わり(?:にしてください|です)|終え(?:てください|たいです))(?:[。！!]|$)|^(?:(?:please|can you|could you)\s+)?(?:end|finish|stop|conclude)\s+(?:(?:the|this|my|our)\s+)?interview(?:\s+please)?(?:[.!]|$)/i.test(value);
}

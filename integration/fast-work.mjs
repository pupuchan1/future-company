// Explicit work requests take the shortest path to the fixed human Slack inbox.
export function requestsWork(text) {
  const value = String(text || '').normalize('NFKC').replace(/\s+/g, '');
  if (!value || /(?:依頼|お願い)(?:は|を)?(?:しない|しません|したくない)|依頼しないで|仕事を探|就職|入社|採用|面接/.test(value)) return false;
  return /(?:仕事|作業|業務).{0,50}(?:依頼|お願い)|(?:依頼|お願い).{0,50}(?:仕事|作業|業務)/.test(value)
    || /(?:ハンダ|はんだ|半田|デバイス|修理|制作|製作|開発|設計|撮影|翻訳).{0,70}(?:得意な人|できる人|お願い|依頼|してほしい|して欲しい)/.test(value)
    || /(?:を|の)(?:お願い|依頼)(?:したい|したく|できますか|できる人)/.test(value)
    || /(?:hire|need|lookingfor|request).{0,80}(?:someone|expert|technician|solder|device|repair|work|service)/i.test(value);
}

export function workRequestDetails(text) {
  const task = String(text).trim().slice(0, 500);
  const skills = [/ハンダ|はんだ|半田|solder/i.test(task) ? 'ハンダ付け' : '', /デバイス|device|hardware|機器/i.test(task) ? 'デバイス・ハードウェア' : ''].filter(Boolean);
  return { task, summary: String(text).trim().slice(0, 4000),
    target_role: skills.length ? skills.join('、') + 'に詳しい作業担当' : 'ご依頼の内容に対応できる作業担当',
    expected_result: '対応可能な担当者と、次の連絡方法をこのスレッドで教えてください。', request_kind: 'work' };
}

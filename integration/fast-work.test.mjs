import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsWork, workRequestDetails } from './fast-work.mjs';
test('commissioned work is distinguished from recruitment, greetings and retracted requests', () => {
  for (const text of ['仕事を依頼したい', 'ハンダ付けやデバイスが得意な人はいませんか？', '翻訳をお願いしたい', '撮影をしてほしい', 'I need someone who can solder devices']) assert.equal(requestsWork(text), true, text);
  for (const text of ['こんにちは', '採用担当', '御社で仕事をしたいです', '仕事を探しています', '仕事を依頼したいと思ったが依頼しません', '面接をお願いします']) assert.equal(requestsWork(text), false, text);
  assert.equal(workRequestDetails('ハンダ付けやデバイスが得意な人').target_role, 'ハンダ付け、デバイス・ハードウェアに詳しい作業担当');
});

import assert from 'node:assert/strict'
import test from 'node:test'
import { callsRecruiter } from '../src/features/live/spoken-department.ts'

test('a short caller selection names the recruiting department', () => {
  for (const text of ['採用担当', '採用担当。', '採用担当者', '採用担当お願いします', '採用担当を呼んでください', '採用担当につないでください', 'すみません、採用担当の方へお願いします。', '採用担当と話したいです', 'Recruiter, please']) {
    assert.equal(callsRecruiter(text), true, text)
  }
})

test('mentions, quoted instructions, negations and unfinished fragments are not selections', () => {
  for (const text of ['採用', '採用担当には', '採用担当にはつながないで', '採用担当ではありません', '「採用担当」と言われました', '採用担当に聞くべきですか', '採用担当におつなぎします', '採用担当の意味を教えてください']) {
    assert.equal(callsRecruiter(text), false, text)
  }
})

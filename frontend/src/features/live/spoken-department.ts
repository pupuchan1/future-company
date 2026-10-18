/** A caller naming the department is an explicit selection, not an LLM decision. */
export function callsRecruiter(text: string): boolean {
  const request = text.normalize('NFKC').replace(/[\s、。,.!?！？]/g, '')
  return /^(?:すみません|あの)?(?:採用担当(?:者|さん|の方)?|採用アシスタント)(?:(?:に|へ)?お願いします|を?呼んで(?:ください)?|(?:に|へ)(?:つないで|繋いで|つなげて|繋げて)(?:ください|もらえますか|いただけますか)?|と(?:お話|話)(?:し|をし)?たいです)?$/.test(request)
    || /^(?:recruiter|recruiting|recruitmentassistant|connectmeto(?:the)?recruiter)(?:please)?$/i.test(request)
}

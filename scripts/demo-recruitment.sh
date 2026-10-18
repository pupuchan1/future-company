#!/usr/bin/env bash
set +x
set -euo pipefail
: "${STAFF_API_TOKEN:?STAFF_API_TOKENを環境変数に設定してください}"
BASE_URL="${BASE_URL:-http://127.0.0.1:5173}"
BASE_URL="${BASE_URL%/}"
command -v jq >/dev/null
command -v uuidgen >/dev/null

demo_dir=$(mktemp -d)
trap 'rm -f "$demo_dir/visitor.cookies" "$demo_dir/staff.cookies"; rmdir "$demo_dir"' EXIT
visitor_cookie="$demo_dir/visitor.cookies"
staff_cookie="$demo_dir/staff.cookies"
run_id=$(uuidgen)

post() {
  curl --fail-with-body --silent --show-error --max-time 20 \
    --cookie "$2" --cookie-jar "$2" \
    --header 'Content-Type: application/json' \
    --data-binary @- "$BASE_URL/api/v1$1"
}

# 1. 採用案件を作成
state=$(jq -n --arg cmd "$run_id-create" \
  '{commandId:$cmd, expectedRevision:0, kind:"recruitment", locale:"ja"}' \
  | post /cases "$visitor_cookie")
case_id=$(jq -er '.case.id' <<<"$state")
revision=$(jq -er '.case.revision' <<<"$state")

# 2. 面談情報と開発環境への質問を送信
state=$(jq -n --arg cmd "$run_id-submit" --argjson rev "$revision" \
  '{commandId:$cmd, expectedRevision:$rev, roleInterest:"ソフトウェア開発",
    experience:"TypeScriptでWebアプリを開発しました。",
    questions:["現場の開発環境を教えてください。"]}' \
  | post "/cases/$case_id/recruitment/submit" "$visitor_cookie")
request_id=$(jq -er '.case.requests[0].id' <<<"$state")
revision=$(jq -er '.case.revision' <<<"$state")

# 3. 社員ログイン。トークンはcurlの引数へ展開しない
printf 'Authorization: Bearer %s\n' "$STAFF_API_TOKEN" \
  | curl --fail-with-body --silent --show-error --max-time 20 \
      --request POST --header @- --cookie-jar "$staff_cookie" \
      "$BASE_URL/api/v1/staff/session" >/dev/null

# 4. 同じ依頼を引き受ける
state=$(jq -n --arg cmd "$run_id-claim" --arg id "$case_id" --argjson rev "$revision" \
  '{caseId:$id, commandId:$cmd, expectedRevision:$rev}' \
  | post "/staff/requests/$request_id/claim" "$staff_cookie")
revision=$(jq -er '.case.revision' <<<"$state")

# 5. 模擬回答を保存
state=$(jq -n --arg cmd "$run_id-answer" --arg id "$case_id" --argjson rev "$revision" \
  '{caseId:$id, commandId:$cmd, expectedRevision:$rev,
    result:{text:"【模擬回答】開発環境はTypeScriptとVS Codeです。", language:"ja"},
    simulated:true}' \
  | post "/staff/requests/$request_id/answer" "$staff_cookie")
revision=$(jq -er '.case.revision' <<<"$state")

# 6. 来訪者cookieで保存後の案件を再取得
curl --fail-with-body --silent --show-error --max-time 20 \
  --cookie "$visitor_cookie" "$BASE_URL/api/v1/cases/$case_id" \
  | jq '.case | {id, revision, status, ai, requests}'

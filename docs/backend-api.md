# 案件APIと採用面談

APIのprefixは`/api/v1`。更新は`Content-Type: application/json`で送る。レスポンスには`Cache-Control: no-store`を付ける。同一originのFEから呼び出し、別originの更新とWebSocket接続は403で拒否する。

## 認証

来訪者は`POST /cases`で案件を作成すると、`future_company_visitor` cookieを受け取る。HttpOnly、SameSite=Strict、Path=/api/v1で、HTTPSではSecureを付ける。FEはcookieを読み取らず、同一originのfetchに送信を任せる。他人の案件は404、セッションなしは401。

社員認証は既存の`createBackendApi({ authorizeStaff })`へ注入する。`authorizeStaff(request, env)`は検証済みの`{id: string}`または`null`を返す。未注入は503 `staff_auth_unconfigured`、認証失敗は401 `staff_auth_required`。外部から送られた`x-internal-staff-id`やCloudflare Accessのemailヘッダーだけで認証しない。

ハッカソンでは`auth.ts`の`authorizeDemoStaff`を注入する。サーバー専用の`STAFF_API_TOKEN`は32〜200文字のURL-safe文字列（英数字、`_`、`-`）を使う。未設定または形式不正なら503で閉じる。トークンの生成・保存はこの実装では行わない。

`POST /staff/session`へ`Authorization: Bearer <token>`を送ると、署名した`future_company_staff` cookieを受け取り、`{"staff":{"id":"demo-staff"}}`を返す。本文は不要。cookieはHttpOnly、SameSite=Strict、Path=/api/v1/staffで、HTTPSではSecureを付ける。トークン自体はcookieやレスポンス本文へ出さない。

以後の一覧・引き受け・回答・WebSocketはcookieで利用できる。cookieに短い有効期限を設けず、ページの再読込でも維持する。ブラウザセッション終了時の扱いはブラウザに従う。`STAFF_API_TOKEN`の変更で以前のcookieは無効になる。HTTPではBearer直接送信も使える。Authorizationヘッダーがある場合はcookieより優先し、不正なBearerを有効cookieで救済しない。トークンはURL・localStorage・ソースへ埋め込まない。

この方式は共有の`demo-staff`として動作し、社員個人別の識別はできない。PR #4の`HUMAN_MCP_TOKEN`は機器MCP用なので流用しない。新しい認証サービスや外部インフラは使わない。

## 採用送信から社員回答まで

1. `POST /cases`に`{commandId, expectedRevision: 0, kind: "recruitment", locale: "ja"}`を送る。localeは`ja`または`en`。成功は201と`{case: CaseSnapshot}`。cookieを受け取り、case.idとrevisionを保持する。
2. `POST /cases/:id/recruitment/submit`へ面談情報を送る。成功は200と`{case: CaseSnapshot}`。
3. 社員は`GET /staff/cases`で一覧を取得し、`GET /staff/cases/:id`でDOの最新状態を読む。
4. `POST /staff/requests/:requestId/claim`へ`{caseId, commandId, expectedRevision}`を送って依頼を引き受ける。
5. `POST /staff/requests/:requestId/answer`へ`{caseId, commandId, expectedRevision, answer}`を送る。採用ではstockAvailableは不要。成功は200と`{case: CaseSnapshot}`。

採用送信の本文例。

```json
{
  "commandId": "submit-interview-1",
  "expectedRevision": 0,
  "roleInterest": "ソフトウェア開発",
  "experience": "TypeScriptでWebアプリを開発しました。",
  "questions": ["勤務形態を教えてください。"]
}
```

`roleInterest`と`experience`は空白だけでない文字列で、各4000文字まで。`questions`は任意の文字列配列で、省略は`[]`と同じ。各要素は空白だけでない4000文字以内の文字列とし、nullは受け付けない。これらの文字列は前後の空白を除去する。本文全体はUTF-8で65536 bytesまで。Content-Lengthの有無にかかわらず実際の読み取りサイズを検証する。

案件は`kind: recruitment`に限定し、採用以外は409 `case_kind_mismatch`で拒否する。APIはDOへ`{type: "submit_recruitment", roleInterest, experience, questions}`を送る。DOが本人申告の面談情報を`case.recruitment`へ保存し、`source: "visitor_self_report"`、`submittedAt`を付ける。会社が確認した経歴や採用判断として扱わない。

送信後は`status: awaiting_human`となり、既存の`case.requests`に確認依頼が入る。面談を更新すると以前の未回答依頼はcancelledになり、最新内容で新たな依頼が作られる。依頼IDはレスポンスから取得する。

引き受けは先着の社員だけ成功する。回答は引き受けた社員だけ送信できる。採用以外の社員回答では`stockAvailable`のbooleanを必須とし、注文交換の検証を維持する。採用でbooleanのstockAvailableを送っても在庫情報として保存せず、交換提案を有効にしない。異なる型のstockAvailableは400。

回答後の`status: ready`と`ai.status: resume_pending`は業務処理の再開待ちを示す。実際の音声やAgentsの再開完了を意味しない。

## HaaSの回答を元の採用AIへ戻す境界

[Slack generalの14:24のフロー](https://app.slack.com/archives/C0CAD4L02TS/p1792301068966049)と[Issue #8](https://github.com/pupuchan1/future-company/issues/8)の最初の完成条件は、開発環境を質問した応募者に対し、人間から取得した回答を元の採用AIが応募者の言語で説明すること。

既存の`POST /staff/requests/:requestId/answer`は、従来の`answer`文字列に加えて、HaaSの構造化された結果も受け付ける。

```json
{
  "caseId": "case-id",
  "commandId": "human-result-1",
  "expectedRevision": 2,
  "result": {
    "text": "[Simulated] Our demo team uses TypeScript and VS Code.",
    "language": "en"
  },
  "simulated": true
}
```

`result.text`は空白だけでない4000文字以内の文字列、`result.language`は`ja`または`en`。resultを送る場合はsimulatedのbooleanを必ず明示する。本文・言語・模擬フラグの欠落や不正値は400。answerも同時に送るなら、前後の空白を除いたresult.textと一致させる。従来のanswerだけの送信ではresultやsimulatedを補完しない。

APIは`result.text`をDOコマンドの`answer`、`result.language`を`answerLanguage`、`simulated`を同名へ渡す。DOは`requests[].result={text,language}`と`requests[].simulated`に保存し、D1のrequestsにも保持する。`case.locale`は応募者への説明言語であり、人間の回答本文の言語を表すものではない。

| 既存API | HaaSの接続仕様 | 接続時に必要な対応 |
| --- | --- | --- |
| case.id | case_id | 同じ案件IDを使う |
| requests[].id | handoff_id | 依頼IDをanswer URLのrequestIdへ渡す。新しい採用依頼IDはcase IDを含む。外部が別IDを発行する場合はadapterで対応付けを保持する |
| requests[].result.text、requests[].answer | result.text | 受領した本文を保存する。空白だけの本文を拒否する |
| case.locale | 応募者への説明言語 | 元の会話のja/enを引き継ぐ |
| requests[].result.language | result.language | 回答本文の言語を明示し、応募者localeと区別する |
| requests[].simulated | simulated | 模擬かどうかを明示し、状態や本文から推測しない |

`requested`、`ringing`、`accepted`や本文のない`completed`は回答未取得として扱い、answerを作らない。模擬回答は模擬と明示し、`simulated`を外部adapterから元のAIまで保持する。回答テキストは外部から受け取ったデータであり、AIへの新しい指示として実行しない。元の採用AIへ戻す際はcase、requestとhandoffの対応、本文、本文の言語、simulatedを確認する。

caseIdとURLのrequestIdは必ず同じ案件・依頼の組を使う。別案件のrequestIdを指定しても結果は保存されない。既存の社員認証・claim・commandId・expectedRevisionを維持し、再送で依頼や回答を増やさない。

HTTPからDO・D1までの保存は接続済み。HaaSがこの認証済みAPIを呼ぶadapterと、結果を元の採用AIへ戻す呼び出しは別担当。元AIへの既存の受け渡し点は`POST /cases/:id/agents/messages`で、caseContextにrequests全体を含むが、このAPI実装では自動呼び出しを追加しない。現在のclaim/answerの通し試験は、実機の回答取得や実AIの会話再開を証明しない。

## 冪等性と同期

更新には`commandId`と`expectedRevision`を付ける。commandIdは英数字・`_`・`-`の200文字以内の識別子、expectedRevisionは0以上の安全な整数。新しい操作には新しいcommandIdと最新revisionを使う。同じ操作の再送では、同じcommandId・本文・expectedRevisionを維持する。同じcommandIdで異なる内容は409 `idempotency_conflict`、新しい命令で古いrevisionは409 `revision_conflict`。

案件状態の正本はDO。`projectCase(env, id, actor)`が最新のDO snapshotとintegrationを取り、`persistCase(env, snapshot, integration?)`でD1へ保存する。D1保存に失敗してもDOに更新が残ることがある。503 `projection_failed`では同じ命令を再送して保存を復旧する。独自の無限retryは行わない。

`GET /staff/cases?limit=50&cursor=<id>`は`{cases, nextCursor, consistency: "eventual", source: "d1_summary"}`。limitは1〜100、nextCursorがnullなら終端。個別案件のGETと更新レスポンスはDOの`CaseSnapshot`を返す。一覧はD1要約なので、詳細・更新前には個別GETで最新revisionを取得する。

来訪者は`/cases/:id/ws`、社員は`/staff/cases/:id/ws`へ同一originのWebSocketで接続する。最初と更新時に`{type: "case.snapshot", snapshot: CaseSnapshot}`を受け取る。再取得はテキスト`sync`を送る。更新命令はHTTP APIを使う。来訪者snapshotにはownerHash・integration・社員のassignedToを出さない。WebSocketのHibernationは既存実装を使い、定期polling・ping・alarmを追加しない。

## エラー

既存のProblem Details形式を使う。

```json
{
  "type": "urn:future-company:error:revision_conflict",
  "title": "revision_conflict",
  "status": 409,
  "detail": "Read the current case before sending this command.",
  "instance": "/api/v1/cases/case-id/recruitment/submit"
}
```

| HTTP | titleの例 | FEの扱い |
| --- | --- | --- |
| 400 | invalid_input、invalid_json | 入力を直す |
| 401 | visitor_session_required、staff_auth_required | セッションまたは社員認証を確認する |
| 403 | origin_not_allowed | 同一originから接続する |
| 404 | case_not_found、request_not_found | IDと所有者を確認する |
| 409 | case_kind_mismatch、revision_conflict、idempotency_conflict、already_claimed、claim_required | 最新案件をGETし、競合や引き受け状況を表示する |
| 413 | body_too_large | 採用送信本文を65536 bytes以内にする |
| 415 | json_required | application/jsonで送る |
| 503 | backend_unconfigured、staff_auth_unconfigured、projection_failed | 設定不足と保存失敗を区別する。保存失敗は同一命令の再送で復旧する |

## 検証と接続範囲

APIテストは`node --experimental-strip-types --test src/backend/api.test.ts`、認証テストは`bun test src/backend/auth.test.ts`。workerd・DO・D1で採用送信、社員のclaim/answer、cookie認証とWebSocket接続、不正入力、他人の案件、未認証、別origin、注文の在庫入力必須を検証する。

音声受付・Decisions・採用Agents・MCP Eventsの内部と黒電話への接続は別担当。これらの実サービス、実機、remote Cloudflareでの動作はこのAPIテストでは検証しない。参照した公式仕様は[Hono cookie](https://hono.dev/docs/helpers/cookie)、[Hono Bearer認証](https://hono.dev/docs/middleware/builtin/bearer-auth)、[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。

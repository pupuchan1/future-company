# 共通受付とWorker案件の接続（Issue #18）

共通入口は `ReceptionPage` → `useReceptionConnection` → `useLiveConnection`。部署選択や仮の実案件IDは追加しない。

1. 利用者の開始操作で `POST /api/v1/cases` を送る。cookieはsame-origin、リダイレクトは追従しない。案件未作成時は全体音声APIを呼ばず、マイクも開かない。
2. `commandId`・`expectedRevision: 0`・`kind: haas`・初回localeを固定する。二重開始は同じPromiseを共有し、失敗後の再送も同一本文を使用する。
3. JSONの `case.id/revision/kind/locale` を検証する。所有者cookieで `POST /api/v1/cases/:id/bridge-token` を送り、`{caseId, bridgeToken, expiresIn}` の案件一致・空でない証明・最大900秒の有効期間を検証する。再開のたびに新しい証明を取得し、キャッシュしない。
4. Worker返却IDへLive hookが切り替わり、新しいLive clientのstatus取得が完了してから `start(undefined, bridgeToken)` で受付ルートを開始する。Nodeの開始bodyは `{sdp, language, case_id, bridge_token}`。証明取得失敗・期限異常・異なる案件ではマイクもLiveも開始しない。証明取得は15秒でタイムアウトし、取消後の遅延応答を破棄する。
5. 同じ相談の再開では所有権付き `GET /api/v1/cases/:id` を先に実行する。異なるIDの返却、認証要求、HTML応答、API失敗では音声を開始しない。
6. 準備中も同じ主ボタンでキャンセルできる。Abortと世代番号で遅延応答を無効化する。「新しい相談」でのみ新しい作成commandを準備する。

Workerの汎用案件 `haas` で初期作成する。既存の `support/sales/recruitment` の取得も受け入れる。採用意思やAIの担当ルートを意味しない。音声の言語判定と担当への委譲は引き続きNode側が行う。

## 共有境界

- Workerの `case.id` = Node Liveの `case_id`。短命なLive `session_id`とは別。
- Worker `requestId` とNode `handoffId` の対応、社員認証・claim・revisionを経た結果保存から元のAgent/Liveへ戻すアダプタはIssue #19の担当範囲。現在のNode独自handoff経路と同じものとして完了表示しない。
- プロバイダーのキーやMCP資格情報はFEへ渡さない。
- 公開音声APIは同一originの `/api/v1/cases/:id/voice` に統一する。`status`・`events`・`session`・`session/:sessionId/handoff`・`session/:sessionId/activate`・`DELETE session/:sessionId` のすべてでWorkerが所有者cookieを確認し、Nodeへ中継する。ケース証明はこの所有者認可を置き換えない。
- `bridgeToken` は1回の開始処理のメモリ内だけで扱う。公開hookのsnapshot、localStorage、URL、画面に保存・表示しない。社員共通secretをこの証明の代わりにFEへ渡さない。
- 新規作成中にページを離れた場合、戻ったページは新しい相談になる。ページを跨ぐ案件再開はまだ提供しない。

`npm run test:frontend` で二重送信、再送の固定、所有確認、認証、証明更新、キャンセル、異なる案件、リセットと全音声APIの案件prefixを検証する。Live接続の終了・遅延応答・担当交代も既存のLiveテストで検証する。

関連: [#18](https://github.com/pupuchan1/future-company/issues/18) / [#19](https://github.com/pupuchan1/future-company/issues/19) / [#36](https://github.com/pupuchan1/future-company/issues/36)

接続証明APIは #19 の公開commit `fd07bd3` を `43fcb18` としてPR #28へ取り込み済み。ローカルWorkerにサーバー専用STAFF_API_TOKENがなければ503で開始を止める。Nodeの証明検証と結果返却、本番向けvoice relay、実Liveの通しはそれぞれ別途検証が必要。

`node --test src/backend/reception.integration.test.mjs` は、このclientから実Worker/DO/D1への作成・所有確認・証明発行を実行する。外部プロバイダーは使わない。認証なし・別所有者・外部Origin・署名/期限不一致・取消後の遅延も検証する。判断記録: [#45](https://github.com/pupuchan1/future-company/issues/45)。

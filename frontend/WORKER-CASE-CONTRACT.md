# 共通受付とWorker案件の接続（Issue #18）

共通入口は `ReceptionPage` → `useReceptionConnection` → `useLiveConnection`。部署選択や仮の実案件IDは追加しない。

1. 利用者の開始操作で `POST /api/v1/cases` を送る。cookieはsame-origin、リダイレクトは追従しない。マイクはまだ開かない。
2. `commandId`・`expectedRevision: 0`・`kind: support`・初回localeを固定する。二重開始は同じPromiseを共有し、失敗後の再送も同一本文を使用する。
3. JSONの `case.id/revision/kind/locale` を検証する。Worker返却IDの `/api/v1/cases/:id/voice/status` と `/events` へLive hookを切り替える。設定確認後、引数なしの `start()` で受付ルートを開始する。IDはローカル生成しない。
4. 同じ相談の再開では所有権付き `GET /api/v1/cases/:id` を先に実行する。異なるIDの返却、認証要求、HTML応答、API失敗では音声を開始しない。
5. 準備中も同じ主ボタンでキャンセルできる。Abortと世代番号で遅延応答を無効化する。「新しい相談」でのみ新しい作成commandを準備する。
6. マイクを開く前に、毎回 `POST /api/v1/cases/:id/bridge-token` で `{caseId,bridgeToken,expiresIn}` を取得する。案件ID・期限・トークンを検証し、Live作成本文にだけ `bridge_token` を渡す。証明はstate・localStorage・ログに保存しない。キャンセル後に到着した証明は使わない。

Workerに受付専用kindがないため、初期の一般相談は `support` とする。採用意思やAIの担当ルートを意味しない。音声の言語判定と担当への委譲は引き続きNode側が行う。

## 共有境界

- Workerの `case.id` = Node Liveの `case_id`。短命なLive `session_id`とは別。
- Worker `requestId` とNode `handoffId` の対応、社員認証・claim・revisionを経た結果保存から元のAgent/Liveへ戻すアダプタはIssue #19の担当範囲。現在のNode独自handoff経路と同じものとして完了表示しない。
- プロバイダーのキーやMCP資格情報はFEへ渡さない。
- 公開音声APIは同一originの `/api/v1/cases/:id/voice` に統一する。`status`・`events`・`session`・`session/:sessionId/handoff`・`session/:sessionId/activate`・`DELETE session/:sessionId` のすべてでWorkerが所有者cookieを確認し、Nodeへ中継する。ケース証明はこの所有者認可を置き換えない。
- 新規作成中にページを離れた場合、戻ったページは新しい相談になる。ページを跨ぐ案件再開はまだ提供しない。

`npm run test:frontend` で二重送信、再送の固定、所有確認、認証、証明更新、キャンセル、異なる案件、リセットと全音声APIの案件prefixを検証する。Live接続の終了・遅延応答・担当交代も既存のLiveテストで検証する。実モデル・本番認証・社員回答の往復は別の結合確認が必要。

関連: [#18](https://github.com/pupuchan1/future-company/issues/18) / [#19](https://github.com/pupuchan1/future-company/issues/19) / [#36](https://github.com/pupuchan1/future-company/issues/36)

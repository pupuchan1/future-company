# 共通受付とWorker案件の接続（Issue #18）

共通入口は `ReceptionPage` → `useReceptionConnection` → `useLiveConnection`。部署選択や仮の実案件IDは追加しない。

1. 利用者の開始操作で、音声サーバーの設定状況を確認してから `POST /api/v1/cases` を送る。cookieはsame-origin、リダイレクトは追従しない。
2. `commandId`・`expectedRevision: 0`・`kind: support`・初回localeを固定する。二重開始は同じPromiseを共有し、失敗後の再送も同一本文を使用する。
3. JSONの `case.id/revision/kind/locale` を検証する。Worker返却IDへLive hookが切り替わってから、引数なしの `start()` で受付ルートを開始する。IDはローカル生成しない。
4. 同じ相談の再開では所有権付き `GET /api/v1/cases/:id` を先に実行する。異なるIDの返却、認証要求、HTML応答、API失敗では音声を開始しない。
5. 準備中も同じ主ボタンでキャンセルできる。Abortと世代番号で遅延応答を無効化する。「新しい相談」でのみ新しい作成commandを準備する。

Workerに受付専用kindがないため、初期の一般相談は `support` とする。採用意思やAIの担当ルートを意味しない。音声の言語判定と担当への委譲は引き続きNode側が行う。

## 共有境界

- Workerの `case.id` = Node Liveの `case_id`。短命なLive `session_id`とは別。
- Worker `requestId` とNode `handoffId` の対応、社員認証・claim・revisionを経た結果保存から元のAgent/Liveへ戻すアダプタはIssue #19の担当範囲。現在のNode独自handoff経路と同じものとして完了表示しない。
- プロバイダーのキーやMCP資格情報はFEへ渡さない。
- 新規作成中にページを離れた場合、戻ったページは新しい相談になる。ページを跨ぐ案件再開はまだ提供しない。

`node --test frontend/tests/worker-cases.test.ts` で二重送信、再送の固定、所有確認、認証、キャンセル、異なる案件、リセットを検証する。Live接続の終了・遅延応答・担当交代は既存のLiveテストで検証する。

関連: [#18](https://github.com/pupuchan1/future-company/issues/18) / [#19](https://github.com/pupuchan1/future-company/issues/19) / [#36](https://github.com/pupuchan1/future-company/issues/36)

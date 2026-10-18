# Workerに保存した回答を元Agentへ返す

Issue #19のNodeとWorkerの接続契約。人間依頼が発生した`case_id`と`handoff_id`をWorkerの案件・依頼へ対応づけ、保存した回答を依頼元のrouteへ返す。Liveの声を切り替えても、短命な`session_id`で対応を作り直さない。

## ローカルの設定と起動

Node用のルート`.env.local`へ設定する。秘密値は`VITE_`変数へ置かない。

```dotenv
WORKER_API_URL=http://127.0.0.1:8787
STAFF_API_TOKEN=
```

`STAFF_API_TOKEN`には32〜200文字の英数字・`_`・`-`を使用し、Worker用`.dev.vars`にも同じ値を設定する。既存ファイルや値を上書きしない。NodeからWorkerへの社員認証にだけ使う。ブラウザへ渡すのは次節のcase限定証明で、社員キーは渡さない。

音声処理には既存の`OPENAI_API_KEY`、`HUMAN_MCP_URL`、`HUMAN_MCP_TOKEN`も必要。これらの設定方法は[integration/README.md](../integration/README.md)を参照。

```sh
bun install --frozen-lockfile
npm run db:migrate:local
npm run dev
```

Reactは5173、Nodeは4320、Workerは8787。`WORKER_API_URL`を設定するとWorker連携を有効にし、case限定証明のない音声開始を拒否する。空のままなら従来のNode音声構成で動く。WorkerのDO・D1はローカルの保存先を使用する。

## ブラウザからの開始

1. `POST /api/v1/cases`でWorker案件を作成し、返された案件IDと所有者cookieを保持する。共通受付と汎用作業には`kind: "haas"`を使い、既存の`commandId`・`expectedRevision:0`・`locale`を渡す。採用専用の案件には引き続き`kind: "recruitment"`を使える。
2. 同じ所有者cookieで`POST /api/v1/cases/:caseId/bridge-token`を呼ぶ。case未所有・期限切れ・改変された証明で別caseを開始できない。
3. 証明をNodeの音声開始bodyへ渡す。

証明取得の応答は次の形式。

```json
{"caseId":"case-example","bridgeToken":"<case限定証明>","expiresIn":900}
```

Nodeの既存音声開始`POST /api/live/session`は次のbodyを受ける。

```json
{"sdp":"v=0...","language":"ja","case_id":"case-example","bridge_token":"<case限定証明>"}
```

Workerの所有者cookieはPath=`/api/v1`なので、Nodeの`/api/live/session`へcookieを広げない。証明はcase IDと15分の有効期限を持ち、Nodeが検証してからLiveを開始する。証明の再取得は同じWorker所有者cookieで行う。証明や社員キーをURL・ログへ記録しない。

## 依頼・回答・返却

`human.requested`を受けたNodeは、依頼元routeを保存し、社員認証でWorkerへ人間依頼を登録する。

```text
POST /api/v1/staff/cases/:caseId/handoffs
{commandId, expectedRevision, nodeCaseId, handoffId, route,
 summary, task, targetRole, expectedResult}
```

Workerの依頼には`origin: {nodeCaseId,handoffId,route,targetRole,expectedResult}`が保存される。`summary`は状況、`task`は実行作業、`targetRole`は必要な担当・技能、`expectedResult`は返してほしい報告を表す。`requestId`はWorkerの登録応答から取得し、Nodeのhandoff IDを既存のWorker依頼IDと同一視しない。

回答は既存の社員認証・claim・命令ID・revisionを通す。Nodeが電話側の`human.completed`を受けた場合も、先にclaimと回答保存を行う。社員がすでに保存した回答は電話の遅着結果で上書きしない。

```text
POST /api/v1/staff/requests/:requestId/claim
{caseId, commandId, expectedRevision}

POST /api/v1/staff/requests/:requestId/answer
{caseId, commandId, expectedRevision, result:{text,language}, simulated}
```

汎用handoffとして登録した依頼では、採用以外のcaseでも`stockAvailable`を要求しない。従来の注文交換依頼の在庫確認条件は維持する。本文のない完了や、明示した言語・`simulated`のない結果を成功回答として補完しない。

Workerの既存WebSocketから保存済み回答を受け取り、Nodeの同じcaseとhandoffへ一度だけ渡す。声の切替中は既存caseのキューへ入れ、依頼元routeのAgentで処理する。別case、取り消した依頼、古い通知から回答を配信しない。

取消の保存は`POST /api/v1/staff/cases/:caseId/handoffs/:handoffId/cancel`、返却状態の保存は同じパスの`/delivery`。どちらも社員認証と`commandId`・`expectedRevision`を使う。

| 返却状態 | 確認したこと |
| --- | --- |
| `pending` | Workerが回答を保存した |
| `queued` | 元caseへの返却を予約した |
| `agent_completed` | 元Agentの処理が完了したがLiveへの送信は確認できない |
| `live_submitted` | Agentの結果をLiveの接続へ送った |
| `failed` | 返却処理が失敗した |

`ai.resume_pending`は回答保存後の再開待ちを表し、返却状態とは別に保持する。`live_submitted`はユーザーが音声を聞き終えた証拠ではない。音声説明完了のACKは未実装。

## 明示的な再同期

Nodeの`POST /api/worker/results`へ`{case_id,bridge_token}`を送り、現在のWorker回答を再取得できる。応答202は同期の受付。返却の完了は`worker.delivery`イベントとWorker依頼の`delivery.status`で確認する。bodyから回答本文は受け取らず、認証したWorkerの保存内容を読む。

通常の回答通知はWebSocketを使う。DOの定期poll・alarm、Nodeの自動再接続ループは追加しない。接続エラーは`worker.error`として通知する。再送や同じsnapshotの通知だけで同じAgent処理を増やさない。Node再起動で失ったAgent文脈や、予約後に結果が不明になった返却は、自動で再実行しない。

## Accessと検証範囲

既存の本人限定Accessは変更しない。Nodeから保護された公開Workerを使う場合は、すでに許可されたService Tokenの`WORKER_ACCESS_CLIENT_ID`と`WORKER_ACCESS_CLIENT_SECRET`をサーバーに設定する。未許可のサービス資格情報を作成したり、本人限定のポリシーを広げたりする処理は、このアダプターに含まれない。Accessが302を返した場合、ログインHTMLを回答データとして処理しない。

接続試験の結果はPRとIssue #19へ記載する。実Worker・DO・D1を使ったローカル試験と、模擬providerによるAgent処理確認は、実モデルの発話・実機黒電話・実Work購読の確認とは分ける。公開voice relayの経路はLimo側で実装中で、この文書のNodeローカル入口とは別の配信経路になる。

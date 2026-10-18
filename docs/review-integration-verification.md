# GitHub更新反映の確認（2026-10-18）

PR #28へ、PR #23のAgents開始冪等性修正とPR #4の会話状態引継ぎ・接続失敗診断を取り込んだ。PR #26の担当別音声と実音量計測は音声オーブと同じ解析系へ統合する。旧4画面への差し戻しは行わない。

## ローカル起動

```sh
npm install
npm run db:migrate:local
npm run dev
```

通常の受付は http://127.0.0.1:5173/ 。Node音声は4320、Workerは8787。PR #12のReact+Worker構成とルート `.wrangler/state` への保存を反映している。通常入口5173の `/api/v1/*` はWorkerへ、`/api/status`・`/api/events`・`/api/live` はNodeへ開発用プロキシで接続する。8787はWorker/React単体の確認用で、Node音声APIは提供しないため、会話の入口には5173を使用する。外部Originは書き換えず、既存の拒否を維持する。

`frontend/WORKER-CASE-CONTRACT.md` に案件作成から音声開始までの契約を記載。再送時のcommandIdと本文を固定し、Worker発行IDだけを渡す。

## 確認内容

- Cookie付き案件作成201、同一command再送で同一ID、所有者GET200、外部Origin403。
- Node設定API200。キーとMCP接続先が未設定なら開始不可の準備中表示。
- Node 52件、Worker 61件、FE（Worker境界、担当交代、音量、言語、オーブを含む）のテスト、型チェック、buildで確認。
- WorkerのNodeテストはMiniflareの共有リソース競合を避けるため直列実行する。

## 残る確認

実プロバイダー発話、実機電話、Issue #19のWorker人間回答と元Liveの往復は未確認。設定不足を実接続成功として扱わない。公開デプロイやmainへのマージは行っていない。

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

## GitHub残件確認後のFE接続（Issue #40）

#19で共有された所有者cookie付き `POST /api/v1/cases/:id/bridge-token` を共通受付から呼び、返却された案件限定証明をNode開始bodyの `bridge_token` へ渡す。新しいcaseのstatusを待ち、取得失敗・案件不一致・取消後の証明/status遅延でマイク・Liveを開始しない。再開時は証明を取り直し、UI snapshotやブラウザ保存へ証明を入れない。

FE55テスト・FE本番build・lint（既存warning2件のみ）と、模擬API/模擬音声のブラウザー10項目で確認。#19のbackend実装はまだ別ブランチのため、API未取り込みの環境では証明取得404で開始を止める。Node検証・結果返却・本番relay・実プロバイダーの通しは未完了。[担当と作業順](github-status-20261018.md)を参照。


## Worker証明APIの取り込み（Issue #45）

#19のWorker契約fd07bd3を43fcb18として取り込み、受付の新規kindをhaasに合わせた。以前のsupport/sales/recruitment案件の読み取りは維持。接続証明APIが別ブランチのため404になる、という上記の制約はこの変更で解消した。ローカル通常起動ではSTAFF_API_TOKEN未設定のため、HaaS作成201、証明発行503 staff_auth_unconfiguredを確認。設定を推測して補わず開始を止める。

新しいreception.integration.test.mjsは実Worker/DO/D1を一時環境で動かし、実際のWorkerCaseClientで作成→所有者証明取得を試験する。4件成功: 並行開始と同一案件、認証/別所有者/外部Origin拒否、サーバー秘密未設定、発行後に遅れて届いた証明の取消。署名・案件・有効期限、UI snapshot/D1への秘密・証明非保存も確認。外部プロバイダーと実マイクは使用しない。

標準test/test:workerに新しい結合試験とbridge.test.tsを追加。WorkerはNode37件+Bun31件=68件成功。FE57件、FE/Worker型チェック、FE/Worker本番build成功。音声オーブの進行中変更も同じcheckoutにあるため、描画変更は別担当のcommitで管理する。

Nodeサーバーへのアダプター組込・証明検証・公開relay・実Liveの通しは引き続き#19/#32/#33の確認対象であり、上のWorker試験で完了扱いにしない。

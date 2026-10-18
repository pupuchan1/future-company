# ローカル動作の確認

2026-10-18、ブランチ`r74`でPR #15のReact画面を取り込み、画面とHono APIを同じViteサーバーで確認した。これはブラウザ内デモとWorker APIそれぞれの動作確認で、両者の業務状態はまだ接続していない。

## 起動と画面

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

通常は http://127.0.0.1:5173 。受付から「AI受付と話す」→「開発環境を教えてください」→送信→「人に確認を依頼」と進む。別タブで`/operator`を開き、依頼を引き受け、模擬回答を送る。元の会話に本文が届き、その会話URLを再読込しても回答が残ることをChromeで確認した。画面の保存先はlocalStorage。マイク・実モデル・実機電話は使っていない。

## 認証付きAPIと保存

`.dev.vars`にサーバー専用の`STAFF_API_TOKEN`を設定して起動する。既存ファイルや値は上書きしない。同じ値をシェルの環境変数にも設定し、下の既存スクリプトを使う。秘密値はログへ出さない。

```sh
mkdir -p .local
BASE_URL=http://127.0.0.1:5173 bash scripts/demo-recruitment.sh > .local/recruitment-api.log
```

採用案件作成→面談送信→社員ログイン→引受→模擬回答→案件再取得が成功した。結果は`revision: 3`、依頼は`answered`、本文は「【模擬回答】開発環境はTypeScriptとVS Codeです。」、`ai.status: resume_pending`。これは回答の保存と再開待ちを表し、音声が再開した証拠ではない。

同じルートのローカルD1でも最新案件を確認できる。

```sh
bunx wrangler d1 execute DB --local --command "SELECT id,revision,json_extract(summary, '$.requests[0].result.text') AS answer FROM cases ORDER BY updated_at DESC LIMIT 1"
```

今回の実行では同じ案件ID・revision 3・同じ回答本文が返った。Viteの`persistState.path`はルートの`.wrangler/state/`を指定し、migrationの保存先と一致させた。試験用トークンは一時的に生成し、サーバー終了後に一時`.dev.vars`を除去した。実OpenAIのキーは使っていない。

## 機械検証とログ

```sh
bun run typecheck > .local/typecheck.log 2>&1
bun run test > .local/backend-test.log 2>&1
bun run build > .local/build.log 2>&1
npm run typecheck:frontend > .local/frontend-types.log 2>&1
npm run lint > .local/frontend-lint.log 2>&1
node --test frontend/tests/demo.test.ts frontend/tests/live-connection.test.ts > .local/frontend-test.log 2>&1
```

Worker 59テスト、React 17テスト、両方の型チェック、統合buildが成功。lintはエラーなし、既存React warning 2件（App.tsxのrefs・set-state-in-effect）が残る。buildはfrontendの外に出力するためoutDirを自動で空にしない旨のwarningを出す。画面のUI、既存の音声接続コードは変更していない。

## 次の結合点

- #18（pupu）: Workerが発行したcase IDをReactからLiveへ渡す。ローカルUUIDを実案件IDとして扱わない。
- #19（r74tech）: Nodeのcase/handoffとWorkerのcase/requestを対応づけ、認可・claim・revisionを通して保存した回答を元Agent/Liveへ返す。
- #20（Limo）: Agents開始の同一要求再送でrevision変化により409になる不具合の独立修正。

通常の`bun run dev`はPR #4のNode音声サーバーを起動しない。実音声用の起動方法は`frontend/LIVE-INTEGRATION.md`を参照。実モデル発話・黒電話・実Work購読は今回未確認。試験公開環境のAccess本人限定許可は変更していない。

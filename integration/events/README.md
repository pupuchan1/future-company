# Human handoff: MCP Events webhook

2026-10-18 の[公式 MCP Events 仕様](https://developers.openai.com/plugins/build/mcp-events)に合わせた、Node.js 標準ライブラリのみの実装です。

**ローカルの偽 callback で署名・検証・再送まで検証済み。実 ChatGPT でのプラグイン登録・購読・イベント起動は未検証です。** API キーや実際の ChatGPT callback はテストに使っていません。

## 接続

```js
import { McpEvents } from './events/mcp-events.mjs';

const events = new McpEvents({
  storePath: '/absolute/private-directory/mcp-events.json',
  // 実際に確認した callback の完全ホストだけを設定する。
  // 空配列は配送・購読を拒否する。ワイルドカードは使えない。
  allowCallbackHosts: [],
});

// 認証済み MCP router の events/* hook。未知 method は undefined。
const handleEventRpc = (request) => events.handleRpc(request);

// Human gateway の onEvent から呼ぶ。戻り値は配送完了ではなく outbox 受付。
const onEvent = (event) => events.publish(event);

// サーバー終了時。未配送 outbox は次回起動で再開する。
await events.close();
```

MCP router は `server/discover` の `capabilities.events: {}` を広告してください。`handleRpc` は `{jsonrpc:'2.0',id,result}` または `{jsonrpc:'2.0',id,error}` を返します。

認証は呼び出し元の MCP router が担当します。**ひとつの instance/store はひとつの認証済みアプリ・テナント専用**です。任意ユーザーが同じ instance に入り別ユーザーの購読を解除できる構成にしないでください。`params` に自己申告の owner を入れて認証扱いにはしません。

## イベント

`human.requested` / `human.ringing` / `human.accepted` / `human.completed` / `human.unavailable` / `human.cancelled` を公開します。`accepted` は受話器が上がった等の受付を意味し、音声接続の証明ではありません。

```json
{
  "eventId": "evt_handoff_123_completed_4",
  "name": "human.completed",
  "timestamp": "2026-10-18T06:00:00.000Z",
  "data": {
    "handoff_id": "handoff_123",
    "case_id": "case_456",
    "device_id": "black-phone-1",
    "status": "completed",
    "simulated": true,
    "audio_connected": false,
    "revision": 4
  },
  "cursor": null
}
```

`events/list` はイベント名と input/payload schema を返します。購読 filter は `device_id` と `case_id` を任意指定でき、両方指定なら両方一致したときだけ配送します。未実装の replay は `cursor:null` として明示し、任意の非 null cursor を拒否します。`simulated` は必須で、模擬イベントと実機イベントを混ぜません。

## 配送と保存

- `events/subscribe` が受け取った callback と secret で、短命の乱数 challenge を署名送信し、`2xx` と完全一致の echo を確認します。検証失敗は JSON-RPC `-32015`、秘密を含まない `data.reason` で返します。
- `whsec_` に続く base64 は 24〜64 bytes の鍵として検証。HMAC SHA-256 は Standard Webhooks の `eventId.timestamp.exactBody` を使い、`webhook-id`・`webhook-timestamp`・`webhook-signature`・`X-MCP-Subscription-Id` を送ります。
- 購読 ID は instance の永続 scope、イベント、filter、callback から決定。同じ購読の更新は同じ ID です。期限は 1 時間、`refreshBefore` は満了の 5 分前。callback 検証は同一 URL・secret につき最大 5 分再利用します。
- subscription と outbox は `storePath` に atomic rename で保存します。親ディレクトリは 0700 が必要で、新規なら作成します。既存の共有ディレクトリの権限は変更しません。store は 0600、symlink は拒否します。store に callback URL・secret が含まれるので Git・ログ・画面に出さないでください。
- 配送は別 timer で実行。`publish` は `{queued:n}` を返し、配送失敗は黒電話の処理を停止しません。入力不正、過大 payload、保存失敗等は `{queued:0,rejected:reason}` を返します。
- transient failure は最大 4 回（初回＋250ms、1s、4s の再送）。event ID と body は維持し、署名時刻・署名は毎回生成。`410` は購読を削除し、`413` やその他の恒久エラーは再送しません。満了・解除は未配送 outbox も削除します。
- exact event ID は 24 時間重複防止。同じ ID で異なる内容は collision として拒否します。受領直後のクラッシュなどで重複配送は起こり得るため、受信側の書き込みも冪等にしてください。最大 outbox は 1,000 件、1 payload は 256 KiB。
- `2xx` は配送受領であり、ChatGPT のタスク完了を示しません。最終的な処理・実機動作は別に読戻してください。

callback は HTTPS/443 の明示した完全ホストのみ許可します。URL の認証情報、fragment、localhost、internal、IP literal 等は拒否。標準 transport は接続ごとに DNS の全候補を検証し、private/special IP を拒否して検証した IP に固定し、元ホスト名で TLS 検証します。redirect は追わず、5 秒 timeout と受信サイズ上限を設定しています。

`fetchImpl` と `clock` はテスト用に差し替えできます。外部に公開する設定値ではありません。独自 transport を本番に渡す場合は、標準 transport と同じ接続時 DNS 検証・IP 固定・TLS 検証を実装する必要があります。

## Agents API との境界

この MCP Events は、公式に記載された **ChatGPT Work（web／desktop Cloud）・dots** への購読通知です。Agents API が `events/subscribe` をネイティブに購読する仕様は確認できていません。

黒電話の結果を即座に会話へ戻す経路は、アプリの callback/WS → Agents API の `agent.session.input.message` → GPT-Live の `session.commentary.append` として接続します。MCP Events 配送の成功に主経路を依存させません。通常の MCP tool result、Agents session event stream、MCP Events webhook はそれぞれ別です。

- [Agents API MCP connections](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
- [Agents API events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)

## 検証

```sh
/opt/homebrew/opt/node@24/bin/node --test integration/events/mcp-events.test.mjs
```

テストでは、許可した公開ホスト名を **テスト専用 `fetchImpl` の中だけ**で localhost の偽 HTTP callback に対応させています。本番の allowlist/DNS/HTTPS 制約は緩めていません。実 ChatGPT 購読の受入では callback の許可ホスト設定、MCP plugin の登録、購読、実イベント受領、タスクの後続処理を別途確認してください。

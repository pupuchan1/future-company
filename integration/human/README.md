# 人間呼び出し MCP と黒電話ブリッジ

`gateway.mjs` は公式 MCP SDK v2 の HTTP MCP と、機器向け WebSocket を同じ Node HTTP サーバーへ組み込むモジュールです。GPT Live/Agents が「人間が必要」と判断した後の、呼出要求 → ベル指令 → 機器の確認 → 受話器検知を担当します。

現在の主ユースケースは採用面談です。AI は職務関連の質問・応募者回答の整理・必要な人間への相談を担当します。実機の黒電話と人間への引継ぎは別チームの担当で、このモジュールは接続契約と試験用です。

**この実装はベル制御の通信経路です。黒電話の音声回線を接続する処理はありません。** `accepted` は受話器が上がったという機器の通知で、すべての返り値は `audio_connected:false` です。実機回路・ベル・受話器検知は GOROman さん側のブリッジが同じプロトコルで接続すると動かせる設計です。現在の検証はシミュレーターです。

## 組み込み

```js
import { createHumanGateway } from './human/gateway.mjs';

const gateway = createHumanGateway({
  token: process.env.HUMAN_MCP_TOKEN,
  onEvent: event => mcpEvents.publish(event),
  handleEventRpc: (body, req) => mcpEvents.handleRpc(body, req),
});
// HTTP: if (await gateway.handleRequest(req, res)) return;
// upgrade: if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
// shutdown: await gateway.close();
```

- MCP は `POST /mcp`、機器は `WS /bridge`。設定時は両方 `Authorization: Bearer <HUMAN_MCP_TOKEN>` が必要です。URL にトークンを入れません。
- トークン未設定なら loopback の接続元かつ localhost/127.0.0.1/[::1] の Host のみ許可します。プロキシ転送ヘッダーを伴うリクエストは拒否します。インターネット公開はトークンを設定し TLS を終端する構成が前提です。
- Origin は同じ Host または `allowedOrigins` に完全一致するものを許可します。Node のデバイスからの Origin なし接続も許可します。
- MCP 2026-07-28 の `server/discover` と per-request envelope、2025 の stateless Streamable HTTP の両方を公式 SDK が扱います。Events hook を設定すると `capabilities.events:{}` を広告します。
- MCP 2026 の手書きクライアントには `params._meta` の `io.modelcontextprotocol/protocolVersion` / `clientInfo` / `clientCapabilities` と `MCP-Protocol-Version`, `MCP-Method`、tool call では `MCP-Name` ヘッダーが必要です。通常は MCP SDK クライアントを利用します。
- `handleEventRpc(body,req)` は完全な JSON-RPC response、扱わない method には `undefined` を返します。`events/*` だけが hook に転送されます。ChatGPT MCP Events の webhook 配信は `integration/events/` が担当し、WebSocket 機器制御とは別経路です。

## MCP ツール

| ツール | 入力 / 動作 |
|---|---|
| `request_human` | `case_id`, `reason` (`human_requested` / `agent_unable` / `approval_required`), `summary`, `language` (`ja` 既定 / `en`), `device_id` (`black-phone-1` 既定), `idempotency_key` |
| `get_human_request` | `handoff_id` で最新状態を取得 |
| `cancel_human_request` | `handoff_id` で取消し、機器へ `ring.stop` を送信。終端状態は変更しない |
| `lookup_demo_order` | `order_id`。架空注文 `DEMO-1001` だけが配送遅延・返金に人間承認が必要な結果。それ以外は `not_found`。実注文の照会・変更はしない |
| `get_interview_template` | `language` (`ja` / `en`)。架空のソフトウェアエンジニア求人・職務関連質問 3 個・面談冒頭文を取得。AI はランキング・採否判断・選考の確約を行わず、人間が採否を判断する契約を返す |

Handoff の返り値は `handoff_id, case_id, device_id, status, simulated, revision, reason, summary, language, created_at, updated_at, audio_connected`。失敗時に `unavailable_reason` が加わります。

同じ idempotency key と同じ引数は同じ handoff の最新状態を返します。別の引数で同じ key を使うと `idempotency_conflict`。接続機器なし、必須機能なし、既に対応中の機器は `unavailable` になり、鳴ったとは報告しません。状態はメモリ内で最大 1000 件、サーバー再起動で消去されます。本番移行時は永続化と機器別認証を用意してください。

## 機器プロトコル

接続後 5 秒以内に JSON text を送信します。`simulated` は機器の申告値で、実機検証を証明するものではありません。実機アダプターは実回路の結果を確認して ACK を返してください。

```json
{"type":"hello","device_id":"black-phone-1","simulated":false,"capabilities":["ring.start","ring.stop","handset.events"]}
```

サーバーは `hello.accepted` を返します。同じ `device_id` の重複接続は拒否します。

```json
{"type":"ring.start","command_id":"command-uuid","handoff_id":"handoff-uuid","device_id":"black-phone-1","case_id":"case-1","reason":"agent_unable","summary":"人間による確認が必要","language":"ja","expires_at":"ISO-8601"}
```

機器は **元の `ring.start` の `command_id` と `handoff_id`** を付けて返します。

```json
{"type":"ring.started","command_id":"command-uuid","handoff_id":"handoff-uuid"}
{"type":"handset.off_hook","command_id":"command-uuid","handoff_id":"handoff-uuid"}
{"type":"handset.on_hook","command_id":"command-uuid","handoff_id":"handoff-uuid"}
```

故障は同じ識別子付き `device.fault`。サーバーは `event.ack` の `accepted` で採用可否を返します。別コマンド・別接続・取消後・期限切れ後の遅延応答は採用しません。

| 状態遷移 | 成立条件 |
|---|---|
| `requested → ringing` | `ring.started` を受信（指令送信だけでは遷移しない） |
| `ringing → accepted` | `handset.off_hook` を受信。ベル停止を送信 |
| `accepted → completed` | `handset.on_hook` を受信 |
| 対応中 → `unavailable` | 切断、故障、ACK 10 秒・応答 30 秒・対応 5 分の期限切れ |
| 対応中 → `cancelled` | 取消ツール。ベル停止を送信 |

`ring.stop` は新しい `command_id`、元の `ring_command_id`、同じ `handoff_id`, `device_id`, 現在の `status` を持ちます。機器は停止指令を重複して受信しても安全に停止し、接続が切れた場合や `expires_at` を過ぎた場合も自律的にベルを停止してください。WebSocket ping/pong は 15 秒間隔です。

状態が変わるたびに `onEvent({eventId,name,timestamp,data,cursor:null})` を呼びます。`name` は `human.requested/ringing/accepted/completed/unavailable/cancelled`、`data` は上の handoff 全体です。イベント送信失敗でベル制御を巻き戻しません。

## シミュレーターと検証

統合サーバー起動後に実行します。URL の既定値は `ws://127.0.0.1:8787/bridge`。別ポートの場合は `HUMAN_BRIDGE_URL` で変更します。

```sh
node integration/human/simulate-phone.mjs
# 自動で受話器を上げて戻すデモ
node integration/human/simulate-phone.mjs --auto
# focused tests
node --test integration/human/*.test.mjs
```

手動操作は `p` = 受話器を上げる、`h` = 戻す、`q` = 終了。`HUMAN_DEVICE_ID` と `HUMAN_MCP_TOKEN` を必要に応じて設定します。**シミュレーターは `simulated:true` 固定。ベルも音声も実際には動きません。**

実機接続時の確認は「指令受信 → 実際のベル → 受話器検知 → 取消/切断時の停止」を順番に行います。電話音声の通話接続はこの確認とは別に検証が必要です。

参照: [公式 MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[公式 Node アダプター](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware/node)。

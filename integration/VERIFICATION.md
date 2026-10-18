# 接続プロトタイプの検証記録

2026-10-18 14:42 JST。PR #4 / Issue #8 / Issue #10。架空の会話・合成音声・模擬電話を使用。実ユーザーの録音やAPIキーは記録・コミットしていない。

| 確認 | 結果 |
| --- | --- |
| `npm run integration:test` | 41/41成功。MCP/機器18、Events11、オーケストレーター12 |
| 既存Reactの `npm run build` / `npm run lint` | 成功。今回Reactソースの変更なし |
| Live / frontend JSの構文、`git diff --check` | 成功 |
| 実Decisions | 採用/日本語、非採用HaaS/英語を分類。native triggerの候補も受信 |
| 実Agents / MCP | 面談テンプレート取得、誰に/何を/何を返すかを含む人間依頼、結果到着後の元担当継続 |
| 実WebRTC・採用経路 | 日本語の面談開始→英語へ切替→エンジニアに質問→模擬回答→元採用Agentの英語説明→Live出力。4,649音声フレーム、うち非無音1,990、受信エラー0 |
| 実WebRTC・HaaS経路 | 非採用のイベント用技術確認→HaaS Agent→同じMCP→模擬回答→HaaS Agentの英語説明→Live出力。3,269音声フレーム、うち非無音1,298、受信エラー0 |
| HaaS経路の終了 | `session.closed`受信、hosted Agents削除、cleanup_pendingなし |
| 採用経路の終了 | 最初の終了要求ではfinalization応答未確認、Agents削除待ち1件。後続の削除再試行は成功。Live finalizationはこの試行について未確認として残す |
| 開発UI | ブラウザで担当・模擬デバイス・依頼・回答本文の表示を確認。マイク入力・実スピーカーの人による聴取は別の未実施項目 |

音声入力はaiortcからWebRTCへ送った合成音声。受信した音声フレームとLive出力字幕を確認しており、ブラウザのマイク権限・実マイク・実スピーカー・人間の声での確認とは区別する。

模擬回答は「架空のチームがTypeScript/React、PRレビュー、CIを使う」という試験データ。Liveは架空情報である旨を説明した。実企業や実エンジニアから得た回答ではない。

## 回帰試験の対象

- 同じ依頼/イベントの再送、別案件・古い命令・期限切れ・回答なしの扱い。
- 部分発話で担当を確定しない。分類中に発話が変われば再分類し、安定しなければ業務を実行しない。
- 採用/HaaSは別Agents session。依頼元セッションへ結果を返し、利用者の最新言語を保持する。
- Agents作成応答待ちの終了、Live並行作成の同一case/上限、開発APIのHost/Origin制限。
- MCP Eventsの購読検証、署名、有限再送、イベントID維持、解除・失効。

## チーム結合として残るもの

- pupuのReact画面と、r74techのWorker/DO/D1への接続。15時台にはPR #15/#12としてコード共有済み。画面はpupuの実装を採用し、案件ID・認証境界と結果返却の結合は #18/#19 で進める。
- Node handoff_idとWorker requestIdの対応、社員認証/claim/revisionを通した結果APIアダプター。
- 実機ベル、受話器からの実回答、人間の音声経路。
- 実ChatGPT Work/dotsのMCP Events購読と、購読後の業務実行。
- 公開Web、アプリ認証、本番リポジトリへの移管、永続case復旧。

PRはDraftのまま共有し、これらの境界・受入範囲をマージ時に判断する。

## 2026-10-18 15時台: 担当別の声切替

最新のNode試験は52/52成功。既知のAPI接続例外はHTTP 502として返し、statusのない例外も許可したクラス名と原因コードだけをprivateなerrors.jsonlに記録する。例外本文・入力・キーはこの診断に含めない。診断追加後の実API再試行は行っておらず、以下の汎用400の原因を遡って確定したものではない。

aiortcで同じケースの一般受付→採用→HaaSを試験した。入力はmacOSの合成音声PCMだけを使用し、実マイクやユーザー録音は使用していない。受付→採用の実接続までは確認できたが、その後の業務Agent接続失敗により、3担当を通した結合成功とはしていない。

| 確認 | 結果 |
| --- | --- |
| 起動時履歴の実APIスキーマ | 最初の切替でuser履歴の`type: text`が400となった。`user: input_text` / `assistant: output_text`に修正し、型の回帰を含む局所10/10テスト成功。その後の候補作成は成功 |
| 受付の合成入力・応答 | 「テスト太郎」と受付確認の入力を認識し、株式会社HaaSの一般受付として音声応答 |
| 受付→採用の2段階切替 | 同じ`case_id`でhandoff→新WebRTC接続→activate成功。`session.started`で`shida`→`harema`を確認 |
| 音声の受信 | 成功した切替試行で受付1,370フレーム（非無音193）、採用1,202フレーム（非無音603）、音声受信エラー0。採用側のactivate前は非無音0 |
| activate再送 | 同じ候補IDとtokenで200・同一結果を確認。tokenは証跡へ保存していない |
| 採用Agentへの業務引継ぎ | `department_selection`の開始後に`Connection error.`。この試行の面談質問、元Agent復帰、名前の意味的な保持は未確認 |
| 限定した再試行 | キーなしのOpenAI到達確認は401・3.53秒。その後の再試行は候補作成前の汎用400で終了。候補IDやprovider status付き診断はなく、同じ接続障害か別の例外かは未確定 |
| HaaSの`marin`音声・3担当結合 | この声切替試行では未到達。14:42のHaaS経路単独検証とは区別する |
| 終了 | 返された全Live IDへ終了要求を実施し、全WebRTC peerを閉じた。`cleanup_pending`はすべて空。型エラー試行の受付は`session.closed`確認済み。他の試行は`close_requested`でfinalization応答未確認。今回の業務Agent作成IDは返っていない |
| 接続直後の自動挨拶 | 入力前の25秒は無音。合成入力後の挨拶は確認。入力なしでの自動発話は未確認 |

ローカル証跡は`/Users/limo/Documents/Codex/2026-10-18/moj/work/`の`webrtc-handoff.py`、`voice-handoff-1792303785.json`（型エラー・正常終了）、`voice-handoff-1792303855.json`（受付→採用の実切替）、`voice-handoff-1792303986.json`（限定再試行）。局所テストログは`/Users/limo/Documents/Development/logs/dev-runs/2026-10-18/run-15i9lleu.log`。受信フレームとサーバーのvoice設定を検証したもので、人による音色・聞き取りやすさの評価ではない。

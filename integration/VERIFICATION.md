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

- pupuのReact4画面と、r74techのWorker/DO/D1への接続。相手のローカルコードは未push時点の報告であり、このPRとの結合試験はまだ。
- Node handoff_idとWorker requestIdの対応、社員認証/claim/revisionを通した結果APIアダプター。
- 実機ベル、受話器からの実回答、人間の音声経路。
- 実ChatGPT Work/dotsのMCP Events購読と、購読後の業務実行。
- 公開Web、アプリ認証、本番リポジトリへの移管、永続case復旧。

PRはDraftのまま共有し、これらの境界・受入範囲をマージ時に判断する。

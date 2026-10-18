# 本番の声交代と復帰の受入記録

関連は[#32](https://github.com/pupuchan1/future-company/issues/32)、[#35](https://github.com/pupuchan1/future-company/issues/35)、[#34](https://github.com/pupuchan1/future-company/issues/34)。
NodeとWorkerの最新版配備は並行作業で更新されるため、各試験で確認したソースとWorker versionを固定して記録する。

## 2026-10-18 16:37〜16:38 JSTのAPI試験

| 対象 | 値 |
| --- | --- |
| 入口 | `https://future-company-demo.r74.workers.dev` |
| 製品ソース | `617612592fda658304fe87f68d2166ceeac5f9c7` |
| Worker | `66e5c8ad-22ff-491d-a735-d90f9b1aefbe`、100%配信 |
| relay | `https://ellen-grid-entrance-mails.trycloudflare.com` |
| Node | 本番4350、relay4351 |
| 試験機器 | 試験専用ID、`simulated=true`。実機IDのblack-phone-1を占有しない |
| 入力 | 認証付きの実Worker API、公開MCPと公開WSS。Liveセッションは作成しない |

試験後にruntimeのsourceCommitとrelay origin、Cloudflareのdeployment一覧を取得して照合した。
以下の結果は本番Nodeの機器処理とWorker APIの確認であり、元Agentの再開や音声発話の回数を含まない。

| 試験 | 結果 |
| --- | --- |
| 所有者なし | case別voice/statusが401 |
| 別caseの所有者cookie | 対象caseのvoice/statusが404で拒否 |
| 異Origin | voice/statusが403 |
| Nodeの同一依頼再送 | 同じhandoff IDが返り、ring.startは1回 |
| Nodeの取消後に回答が遅着 | cancelledを維持し、event.ack.accepted=false、回答本文なし |
| 受諾後に機器接続を切断 | unavailable、reason=device_disconnected |
| 同じ機器IDで再接続し、旧commandで回答 | accepted=false |
| 再接続後に別caseで新規依頼 | 新handoffで完了。回答を含む同じon_hookの再送はaccepted=false |
| Workerの同一command回答再送 | 200、revision3を維持、request1件、回答内容不変 |
| Workerの別case | request0件を維持 |
| case別SSE | case Aに人間イベント8件、case Bに4件。互いのcase IDを含む人間イベントなし |
| SSEの正常期限終了 | Aは59,856ms、Bは60,016msで終了 |
| 期限終了後のSSE再購読 | 同じ所有者cookieで200、status再取得も200 |
| voice/status連続8回 | 全て200、530は再現しなかった |

Workerへの回答再送試験とNodeの機器試験は独立に実行した。
Nodeの機器回答をWorkerBridge経由で自動保存した通し試験とは扱わない。
SSEはHTTPで再購読した結果であり、ブラウザEventSourceの自動再接続や履歴補完は別途確認する。

### 試験ID

| 対象 | ID |
| --- | --- |
| case A | `case-188189535b515dcc43924074a924fa7d3c72f9a4720352cb74db83a3e4fbd951` |
| case B | `case-f47490ea9a84ff8aad07b090aabd05d348da692b322520a54d83975e157639c2` |
| 取消 | `20d1f261-dd0a-401d-9b4f-06d395cd7b39` |
| 切断 | `54963902-a439-4193-ac7a-174fe1724b4c` |
| 再接続後の新規依頼 | `34ab12f0-dfd7-4ccd-8f96-a289fe96c123` |
| Worker回答再送 | `request-handoff-acceptance-persist-d2506127-79cf-4169-82b2-a65412a730d6` |

連続status取得のCF-Rayは`a4c5e07f2ac02da1-NRT`から`a4c5e0924f712da1-NRT`まで記録した。
初回のvoice/status530は原因未特定のまま。
今回再現しなかったことを恒久解消の根拠にはしない。
再発時は時刻、case、path、status、CF-Ray、WorkerとNodeのログ、トンネル生存を同時に確認する。

### 試験コードの訂正

最初の試行は別case cookieに401を期待したが、実装の秘匿応答は404だった。
期待値を実際の契約へ合わせて新規caseで再試験し、上記の結果を得た。
最初の試行はvoice接続、機器接続や回答保存の成功に数えない。

## 続けて確認する項目

- 最新固定配備での自動声交代と、交代中に返る回答の1回の音声返却。
- HaaSから採用への交代、候補接続失敗時の旧会話と終了操作の維持。
- Live切断と再接続、ブラウザのSSE再購読、回答再送と遅着時の重複発話。
- 実機接続後、新規依頼で実ベル、受諾、実人間回答の保存と音声返却。

本記録作成時、本番Nodeの実機接続は未確認。
試験専用機器は切断して終了した。

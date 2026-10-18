# 確認した根拠

2026-10-18に開いた一次資料と観測。接続試験の証拠ではない。

| 資料 | 設計への反映 |
| --- | --- |
| ユーザー添付の会議原文 | 英語公開Web、会話中の業務ツール、人への依頼、問い合わせ・商談・採用 |
| [FEブランチの確認コミット](https://github.com/pupuchan1/future-company/tree/805e7db9d24e8f5884a09cf01f1e17f188000e4d) | frontendのReact workspaceへ接続する |
| [HonoとCloudflare Vite plugin](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/) | APIとFEを一つのWorkersアプリへ統合する |
| [DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | 受信WSを休眠可能にし、状態を永続化する |
| [DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) | 再試行を導入する処理では重複実行と停止条件を持つ |
| [D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/) | prepared statementsで業務データを扱う |
| [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) | サーバーがSDPを交換し、ブラウザへAPIキーを出さない |
| [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation) | client delegationへアプリの会話文脈を渡す |
| [Live server controls](https://developers.openai.com/api/docs/guides/voice-server-controls) | sidebandで業務処理をサーバーが所有する |
| [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) | 業務仕事をsessionへ結びつける |
| [Agents session](https://developers.openai.com/api/docs/guides/agents-api/sessions) | 保存された仕事へ入力を追加する |
| [Agents webhooks](https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks) | idleと成功を分け、現在sessionを取得する |
| [DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026) | MCPイベントでChatGPTの仕事を動的に起動する |
| [MCP Events](https://developers.openai.com/plugins/build/mcp-events) | MCP 2.0対応購読と署名Webhook |
| [MCP認証](https://developers.openai.com/plugins/build/auth) | Work連携を業務APIの認証と分ける |
| [Agents MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp) | 業務AIにツールを公開する |
| [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) | 人同士の音声接続で中継条件を試験する |

MCPガイドが参照する草案とOpenAI対応仕様にはcallbackエラーコードの差がある。
ChatGPT向けはOpenAIの対応仕様を基準とし、草案をそのまま実装しない。

配布キーはローカルの環境変数・設定ファイルで見つからなかった。
配布プロジェクトの利用権限、Workの購読設定、callback接続、音声と電話実機は未実測。
会議の締切時刻は複数の発言が混在している。最新の参加案内は開いていないので期限を確定しない。

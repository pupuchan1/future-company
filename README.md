# Future Company

フロントエンドは `frontend/` に配置しています。React + TypeScript + Vite の構成です。

## 開発を始める

Node.js 24.14 以上の 24 系と npm を使用します。nvm を使う場合は `nvm install` / `nvm use` で切り替えられます。

リポジトリのルートで実行してください。

```sh
npm ci
npm run dev
```

ターミナルに表示される URL（通常は http://localhost:5173）を開きます。
最初に編集する画面は `frontend/src/pages/HomePage.tsx` です。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバーを起動 |
| `npm run build` | 型チェックと本番ビルド。出力先は `frontend/dist/` |
| `npm run lint` | Oxlint でコードをチェック |
| `npm run typecheck` | TypeScript の型チェック |
| `npm run preview` | ビルド済み画面をローカルで確認 |

npm workspaces を使用し、依存関係はルートの `package-lock.json` で管理します。
パッケージ追加はルートから `npm install <package> -w frontend` を実行してください。

## 構成

```text
frontend/
├── public/           # そのまま配信する画像など
├── src/
│   ├── assets/       # import して使う画像など
│   ├── components/   # 共通 UI 部品
│   ├── features/     # 機能ごとの UI・処理
│   ├── hooks/        # 共通カスタムフック
│   ├── lib/          # API クライアント・共通処理
│   ├── pages/        # 画面
│   ├── styles/       # 共通 CSS
│   ├── types/        # 共通の型定義
│   ├── App.tsx       # アプリ全体の組み立て
│   └── main.tsx      # エントリーポイント
└── .env.example      # 環境変数の設定例
```

`@/` で `frontend/src/` を参照できます（例: `@/components/Button`）。
画面追加や API 接続は今後の実装に合わせて追加してください。ルーターや状態管理ライブラリはまだ導入していません。

環境変数が必要になったら `frontend/.env.example` を `frontend/.env.local` にコピーしてください。
`VITE_` から始まる環境変数はブラウザに公開されます。秘密鍵やサーバー専用の認証情報は保存しないでください。

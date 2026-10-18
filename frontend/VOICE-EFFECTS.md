# 音声オーブ

最新判断は [#54](https://github.com/pupuchan1/future-company/issues/54)。ElevenLabs UIのOrbコンポーネント本体を無改変で採用しています。以前の独自シェーダー、生成ノイズ、外形変形、移動する独自焦点の実験は撤去しました。

## 出典と一致の確認

- [公式Orb.tsx](https://github.com/elevenlabs/ui/blob/3a28ebab197f8cfa599934f52db12ad1396e54f4/apps/www/registry/elevenlabs-ui/ui/orb.tsx)
- 固定commit: `3a28ebab197f8cfa599934f52db12ad1396e54f4`
- 配置先: `src/features/voice/elevenlabs/Orb.tsx`
- 元ファイルとのcmp一致、SHA256: `16fdb804e37c495806091d34712e689f89c02b4638bb173ab5bef5e5eac52b91`
- Three.js / React Three Fiber / Drei、元のCDNノイズテクスチャ、元の数式を使用。seed=1000。配色は別チャットのユーザー追加指示を反映し、公開colors引数で青 `#7F9FC9` / ベージュ `#E8D5B5` を指定。
- MIT / Copyright (c) 2025 Eleven Labs Inc. 許諾表示全文は同ディレクトリのLICENSE.mdと、配布される `public/licenses/elevenlabs-ui.txt` に同梱。

## アプリへの接続

`OfficialOrbView` は公式コンポーネントの外側のラッパーです。描画本体は変更せず、音量・表示寿命・丸い外枠を扱います。

- 入力の強さは既存マイクの実音量。公式Listeningデモは内部の流れにも値を与えているため、その描画パラメータには入力/出力の実音量の大きい方を渡します。模擬の固定音量には置き換えません。
- AIが発話中という判定と、外側のグレーの点線円は、再生可能な実AI音声だけに反応します。入力の音量でAI出力として表示することはありません。
- ミュート・停止・無効/終了トラック・停止中AudioContextでは入力を消し、AIの停止・ミュート・音量0・再生拒否では出力を消します。
- 担当切替・会話終了では状態をリセットし、古い接続からの更新を無視します。
- 画面外・タブ非表示では公式Canvasをunmountし、GPU描画を止めます。動きを減らす設定・描画エラー時は静止した丸へ戻します。
- スクロールで受付が隠れると右下の小さい丸に同じ入出力を表示します。押すと元の位置へ戻るだけで、新しい音声接続は作りません。
- 共通受付の短い状態表示と単一の開始ボタンを維持し、凡例や例文は追加しません。

音声解析はPR26のcreateAudioMeterを共用し、追加のgetUserMediaやマイクからスピーカーへの接続は作りません。30Hzの音量はVoiceActivityStore経由でオーブのみ更新し、会話スナップショットの更新は約10Hzです。

## 検証用ページ

開発サーバーの `/voice-effects.html`。合成音声には音節のような強弱があり、音量スライダーはGainNodeを変えます。「自分のマイクで試す」を押した場合だけマイクを端末内で解析します。切替・終了・画面破棄時に停止し、許可待ちの遅い応答は破棄します。AIへの送信・スピーカー再生・音声保存は行いません。本番のentryや操作導線には含めません。

`npm run test:frontend` / `npm run build:frontend` / `npm run lint --workspace frontend`

合成信号による表示検証と、実際のAIとの通話検証は別です。実AIは環境設定後に確認します。

参照: [ElevenLabs UI Orb公式デモ](https://ui.elevenlabs.io/docs/components/orb)、[Web Audioの可視化（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)。画像生成スキルは確認しましたが、動作を忠実に再現する今回の実装には生成画像を混ぜていません。

見直しの履歴: [#42](https://github.com/pupuchan1/future-company/issues/42)、[#46](https://github.com/pupuchan1/future-company/issues/46)、[#47](https://github.com/pupuchan1/future-company/issues/47)、[#48](https://github.com/pupuchan1/future-company/issues/48)、[#49](https://github.com/pupuchan1/future-company/issues/49)、[#50](https://github.com/pupuchan1/future-company/issues/50)、[#54](https://github.com/pupuchan1/future-company/issues/54)。公式無改変の採用が、途中の独自描画案より優先です。

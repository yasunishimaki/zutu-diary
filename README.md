# 頭痛ダイアリー（音声問診つき）

片頭痛のある方が発作を記録して、**受診のときに先生に見せる**ためのダイアリーアプリです。
就活ノート（ペーパーデザイン）と、AI問診メモアプリ「ココマデ」（音声問診・記録主義）の考え方を応用しています。

## 3つの中核体験

1. **音声問診** — アプリが順番に質問を読み上げ、声で答えるだけで記録が埋まる（頭が痛いときに画面を注視しなくていい）
2. **月間カレンダー** — 頭痛の日が強さの色で一目でわかる。薬を飲んだ日には💊マーク
3. **受診サマリー** — 頭痛日数・服薬日数・よくある誘因を自動集計。**印刷して渡す**ほかに、**QRコードを受付で読み取ってもらう**こともできる（まとめ＋直近の記録をテキストで収録。専用アプリ不要、カメラをかざすだけ）

## 使い方

ビルド不要。`index.html` をブラウザで開くだけで動きます（音声問診は Chrome 推奨）。

1. **記録する** — 「🎤 問診をはじめる」を押すと、12問の問診が始まる
   - 始まった時間 / 強さ / 場所 / 拍動性 / 前兆 / 吐き気 / 光・音過敏 / 誘因 / 薬と効果 / 生活への影響 / メモ
   - 声で答えると日本語をルールベースで解析して項目に変換（「昨日の夜から」→日付を昨日に）
   - マイクが使えない環境でも、**クイックボタン＋文字入力で全質問に回答できる**
2. **カレンダー** — 月の頭痛日数・服薬日数を集計。服薬が月10日以上になると、薬剤の使用過多による頭痛（MOH）の注意書きを表示
3. **受診サマリー** — 過去1/3/6ヶ月の記録一覧と集計。「🖨 印刷して持っていく」で印刷用レイアウトに、「📱 QRコードで見せる」で読み取り用QRを表示（内容が多いときは直近分に自動調整）

## 記録項目（日本頭痛学会式ダイアリーに準拠）

強さ（軽/中/強）・部位・拍動性・前兆・吐き気・光音過敏・誘因（寝不足/天気/生理/ストレス等）・服薬と効果・生活支障度・メモ

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | 【患者用】記録（音声問診/フォーム）・カレンダー・受診サマリーの3画面 |
| `reception.html` | 【受付用】QRリーダー。カメラで読み取り→表示→印刷。保存・送信はしない |
| `styles.css` | 和紙×明朝のペーパーデザイン（就活ノート系譜）・印刷用CSS |
| `app.js` | 問診エンジン・日本語解析（ルールベース）・集計・音声入出力（Web Speech API） |
| `functions/api/summarize.js` | 【サーバー】メモ要約API。OpenAI APIへの中継（キーはシークレット） |

## デプロイ（Cloudflare Pages）

静的ファイルのみなのでビルド不要。患者用・受付用を別プロジェクトとして配信している。

- **患者用**: https://zutsu-diary.pages.dev/ （index.html + styles.css + app.js）
- **受付用**: https://zutsu-reception.pages.dev/ （reception.html を index.html として + styles.css）

更新手順:

```
npx wrangler login   # 初回のみ
mkdir -p dist-patient dist-reception
cp index.html styles.css app.js dist-patient/
cp reception.html dist-reception/index.html && cp styles.css dist-reception/
npx wrangler pages deploy dist-patient   --project-name=zutsu-diary     --branch=main --commit-dirty=true
npx wrangler pages deploy dist-reception --project-name=zutsu-reception --branch=main --commit-dirty=true
```

`--branch=main` を付けないとプレビュー配信になるので注意。
カメラ（QR読み取り）とマイク（音声問診）は HTTPS が必要 → pages.dev はHTTPSなのでそのまま動く。

## 設計原則（ココマデから継承）

1. 回答・集計は**本人の記録からのみ**つくる。診断・推測はしない
2. 音声が使えない環境でも、ボタン＋テキストで全機能が動く
3. データは端末の localStorage にのみ保存。JSONで書き出し/読み込みできる

## メモの要約（OpenAI API・任意機能）

「先生に伝えたいこと」だけは自由発話なので、40文字以上のメモは保存後に裏で要約する。
`functions/api/summarize.js`（Cloudflare Pages Functions）が中継し、APIキーはサーバー側シークレットに置く（ブラウザには渡らない）。モデルは gpt-4o-mini（低コスト・低遅延）。

- 有効化: Cloudflareダッシュボード → zutsu-diary → Settings → Variables and Secrets で
  シークレット `OPENAI_API_KEY` を追加（CLIなら `npx wrangler pages secret put OPENAI_API_KEY --project-name=zutsu-diary`）。設定後に再デプロイで反映
- キー未設定・オフライン・エラー時は**原文のまま保存**（要約は上乗せ機能。壊れても本体は動く）
- 要約後も原文は `memoRaw` として記録に残る。表示は「メモ(要約)」

## 割り切り（プロトタイプ）

- 音声認識・合成は Web Speech API（Chrome 推奨）
- 12問の解釈はローカルのルールベース。自由発話のメモ要約のみ OpenAI API（上記）
- データ同期・アカウントなし（実証版では Supabase を想定）

⚠ このアプリは記録の道具であり、診断はしません。いつもと違う突然の激しい頭痛・手足のしびれ・ろれつが回らない等があるときは、すぐに医療機関へ。

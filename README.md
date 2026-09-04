# Instagram Tarot Auto Simple

GitHubとRailwayに上げやすい最小版です。

## ファイル

- `server.js`: Webhook受信とMeta APIへの返信
- `flows.js`: 初期フロー、キャプション目印、公開返信、DM鑑定文
- `db.js`: Postgres保存、テーブル作成、同期処理
- `admin.html`: Railway上で見る管理画面
- `package.json`: Railwayが依存関係を入れて起動するための設定
- `railway.json`: Railwayの起動設定
- `.env.example`: 環境変数の見本

## 使い方

1. このフォルダの中身をGitHubに上げる
2. RailwayでGitHubリポジトリを選んでデプロイ
3. Railway Variablesに以下を入れる

```text
VERIFY_TOKEN=自分で決めた文字列
IG_USER_ID=InstagramプロアカウントID
IG_USERNAME=自分のInstagramユーザー名
ACCESS_TOKEN=Metaのアクセストークン
ADMIN_TOKEN=管理画面用の好きな長い文字列
DATABASE_URL=Railway Postgresを追加すると自動で入ります
APP_ID=MetaアプリID
APP_SECRET=Metaアプリシークレット
GRAPH_BASE_URL=https://graph.facebook.com
GRAPH_API_VERSION=v25.0
```

4. Meta DeveloperのWebhook URLに設定

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/webhook
```

5. 対象リールのキャプション末尾に入れる

```text
[auto:tarot-001]
```

6. 管理画面で「Instagramから同期」を押す
7. 対象リールをクリックしてコメント一覧を確認する
8. そのリールに `1` / `2` / `3` / `1番` / `２番` などでコメントすると返信します。

## 管理画面

Railwayにデプロイしたら、以下で見られます。

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/admin?token=ADMIN_TOKENの値
```

見られるもの:

- 環境変数が入っているか
- 登録されているキャプション目印
- 処理済みコメント数
- 最新投稿の取得
- 投稿ごとのキャプション目印チェック
- サムネ付き対象リール一覧
- 投稿ごとのコメント一覧
- 自分のコメント除外
- コメント文の疑似判定
- 自動化フロー一覧
- 今日のDM送信数とエラー数
- 短期User TokenからPage Access Tokenを取得
- 受信したコメント、無視した理由、送信結果、エラー

`ADMIN_TOKEN` を入れていない場合は `/admin` だけで開けますが、外から見えるURLなので設定するのがおすすめです。

## トークン更新

管理画面の「トークン更新」で以下ができます。

1. Graph API Explorerで短期User Tokenを作る
2. 管理画面に貼る
3. 「長期Tokenに交換」を押す
4. 「Page Tokenを取得」を押す
5. 返ってきた `pages[].access_token` をRailwayの `ACCESS_TOKEN` に入れる
6. 返ってきた `pages[].instagram_business_account.id` をRailwayの `IG_USER_ID` に入れる

この機能を使うには、Railway Variablesに以下も入れてください。

```text
APP_ID=MetaアプリID
APP_SECRET=Metaアプリシークレット
```

トークンは画面に表示するだけで、Postgresには保存しません。

## Postgres連携

RailwayでPostgresを追加すると、`DATABASE_URL` が自動で使えるようになります。

```text
Railway Project
↓
New
↓
Database
↓
Add PostgreSQL
```

`DATABASE_URL` がある場合は、以下をPostgresに保存します。

- 自動化フロー
- どの投稿media_idが対象マーカー付きか
- サムネURL、キャプション、コメント数、いいね数
- 投稿ごとのコメント一覧
- 返信済みのcomment_id
- 受信、無視、送信、エラーの履歴

自分のコメントを除外するため、`IG_USERNAME` も入れてください。`@` はあってもなくても動きます。

`DATABASE_URL` がない場合もアプリは動きますが、Railwayの再起動で履歴と返信済み情報は消えます。

## プライバシーポリシー

MetaアプリのPrivacy Policy URLには以下を入れます。

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/privacy
```

## 鑑定文の編集

`flows.js` のこのあたりを書き換えます。

```js
privateReply: "1を選んだあなたへ..."
```

複数リールを分けたい場合は、`flows` に同じ形で追加します。

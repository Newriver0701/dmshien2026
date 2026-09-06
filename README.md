# Instagram Tarot Auto Simple

Instagramログイン方式で動かす、GitHubとRailwayに上げやすい最小版です。

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
IG_USER_ID=API setup with Instagram Loginで表示されるAccount ID
IG_USERNAME=自分のInstagramユーザー名
ACCESS_TOKEN=API setup with Instagram Loginで生成したAccess Token
ADMIN_AUTH_ENABLED=false
ADMIN_TOKEN=
DATABASE_URL=Railway Postgresを追加すると自動で入ります
APP_SECRET=Metaアプリシークレット
GRAPH_BASE_URL=https://graph.instagram.com
GRAPH_API_VERSION=v26.0
```

`APP_SECRET` はInstagram短期Tokenを長期Tokenに交換する時に使います。

4. Meta Developerの `Use Cases -> Customize -> API setup with Instagram Login` でWebhook URLに設定

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/webhook
```

5. Verify TokenにはRailwayの `VERIFY_TOKEN` と同じ文字列を入れる
6. Webhook fieldは `comments` を購読する
7. アプリを公開する
8. 対象リールのキャプション末尾に入れる

```text
[auto:tarot-001]
```

9. 管理画面で「Instagramから同期」を押す
10. 対象リールをクリックしてコメント一覧を確認する
11. そのリールに `1` / `2` / `3` / `1番` / `２番` / `①` / `②` / `③` などでコメントすると返信します。

## 管理画面

Railwayにデプロイしたら、以下で見られます。

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/admin
```

見られるもの:

- 環境変数が入っているか
- 登録されているキャプション目印
- 処理済みコメント数
- 最新投稿の取得
- 投稿ごとのキャプション目印チェック
- サムネ付き対象リール一覧
- 投稿ごとのコメント一覧
- コメントごとの `comment_id` / `media_id` / ユーザー情報
- コメント単体の再取得
- Metaのコメント取得APIレスポンスの生JSON表示
- 自分のコメント除外
- コメント文の疑似判定
- 自動化フロー一覧
- 1/2/3ごとの公開返信バリエーション編集
- 今日のDM送信数とエラー数
- 今日Webhookで受けたコメント数
- 今日Webhookで受けたコメントの投稿別サマリー
- 受信したコメント、無視した理由、送信結果、エラー

初期状態では管理画面認証は無効です。
あとで認証をかけたい場合だけ、Railway Variablesに以下を入れてください。

```text
ADMIN_AUTH_ENABLED=true
ADMIN_TOKEN=管理画面用の好きな長い文字列
```

その場合の管理画面URLは以下です。

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/admin?token=ADMIN_TOKENの値
```

## Instagramログイン方式

この版はInstagramログイン方式だけで動かします。`IG_USER_ID` と `ACCESS_TOKEN` は、同じInstagramログイン画面で取得したAccount IDとAccess Tokenの組み合わせにします。

1. Meta App Dashboardで `Use Cases -> Customize`
2. `API setup with Instagram Login` を開く
3. 必要権限を追加する
   - `instagram_business_basic`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_messages`
4. Instagram Testerを追加し、Instagram側で招待を承認する
5. `Generate access tokens` でAccess Tokenを発行する
6. 管理画面の「Instagram長期Tokenに交換」に貼る
7. 返ってきた `accessToken` をRailwayの `ACCESS_TOKEN` に入れる
8. 同じ画面のAccount IDを `IG_USER_ID` に入れる
9. 同じ画面のWebhook設定で `/webhook` を登録する

長期Tokenは約60日で期限切れします。
管理画面の「Instagram長期Tokenを更新」で更新し、返ってきた `accessToken` をRailwayの `ACCESS_TOKEN` に入れ直してください。

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

公開コメント返信は、管理画面の「自動化フロー」から編集できます。
1行につき1パターンとして保存され、送信時にランダムで選ばれます。

DM鑑定文は固定文として扱うので、変更したい場合は `flows.js` のこのあたりを書き換えます。

```js
privateReply: "1を選んだあなたへ..."
```

複数リールを分けたい場合は、`flows` に同じ形で追加します。

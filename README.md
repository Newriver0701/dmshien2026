# Instagram Tarot Auto Simple

GitHubとRailwayに上げやすい最小版です。

## ファイル

- `server.js`: Webhook受信とMeta APIへの返信
- `flows.js`: キャプション目印、公開返信、DM鑑定文
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
ACCESS_TOKEN=Metaのアクセストークン
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

6. そのリールに `1` / `2` / `3` / `1番` / `２番` などでコメントすると返信します。

## 鑑定文の編集

`flows.js` のこのあたりを書き換えます。

```js
privateReply: "1を選んだあなたへ..."
```

複数リールを分けたい場合は、`flows` に同じ形で追加します。

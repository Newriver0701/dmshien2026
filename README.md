# Instagram Tarot Auto Simple

Instagramログイン方式だけで動かす、Pabbly代替のDM自動化ツールです。

Webhookでコメントを受け取り、番号判定、タスク履歴作成、鑑定文生成、返信文準備、公開返信、Private Reply DM送信、おみくじ追加DMまでRailway上で完結します。送信は初期OFFなので、まずは送信直前までの準備状態を確認できます。

## できること

- Webhookコメント1件ごとにタスク履歴を作成
- 鑑定DM OFF時は、コメント保存、番号判定、鑑定文生成、返信文準備まで実行
- 鑑定DM ON時は、公開返信とPrivate Reply DMまで自動送信
- おみくじON時は、鑑定DM後にGoogle Drive画像からランダムで追加DMを送信
- おみくじOFF時でも、Task Detailから個別に手動送信
- `1 / 2 / 3 / ① / ② / ③ / 1番 / No.2` などをルール判定
- ルールで判定不能な時だけDeepSeekで番号判定
- 投稿キャプションからテーマを抽出し、DeepSeekで①②③を個別に生成
- 投稿ごとに鑑定文を保存し、2件目以降は保存済み文を使う
- 共通の公開返信テンプレートを管理画面で追加、編集、削除
- 送信対象を `全投稿` / `マーカー付きのみ` で切り替え
- 投稿サムネイル、コメント一覧、comment_id、media_id、送信状態を確認
- MetaのコメントAPIレスポンスを生JSONで確認
- 自分のコメントは保存するがDM送信しない

## Railway Variables

```text
PORT=3000
VERIFY_TOKEN=自分で決めた文字列
IG_USER_ID=API setup with Instagram Loginで表示されるAccount ID
IG_USERNAME=自分のInstagramユーザー名
ACCESS_TOKEN=Instagram Loginで発行した長期Access Token
DATABASE_URL=Railway Postgresを追加すると自動で入ります
APP_SECRET=Metaアプリシークレット
GRAPH_BASE_URL=https://graph.instagram.com
GRAPH_API_VERSION=v26.0
DEEPSEEK_API_KEY=DeepSeekのAPIキー
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
GOOGLE_DRIVE_API_KEY=Google Drive APIキー
OMIKUJI_FOLDER_KYOU=凶フォルダーIDまたはURL
OMIKUJI_FOLDER_SUEKICHI=末吉フォルダーIDまたはURL
OMIKUJI_FOLDER_SHOKICHI=小吉フォルダーIDまたはURL
OMIKUJI_FOLDER_CHUKICHI=中吉フォルダーIDまたはURL
OMIKUJI_FOLDER_KICHI=吉フォルダーIDまたはURL
OMIKUJI_FOLDER_DAIKICHI=大吉フォルダーIDまたはURL
PABBLY_UPLOAD_API_URL=Pabbly Upload APIのexecute URL
PABBLY_UPLOAD_API_TOKEN=Pabbly Upload APIのBearer Token
PABBLY_WORKFLOW_STEP_ID=Pabblyへ渡すworkflow_step_id
PABBLY_U_ID=Pabblyへ渡すu_id
PUBLIC_BASE_URL=https://YOUR-RAILWAY-DOMAIN.up.railway.app
ADMIN_AUTH_ENABLED=false
ADMIN_TOKEN=
```

`IG_USERNAME` は自分のコメントを除外するための予備判定です。`@` は入れても入れなくても動きます。

## セットアップ

1. このフォルダの中身をGitHubに上げる
2. RailwayでGitHubリポジトリを選んでデプロイ
3. RailwayでPostgresを追加する
4. Railway Variablesに上の値を入れる
5. Meta Developerの `Use Cases -> Customize -> API setup with Instagram Login` を開く
6. Webhook URLに `https://YOUR-RAILWAY-DOMAIN.up.railway.app/webhook` を入れる
7. Verify TokenにRailwayの `VERIFY_TOKEN` と同じ文字列を入れる
8. Webhook fieldは `comments` を購読する
9. アプリを公開する
10. 必要なら対象リールのキャプションに `[auto:tarot-001]` を入れる

## 管理画面

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/admin
```

左メニューは `Dashboard / Workflows / Task History / Posts / Omikuji / AI Settings / Token` です。

最初は `Workflows` の `鑑定DM` と `おみくじ` がOFFです。OFFでも鑑定文生成と返信文準備までは進み、最後の送信だけ止まります。

鑑定DMをONにしても、Webhook直後に即送信はしません。初期設定では公開返信を `120〜600秒後`、Private Reply DMをそのさらに `180〜600秒後` に送ります。同時に複数コメントが来た場合は、それぞれの待機時間が過ぎたものを並列で処理します。同時送信数は初期 `8`、1時間あたりの送信上限は初期 `150`、24時間あたりは初期 `1000` です。Meta APIの制限らしきエラーが出た場合は、初期 `30分` 停止してから再開します。

DM本文は `Workflows` の `DM本文フォーマット` で編集できます。投稿ごとに生成した鑑定文は `{reading}` に入り、前後に固定文を足せます。使える変数は `{theme}`、`{reading}`、`{displayName}`、`{honorific}`、`{username}`、`{choice}`、`{card}` です。`{displayName}` はユーザー名が取れた時は `username`、取れない時は `あなた` になります。`{honorific}` はユーザー名が取れた時だけ `さん` になります。

おみくじは `Omikuji` の `Drive画像を同期` で、結果別のDriveフォルダーから画像をDBに取り込みます。対応結果は `凶 / 末吉 / 小吉 / 中吉 / 吉 / 大吉` です。同期時にDriveの `webContentLink` を保存し、返らない場合は `https://drive.google.com/uc?export=download&id=FILE_ID` を生成します。画像DMではDrive Content URLをPabbly Upload APIへ渡し、Pabblyレスポンスの `file_url` または `data.file_url` をInstagramへ送ります。Pabblyが失敗した場合、Railway中継URLへは戻さず、画像DMだけエラーとしてタスクに残します。同期済み画像はOmikuji画面で結果別のサムネイル一覧として確認できます。おみくじ本文には `{displayName}`、`{honorific}`、`{result}`、`{theme}`、`{choice}`、`{card}` が使えます。追加DMには `user_id` が必要です。

Pabbly連携はOmikuji画面の `Pabbly Uploadテスト` で確認できます。任意のDrive Content URLを貼るか、同期済み画像カードの `Pabblyテスト` を押すと、Instagram送信なしでPabblyの `file_url` / `data.file_url` 返却だけを確認できます。結果はOmikuji内の専用JSON欄に表示されます。

送信対象は初期状態で `全投稿` です。マーカー付きの投稿だけに絞りたい時は、`Workflows` の `対象投稿` を `マーカー付きのみ` に変更してください。

過去コメントを取り込みたい時は、投稿詳細の `コメント取得＋送信準備` を押してください。コメント保存だけでなく、番号判定、鑑定文生成、返信文準備まで進み、最後は `送信待ち` で止まります。

## Token

この版はFacebook Page Tokenではなく、Instagramログイン方式のTokenを使います。

短期Tokenを長期Tokenへ交換するには、管理画面の `Token` で短期Tokenを貼って `Instagram長期Tokenに交換` を押します。返ってきた `accessToken` をRailwayの `ACCESS_TOKEN` に入れ直してください。

長期Tokenは約60日で期限切れします。期限が近くなったら `Instagram長期Tokenを更新` で更新します。

## プライバシーポリシー

MetaアプリのPrivacy Policy URLには以下を入れます。

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/privacy
```

## 対象投稿

初期状態では、マーカー有無に関係なくWebhookで受けたコメントを番号判定します。鑑定DM ONなら、マーカーなし投稿でも鑑定文生成とDM送信に進みます。

マーカー付き投稿だけに絞りたい場合は、管理画面で `対象投稿` を `マーカー付きのみ` に変更し、対象リールのキャプションへ以下を入れます。

```text
[auto:tarot-001]
```

`マーカー付きのみ` の時でも、マーカーがない投稿は同期・表示できます。ただしWebhookでコメントが来ても `対象外リール` として保存し、DM送信はしません。

## DeepSeek

DeepSeekは2つの用途で使います。

- ルールで判定できないコメントの番号判定
- 投稿ごとの三択タロット鑑定文生成

番号判定はJSONのみ、鑑定文生成はプレーンテキストのみで受け取ります。鑑定文は①②③を個別に生成してDBへ保存します。
鑑定文では相手の性別が分からない前提で、`彼` / `彼女` などの性別断定語は使わず、`あの人` / `お相手` に寄せます。生成後も保存前に軽く置換します。

キャプションからテーマを抽出できない場合は、精度優先のため生成せず `テーマ未設定のため鑑定文を生成できません` と表示します。

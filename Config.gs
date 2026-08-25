/**
 * GAS ファイル共有アプリ ― 設定値
 *
 * 仕様: アップロード → 期限付きURL発行 → URLからダウンロード → 期限切れ後は自動削除
 *
 * 【ファイル構成】
 * このプロジェクトの .gs ファイルはすべて同一のグローバルスコープを共有するため、
 * ファイル間の import/export は不要(どのファイルからでも他ファイルの関数・変数を参照できる)。
 * 役割ごとに以下のように分割している。
 *   Config.gs           このファイル。定数の一元管理
 *   Router.gs           doGet エントリーポイント・画面描画(HTML返却)
 *   UploadService.gs    アップロード処理(Turnstile検証を含む)
 *   DownloadService.gs  ダウンロード処理(google.script.run 経由)
 *   Sanitize.gs          入力値の検証・サニタイズ
 *   Storage.gs           Drive/Sheets アクセス層(DB代わりのスプレッドシート・保存フォルダ)
 *   Maintenance.gs       期限切れファイルの自動削除・トリガー管理
 *   Utils.gs              汎用ユーティリティ
 *
 * 【初回セットアップ必須】セキュリティ対策
 *   スクリプトエディタ左メニュー「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定してください。
 *     TURNSTILE_SITE_KEY   : Cloudflare Turnstile のサイトキー(公開してよい値)
 *     TURNSTILE_SECRET_KEY : Cloudflare Turnstile のシークレットキー(絶対に公開しない)
 *   取得方法は README.md を参照してください。
 *
 * 【ファイル形式】原則すべて許可する(拡張子・MIMEタイプによる制限は行わない)。
 * 代わりに、配信時に必ず application/octet-stream として返す「強制ダウンロード」方式で、
 * HTML/SVG/JS等がブラウザ上で実行・レンダリングされることを防いでいる(DownloadService.gs 参照)。
 */

// ==== 基本設定値 ====
var MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
var MAX_MIME_TYPE_LENGTH = 255; // data:URLのMIMEタイプ部分の長さ上限(不正な巨大文字列の混入防止)
var FOLDER_NAME = 'FileShareApp_Storage';
var SHEET_NAME = 'FileShareApp_DB';
var DEFAULT_EXPIRY_HOURS = 24; // 1日
var VALID_EXPIRY_HOURS = [1, 3, 6, 12, 24, 72, 168]; // 1h,3h,6h,12h,1d,3d,7d
var TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
var DELETE_TRIGGER_HANDLER = 'deleteExpiredFiles_';
var DELETE_TRIGGER_INTERVAL_MINUTES = 15;
var LOCK_WAIT_TIMEOUT_MS = 30000; // Drive/Sheet書き込み用ロックの最大待機時間
// deleteExpiredFiles_ 用のロック待機時間。uploadFile よりかなり短く設定し、
// トリガーの多重起動防止が目的であって「待たされて失敗する」ことが目的ではないため、
// 少し待って取れなければ潔く諦めて次回トリガー(15分後)に委ねる。
var DELETE_LOCK_WAIT_TIMEOUT_MS = 5000;
var FILE_NAME_MAX_LENGTH = 200; // sanitizeFileName_ で切り詰めるファイル名の最大文字数
var HTTP_STATUS_OK = 200; // UrlFetchApp のレスポンスコード比較用
// generateToken_ が生成するトークンは常に32文字の16進数(UUID v4からハイフンを除去したもの)。
// この形式に一致しない入力は、Sheetsへのアクセスを行う前に早期リジェクトする(resolveActiveRecord_参照)。
var TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// ==== 管理用スプレッドシート(DBシート)の列レイアウト ====
// マジックナンバー撲滅のため一元管理する。
var COL_TOKEN = 1;
var COL_FILE_ID = 2;
var COL_FILE_NAME = 3;
var COL_MIME_TYPE = 4;
var COL_EXPIRES_AT = 5;
var COLUMN_COUNT = 5;
var HEADER_ROW = 1;
var DATA_START_ROW = 2; // ヘッダー行の次の行
// 列順は COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE, COL_EXPIRES_AT と一致させる
var SHEET_HEADERS = ['token', 'fileId', 'fileName', 'mimeType', 'expiresAt'];

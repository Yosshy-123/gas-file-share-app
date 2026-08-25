/**
 * 汎用ユーティリティ関数群。特定の責務(ルーティング/DB/サニタイズ等)に属さない
 * 小さな共通処理をここに集約する。
 */

/**
 * ユーザーにそのまま見せてよい「想定内のエラー」であることを示すマーカーを付与する。
 * uploadFile() の catch でこのマーカーの有無を見て、想定外のシステムエラー(Driveの
 * 割り当て超過等の内部情報)をクライアントに漏らさないようにするために使う。
 */
function userError_(message) {
  var err = new Error(message);
  err.isUserError = true;
  return err;
}

/**
 * expiresAt が(基準時刻 now 時点で)期限切れかどうかを判定する。
 * Storage.gs の resolveActiveRecord_ と Maintenance.gs の deleteExpiredFiles_ の
 * 両方で全く同じ比較が必要になるため、判定基準を一箇所に集約している。
 * now を省略した場合は呼び出し時点の現在時刻を基準にする。
 */
function isExpired_(expiresAt, now) {
  return (now || new Date()) > expiresAt;
}

/**
 * 日時を画面表示用の "yyyy/MM/dd HH:mm" 形式(スクリプトのタイムゾーン基準)に整形する。
 */
function formatDateTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

/**
 * URLトークンを生成する。
 * UUID v4(ハイフン除去で32文字の16進数、約122ビットのランダム性)は
 * 推測不可能なURLトークンとして十分な強度を持つ。
 */
function generateToken_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/**
 * HTMLテンプレートのscriptletから部分HTMLを読み込むための専用ヘルパー。
 * 例: <?!= include_('Common'); ?>
 *
 * 複数のHTMLファイル(Index.html / Download.html)で共通のCSS等を Common.html に
 * 集約し、この関数経由で読み込むことで重複を排除している。
 *
 * 末尾に "_" を付けているのは google.script.run からクライアントに直接呼び出させない
 * ためだが(README「セキュリティ上の注意」参照)、scriptlet(<?!= ?>)自体はサーバー側の
 * テンプレート評価時に実行されるものであり、関数名の "_" の有無に関わらず呼び出せるため、
 * この用途では何ら支障はない。
 */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

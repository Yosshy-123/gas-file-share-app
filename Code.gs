/**
 * GAS ファイル共有アプリ
 * 仕様書: アップロード → 期限付きURL発行 → URLからダウンロード → 期限切れ後は自動削除
 *
 * セキュリティ対策(初回セットアップ必須):
 *   スクリプトエディタ左メニュー「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定してください。
 *     TURNSTILE_SITE_KEY   : Cloudflare Turnstile のサイトキー(公開してよい値)
 *     TURNSTILE_SECRET_KEY : Cloudflare Turnstile のシークレットキー(絶対に公開しない)
 *   取得方法は README.md を参照してください。
 */

// ==== 設定値 ====
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
// この形式に一致しない入力は、Sheetsへのアクセスを行う前に早期リジェクトする。
var TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// 管理用スプレッドシート(DBシート)の列レイアウト。マジックナンバー撲滅のため一元管理する。
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

// ファイル形式は原則すべて許可する(拡張子・MIMEタイプによる制限は行わない)。
// 代わりに、配信時に必ず application/octet-stream として返す「強制ダウンロード」方式で、
// HTML/SVG/JS等がブラウザ上で実行・レンダリングされることを防いでいる(serveFile_ 参照)。

// ==== エントリーポイント ====

function doGet(e) {
  try {
    var token = e.parameter.token;
    var action = e.parameter.action;

    if (token) {
      // generateToken_ が生成する形式(32文字の16進数)に一致しない token は、
      // Sheetsへ問い合わせるまでもなく無効なリンクと確定できるため早期リジェクトする。
      // これによりレート制限のない現状でも無駄なSheets APIアクセスを抑えられる。
      if (!TOKEN_PATTERN.test(token)) {
        return renderDownloadPage_('notfound');
      }
      if (action === 'download') {
        return serveFile_(token);
      }
      return showDownloadPage_(token);
    }

    var props = PropertiesService.getScriptProperties();
    var siteKey = props.getProperty('TURNSTILE_SITE_KEY');
    // uploadFile() は verifyTurnstile_() 内で TURNSTILE_SECRET_KEY 未設定を
    // フェイルクローズ(エラー)として扱う。そのため画面側の「設定済み」判定も
    // SITE_KEY だけでなく SECRET_KEY の有無まで見て揃えておかないと、
    // 「ウィジェットは表示されCAPTCHAは通過できるのに、送信すると必ず
    // "サーバー側で未設定です" と失敗する」という利用者視点で原因不明の
    // 状態になってしまう。
    var secretKey = props.getProperty('TURNSTILE_SECRET_KEY');
    var turnstileConfigured = !!siteKey && !!secretKey;

    var template = HtmlService.createTemplateFromFile('Index');
    template.expiryOptions = VALID_EXPIRY_HOURS;
    template.defaultExpiry = DEFAULT_EXPIRY_HOURS;
    template.maxSizeMB = MAX_FILE_SIZE / (1024 * 1024);
    template.turnstileSiteKey = turnstileConfigured ? siteKey : '';
    template.turnstileConfigured = turnstileConfigured;
    return template.evaluate()
      .setTitle('ファイル共有')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    // Drive/Sheetsの一時的な障害・クォータ超過等、想定外の例外をここで必ず捕捉する。
    // 捕捉しない場合、GAS標準の生エラー画面(スタック情報等を含みうる)がそのまま
    // 利用者に表示されてしまうため、常に自前の安全な画面にフォールバックさせ、
    // 詳細はサーバー側ログにのみ残す。
    //
    // 「リンクが無効/期限切れ」(notfound/expired)とは意図的にステータスを分けている。
    // 一律 notfound にしてしまうと、実際にはシステム側の一時的な問題であるにも
    // 関わらず「リンクが恒久的に無効」であるかのように利用者に伝わってしまい、
    // 再試行すれば解決する可能性がある状況で利用者が諦めてしまう(UX上の不親切さ)。
    // 逆に notfound/expired 等の正常系の結果と紛れると運用者側もログを見なければ
    // システム障害の発生に気づけなくなるため、区別しておくことは運用面でも重要。
    console.error('doGet failed: ' + (err && err.stack ? err.stack : err));
    return renderDownloadPage_('error');
  }
}

/**
 * クライアント(Index.html)から google.script.run 経由で呼ばれる
 * base64Data: "data:application/pdf;base64,xxxx" 形式の文字列
 * turnstileToken: Cloudflare Turnstile ウィジェットが発行した検証トークン
 */
function uploadFile(base64Data, fileName, expiryHours, turnstileToken) {
  try {
    // Turnstile検証は重い処理(外部HTTP)なのでロック取得前に行い、ロック保持時間を最小化する
    if (!verifyTurnstile_(turnstileToken)) {
      throw userError_('ロボットではないことの確認に失敗しました。ページを再読み込みしてから、もう一度お試しください。');
    }

    fileName = sanitizeFileName_(fileName);

    var matches = base64Data.match(/^data:(.*?);base64,(.*)$/);
    if (!matches) {
      throw userError_('ファイル形式が不正です。');
    }
    var mimeType = matches[1];
    var rawBase64 = matches[2];

    // mimeTypeにも長さ上限を設ける(fileNameと違いsanitizeFileName_のような切り詰めが
    // なかったため、ここで巨大な文字列を弾かないとシートへの書き込みでロックを浪費しうる)
    if (mimeType.length > MAX_MIME_TYPE_LENGTH) {
      throw userError_('ファイル形式が不正です。');
    }

    var byteSize = estimateBase64ByteSize_(rawBase64);
    if (byteSize > MAX_FILE_SIZE) {
      throw userError_('ファイルサイズが上限(' + (MAX_FILE_SIZE / (1024 * 1024)) + 'MB)を超えています。');
    }

    expiryHours = Number(expiryHours);
    if (VALID_EXPIRY_HOURS.indexOf(expiryHours) === -1) {
      expiryHours = DEFAULT_EXPIRY_HOURS;
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_WAIT_TIMEOUT_MS);
    try {
      var decoded = Utilities.base64Decode(rawBase64);
      var blob = Utilities.newBlob(decoded, mimeType, fileName);

      var folder = getOrCreateFolder_();
      var file = folder.createFile(blob);

      var token = generateToken_();
      var now = new Date();
      var expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

      // appendRow は列の並び順が COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE,
      // COL_EXPIRES_AT (getOrCreateSheet_ のヘッダー定義) と一致している必要がある
      var sheet = getOrCreateSheet_();
      sheet.appendRow([
        token,
        file.getId(),
        sanitizeForSheet_(fileName),
        sanitizeForSheet_(mimeType),
        expiresAt
      ]);

      var url = ScriptApp.getService().getUrl() + '?token=' + encodeURIComponent(token);

      return {
        success: true,
        url: url,
        fileName: fileName,
        expiresAt: formatDateTime_(expiresAt)
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    if (err && err.isUserError) {
      return { success: false, error: err.message };
    }
    // 想定外のエラー(Driveの割り当て超過やネットワーク障害等)は詳細をクライアントに
    // 返さず、サーバー側ログにのみ残す(内部情報の開示を防ぐため)。
    console.error('uploadFile failed: ' + (err && err.stack ? err.stack : err));
    return { success: false, error: 'アップロードに失敗しました。しばらくしてから再度お試しください。' };
  }
}

// ==== 入力検証・サニタイズ ====
// このセクションの関数はいずれも「受け取った値が安全か検証する/安全な形へ変換する」
// という単一の関心事を持つ。ルーティングを担う doGet/showDownloadPage_/serveFile_ 等の
// エントリーポイント関数とは役割が異なるため、明示的にセクションを分けている。

/**
 * Cloudflare Turnstile のトークンをサーバー側で検証する。
 * シークレットキー未設定の場合は「フェイルクローズ」(アップロードを拒否)する。
 */
function verifyTurnstile_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET_KEY');
  if (!secret) {
    throw userError_('サーバー側でTurnstileが未設定です。管理者に連絡してください。');
  }
  if (!token) {
    return false;
  }

  var res = UrlFetchApp.fetch(TURNSTILE_VERIFY_URL, {
    method: 'post',
    payload: {
      secret: secret,
      response: token
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== HTTP_STATUS_OK) {
    return false;
  }

  var json = JSON.parse(res.getContentText());
  return !!json.success;
}

/**
 * ファイル名の安全化。拡張子や形式による制限はしない(全形式許可の方針)が、
 * パス区切り文字・制御文字・Unicode双方向制御文字等を除去し、空/過長なファイル名を弾く。
 * (実際にDriveへ保存するファイル名・ダウンロード時のファイル名として使われる値)
 *
 * 特に、U+202E(RLO)等の双方向制御文字を使うと「実際の拡張子」と「見た目の拡張子」を
 * 乖離させる、いわゆる拡張子偽装(RLOスプーフィング)が可能になるため、これを除去する。
 * 例: "invoice_" + U+202E + "cod.exe" は見た目上 "invoice_exe.doc" のように表示されるが
 *     実体は末尾 ".exe" の実行ファイルである。
 *
 * OS横断的な安全性について: ダウンロード時、ブラウザはサーバーが返したファイル名を
 * そのまま(あるいはOS都合で一部だけ調整して)ローカルファイルとして保存しようとする。
 * このときOSのファイルシステムで使えない文字が含まれていると、ブラウザ・OSの実装次第で
 * 保存に失敗したり、意図しない形に無言で書き換えられたりする(環境依存で挙動が割れる)。
 * そのため、Windows(NTFS)・macOS・Linuxのいずれでも安全に保存できる文字集合に
 * サーバー側で統一しておく。具体的には以下をすべて `_` に置換・除去する:
 *   - `\ /`            : 全OS共通のパス区切り文字(Windows/Unix双方)
 *   - `: * ? " < > |`   : Windows(NTFS/FAT)で予約されている文字
 *       (`:` はmacOS Classicの旧HFSパス区切りでもあり、Finderが `/` に読み替える等
 *        歴史的に混乱を招きやすいため合わせて除去する)
 *   - 制御文字・Unicode双方向制御文字・ゼロ幅文字は従来通り除去
 * 加えて、Windowsでは末尾のドット・スペースが暗黙的に削除される仕様があり、
 * これを悪用した拡張子偽装(例: "file.exe" + "." → 保存後に見た目上ドットが消え
 * "file.exe" のまま実行されてしまう、逆に偽装で隠す手口)を避けるため、
 * 末尾のドット・スペースの整理も従来通り行う。
 */
function sanitizeFileName_(fileName) {
  if (!fileName) {
    throw userError_('ファイル名が不正です。');
  }

  // Unicode正規化(NFKC): 全角/半角・互換文字の表記ゆれを統一する。
  // これにより全角スラッシュ(／)によるパス区切り文字フィルタの回避や、
  // 全角文字(ＣＯＮ 等)によるWindows予約デバイス名の偽装をあわせて検出できるようにする。
  var cleaned = fileName.normalize('NFKC');

  cleaned = cleaned
    .replace(/[\/\\]/g, '_')                                  // パス区切り文字(Windows/Unix共通)
    .replace(/[:*?"<>|]/g, '_')                                // Windows(NTFS/FAT)予約文字・macOS旧HFS区切り(:)
    .replace(/[\x00-\x1f\x7f]/g, '')                          // ASCII制御文字・DEL
    .replace(/[\u0080-\u009f]/g, '')                          // C1制御文字
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // Unicode双方向制御文字(RLO等・拡張子偽装対策)
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')               // ゼロ幅文字・BOM(見た目操作対策)
    .trim();

  // 先頭・末尾の連続するドット/スペースを整理
  // (先頭ドットによる隠しファイル化、Windowsでの末尾ドット・スペースの扱い問題を軽減)
  cleaned = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (!cleaned) {
    throw userError_('ファイル名が不正です。');
  }

  cleaned = guardReservedDeviceName_(cleaned);

  cleaned = truncateSafely_(cleaned, FILE_NAME_MAX_LENGTH);
  // 切り詰めにより末尾がドット/スペースになりうるため再度整理
  cleaned = cleaned.replace(/[.\s]+$/, '');

  if (!cleaned) {
    throw userError_('ファイル名が不正です。');
  }

  return cleaned;
}

/**
 * Windows予約デバイス名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)対策。
 * sanitizeFileName_ 呼び出し前に既に NFKC 正規化されている前提のため、
 * 全角文字(ＣＯＮ 等)による偽装もここで検出できる。
 * sanitizeForSheet_ と同様、「特定のパターンに一致したら安全な形へ変換する」
 * という単一責務のガード関数として独立させている。
 */
function guardReservedDeviceName_(fileName) {
  var RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  return RESERVED_DEVICE_NAMES.test(fileName) ? '_' + fileName : fileName;
}

/**
 * サロゲートペア(絵文字等)を途中で分断しない安全な文字列切り詰め。
 * 通常の substring(0, maxLen) は、maxLen の位置がサロゲートペアの
 * 境界と一致しない場合に文字を壊してしまう(不正なコードユニットが残る)ため、
 * その場合は境界を1文字分手前にずらす。
 */
function truncateSafely_(str, maxLen) {
  if (str.length <= maxLen) {
    return str;
  }
  var cut = maxLen;
  var code = str.charCodeAt(cut - 1);
  // 切り詰め位置の直前が高位サロゲート(U+D800-DBFF)の場合、そのままだと
  // 対応する低位サロゲートが失われて文字が壊れるため、その1文字も含めて切り詰める
  if (code >= 0xd800 && code <= 0xdbff) {
    cut = cut - 1;
  }
  return str.substring(0, cut);
}

/**
 * 管理用スプレッドシートのセルに書き込む文字列を「数式インジェクション(CSVインジェクション)」から保護する。
 * 拡張子/形式の制限を撤廃したことで fileName・mimeType には任意の文字列が入り得るため、
 * = / + / - / @ で始まる値をそのままセルに書き込むと、シートを開いた際にGoogle Sheetsが
 * これを数式として評価してしまう(外部URLへの自動アクセス等につながる恐れがある)。
 * 先頭にアポストロフィを付与することで、Sheets側に「これは文字列である」ことを明示させ、
 * 数式として評価されないようにする。
 * (アポストロフィはSheetsの書式指定として扱われ、getValues()で読み出した際の文字列値には含まれない)
 *
 * 呼び出し元(uploadFile)では常に検証済みの文字列を渡すため、null/undefined は考慮しない。
 */
function sanitizeForSheet_(str) {
  // 念のため制御文字(タブ・改行等)も除去しておく
  str = str.replace(/[\x00-\x1f]/g, '');
  return /^[=+\-@]/.test(str) ? "'" + str : str;
}

/**
 * base64文字列(パディング "=" を含む)からデコード後のバイト数を見積もる。
 * 末尾のパディングを考慮しないと実際のバイト数より大きく見積もってしまうため、
 * その分を差し引いて正確な値に近づけている。
 */
function estimateBase64ByteSize_(rawBase64) {
  var padding = (rawBase64.match(/=+$/) || [''])[0].length;
  return Math.floor(rawBase64.length * 3 / 4) - padding;
}

// ==== 画面描画・ファイル配信 ====

/**
 * ダウンロード情報ページ(token指定・action未指定時)
 */
function showDownloadPage_(token) {
  var record = getFileByToken_(token);

  if (!record) {
    return renderDownloadPage_('notfound');
  }
  if (isExpired_(record.expiresAt)) {
    return renderDownloadPage_('expired');
  }
  return renderDownloadPage_('ok', {
    fileName: record.fileName,
    token: token,
    expiresAt: formatDateTime_(record.expiresAt),
    // GAS の Web アプリは script.googleusercontent.com 上の iframe 経由で配信されるため、
    // ダウンロードリンクを相対URL(例: "?token=...")のままにすると、<base target="_top">で
    // トップフレームへ遷移させても遷移先が iframe 側のオリジンを基準に解決されてしまい、
    // 本来の doGet(exec URL)に届かずダウンロードが失敗する。そのため常に絶対URLを渡す。
    webAppUrl: ScriptApp.getService().getUrl()
  });
}

/**
 * 実ファイル配信(token指定・action=download)
 *
 * 【重要】Apps Script の doGet は HtmlOutput または TextOutput 以外の値を返せない仕様のため、
 * Blob を直接 return することはできない(実行すると「返された値はサポートされている
 * 戻り値の型ではありませんでした」というエラーになる)。そのため、ファイル本体を
 * base64化して Serve.html に埋め込み、クライアント側の JavaScript で Blob に変換して
 * ダウンロードを発火させる方式を取っている。
 *
 * ファイル形式を制限していない代わりに、Serve.html 側で Blob の Content-Type を必ず
 * application/octet-stream に強制している。これにより、たとえ HTML/SVG/JS 等の
 * アクティブコンテンツがアップロードされていても、ブラウザ上で実行・レンダリングされず
 * 「ダウンロードのみ」となる(実行するかどうかはダウンロードした本人の判断に委ねられる)。
 */
function serveFile_(token) {
  var record = getFileByToken_(token);

  if (!record || isExpired_(record.expiresAt)) {
    return renderDownloadPage_(record ? 'expired' : 'notfound');
  }

  var bytes;
  try {
    // ファイルの取得(Drive上に実体が存在するか)と、Blob化・バイト列取得の両方を
    // 同じtry/catchで保護する。ファイルが破損している、直前に削除された等の
    // 予期しない例外がここで発生しても doGet まで無防備に伝播させず、
    // 一律「notfound」として自前のエラー画面を返す。
    var file = DriveApp.getFileById(record.fileId);
    bytes = file.getBlob().getBytes();
  } catch (err) {
    return renderDownloadPage_('notfound');
  }

  // base64化するとサイズは約4/3倍になる(MAX_FILE_SIZE=20MBなら最大約27MB相当)。
  // HtmlOutput のペイロードサイズには実務上の上限があるため、MAX_FILE_SIZE を
  // 大きく変更する場合はダウンロードが正常に完了するか事前に確認すること。
  var base64Data = Utilities.base64Encode(bytes);
  var template = HtmlService.createTemplateFromFile('Serve');
  template.fileName = record.fileName;
  template.base64Data = base64Data;
  return template.evaluate().setTitle('ダウンロード中');
}

/**
 * Download.html を指定ステータスで描画する共通ヘルパー。
 * fields に渡したプロパティはそのままテンプレート変数として展開される。
 */
function renderDownloadPage_(status, fields) {
  var template = HtmlService.createTemplateFromFile('Download');
  template.status = status;
  for (var key in fields) {
    template[key] = fields[key];
  }
  return template.evaluate().setTitle('ファイルダウンロード');
}

// ==== 期限切れファイルの自動削除(時間主導型トリガーから実行) ====

/**
 * 期限切れファイルを削除する。時間主導型トリガー(setupTrigger が登録)からのみ
 * 呼び出される想定の管理用関数。
 *
 * セキュリティ上の注意: 末尾のアンダースコアは単なる命名規則ではなく、Apps Script の
 * 仕様上 google.script.run からのクライアント呼び出しを遮断する効果を持つ。この関数は
 * デプロイ設定上「オーナー権限で実行」されるため、アンダースコアを外して公開してしまうと
 * 匿名の第三者がこの関数を任意のタイミングで実行できてしまう(最小権限の原則違反)。
 * 今後この関数を分割・追加する場合も、クライアントに公開する意図がない限り
 * 末尾に "_" を付けること。
 *
 * 排他制御について: Drive/Sheetsの応答遅延等により前回の実行が15分を超えて
 * 完了していない状態で次のトリガーが起動すると、同じ行を対象に削除処理が
 * 二重に走る可能性がある(実害は例外がcatchされる程度だが、無駄なAPI呼び出しや
 * ログの混乱を招く)。これを避けるため uploadFile と同じスクリプト全体のロックを
 * 使って多重実行を防止する。ロックが取得できない場合(＝前回の実行がまだ
 * 進行中、またはuploadFileが実行中)は、最大 DELETE_LOCK_WAIT_TIMEOUT_MS(短時間)
 * だけ待って、それでも取得できなければ諦めて何もせず終了する(＝待ち続けて
 * トリガーの実行時間を浪費することはしない)。取りこぼした期限切れファイルは
 * 次回のトリガー(15分後)で処理されるため、安全側に倒した設計となる。
 */
function deleteExpiredFiles_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(DELETE_LOCK_WAIT_TIMEOUT_MS)) {
    // 既に他の実行(前回のdeleteExpiredFiles_、またはuploadFile)がロックを
    // 保持している。無理に待たず、今回はスキップして次回トリガーに委ねる。
    console.log('deleteExpiredFiles_: ロック取得に失敗したためスキップします(次回トリガーで再試行)。');
    return;
  }

  try {
    var sheet = getOrCreateSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < DATA_START_ROW) {
      return; // データ行なし
    }

    var numDataRows = lastRow - HEADER_ROW;
    // 全列をまとめて1回で読み込む。期限切れ行の fileId を行ごとに個別取得すると
    // 同時に多数の行が期限切れになった際に Sheets API 呼び出しが行数分発生してしまうため、
    // ここでまとめて読み込み、以降はメモリ上の値だけで判定・削除を行う。
    var rows = sheet.getRange(DATA_START_ROW, COL_TOKEN, numDataRows, COLUMN_COUNT).getValues();
    var now = new Date();

    // 下から走査して行削除時のインデックスずれを防ぐ
    for (var i = numDataRows - 1; i >= 0; i--) {
      var expiresAt = new Date(rows[i][COL_EXPIRES_AT - 1]);

      if (isExpired_(expiresAt, now)) {
        var rowIndex = i + DATA_START_ROW; // シート上の実際の行番号
        var fileId = rows[i][COL_FILE_ID - 1];
        removeFilePermanently_(fileId);
        sheet.deleteRow(rowIndex);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * ファイルを完全削除する。Drive詳細サービス(Drive API v2)が有効な場合は
 * ゴミ箱を経由せず完全削除し、無効/失敗時のみゴミ箱への移動にフォールバックする。
 * 詳細サービスの有効化方法は README.md を参照。
 */
function removeFilePermanently_(fileId) {
  try {
    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.remove) {
      Drive.Files.remove(fileId);
      return;
    }
  } catch (e) {
    // 詳細サービス未有効 or 対象ファイルが既に存在しない等 → ゴミ箱へフォールバック
  }
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (e2) {
    // ファイルが既に存在しない場合はスキップ
  }
}

/**
 * トリガーのセットアップ。Apps Script エディタの関数選択プルダウンで "setupTrigger" を
 * 選んで手動で一度だけ実行する(README参照)。15分ごとに deleteExpiredFiles_ を実行し、
 * 期限切れ後にファイル実体が残る時間を最短化する。
 *
 * セキュリティ上の注意: この関数は "_" を付けていないため、理論上は google.script.run
 * からも呼び出せてしまう。そのため冒頭で isAuthorizedOwner_() により「実行者がこの
 * スクリプトのオーナー本人かどうか」を検証し、オーナー以外(匿名の第三者を含む)からの
 * 呼び出しは例外を投げて拒否する。
 */
function setupTrigger() {
  if (!isAuthorizedOwner_()) {
    throw new Error('この操作はスクリプトのオーナーのみ実行できます。');
  }

  // 既存の同名トリガーを削除してから再作成(重複防止)
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === DELETE_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(DELETE_TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(DELETE_TRIGGER_INTERVAL_MINUTES)
    .create();
}

/**
 * 実行者がこのスクリプトのオーナー本人かどうかを判定する。
 *
 * Session.getActiveUser().getEmail() で「今この関数を呼んでいる人」のメールアドレスを取得し、
 * ScriptApp.getScriptId() が指すスクリプトファイル自体のDrive上のオーナーと比較する。
 * (このプロジェクトは既に DriveApp を使用しているため、追加の権限承認は発生しない)
 *
 * 注意点:
 *  - Session.getActiveUser().getEmail() は、ドメイン設定等により空文字を返す場合がある。
 *    その場合は「本人と確認できない」としてフェイルクローズ(拒否)する。
 *  - エディタから直接実行した場合は、実行者=あなた自身のアカウントが active user になるため、
 *    通常はオーナー本人であれば問題なく true が返る。
 */
function isAuthorizedOwner_() {
  var activeEmail = Session.getActiveUser().getEmail();
  if (!activeEmail) {
    return false;
  }
  try {
    var ownerEmail = DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail();
    return activeEmail === ownerEmail;
  } catch (e) {
    // オーナー情報が取得できない場合も安全側に倒して拒否する
    return false;
  }
}

// ==== ユーティリティ ====

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
 * showDownloadPage_ / serveFile_ / deleteExpiredFiles_ の3箇所で全く同じ
 * 比較が必要になるため、判定基準を一箇所に集約している。
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

function generateToken_() {
  // UUID v4(ハイフン除去で32文字の16進数、約122ビットのランダム性)は
  // 推測不可能なURLトークンとして十分な強度を持つ。
  return Utilities.getUuid().replace(/-/g, '');
}

function getOrCreateFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // フォルダが見つからない場合は再作成
    }
  }

  var folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss;

  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      ss = null;
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    props.setProperty('SHEET_ID', ss.getId());
  }

  var sheet = ss.getSheetByName('DB');
  if (!sheet) {
    // 新規作成直後のスプレッドシートには既定シートが1枚だけ存在するので、それをリネームして使う
    sheet = ss.getSheets()[0];
    sheet.setName('DB');
  }

  if (sheet.getLastRow() === 0) {
    // 列順は COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE, COL_EXPIRES_AT と一致させる
    sheet.appendRow(SHEET_HEADERS);
  }

  return sheet;
}

/**
 * token に一致する行を TextFinder で検索する。シート全件を読み込まずに検索できるため、
 * 登録件数が増えても性能が悪化しにくい。
 */
function getFileByToken_(token) {
  var sheet = getOrCreateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return null;
  }

  var found = sheet.getRange(DATA_START_ROW, COL_TOKEN, lastRow - HEADER_ROW, 1)
    .createTextFinder(token)
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  if (!found) {
    return null;
  }

  var rowIndex = found.getRow();
  var row = sheet.getRange(rowIndex, COL_TOKEN, 1, COLUMN_COUNT).getValues()[0];

  return {
    token: row[COL_TOKEN - 1],
    fileId: row[COL_FILE_ID - 1],
    fileName: row[COL_FILE_NAME - 1],
    mimeType: row[COL_MIME_TYPE - 1],
    expiresAt: new Date(row[COL_EXPIRES_AT - 1])
  };
}

/**
 * 入力検証・サニタイズ関連の関数群。
 * このファイルの関数はいずれも「受け取った値が安全か検証する/安全な形へ変換する」
 * という単一の関心事を持つ。ルーティングを担う Router.gs や、実際にアップロード処理を
 * 行う UploadService.gs とは役割が異なるため、明示的にファイルを分けている。
 */

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
  // これにより全角スラッシュ(/)によるパス区切り文字フィルタの回避や、
  // 全角文字(CON 等)によるWindows予約デバイス名の偽装をあわせて検出できるようにする。
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
 * 全角文字(CON 等)による偽装もここで検出できる。
 * 「特定のパターンに一致したら安全な形へ変換する」という単一責務のガード関数として独立させている。
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

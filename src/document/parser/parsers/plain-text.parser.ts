/**
 * 将 TXT / MD 解析为文本。
 *
 * 不做结构转换：按 UTF-8 原样读出，后续由调用方直接当作 Markdown/纯文本使用。
 *
 * 注意：固定按 UTF-8 解码，不做编码探测；GBK/GB18030 编码的 TXT 会出现乱码，
 * 需要在入库前自行转码。
 */
export function parsePlainText(buffer: Buffer): string {
  return buffer.toString('utf8');
}

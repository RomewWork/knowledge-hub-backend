import { ValueTransformer } from 'typeorm';

/**
 * Postgres BIGINT ↔ JS string 转换器。
 *
 * 雪花 ID（如 1000000000000000001）远超 Number.MAX_SAFE_INTEGER（2^53-1），
 * 一旦被转成 number 就会丢精度，导致查不到记录或前端 ID 尾数变成 0。
 * 因此 entity 里所有 bigint 主键/外键都必须：字段类型写 string + 挂本 transformer。
 *
 * 注意：
 * - from 统一返回 string（pg 驱动默认也把 int8 当 string，这里再兜底一次）；
 * - to 原样交给驱动，TypeORM 会把 string 按 bigint 写入；
 * - 不要在 VO/DTO 或 JSON 序列化时再 Number()，否则前功尽弃。
 */
export const bigintTransformer: ValueTransformer = {
  to: (v) => v, // 写入：原样交给驱动
  from: (v) => (v == null ? v : String(v)), // 读出：统一转成 string
};

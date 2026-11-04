import snowflakeIdExports from 'snowflake-id';

/**
 * 全局唯一的雪花 ID 生成器（每个进程一个实例）。
 *
 * 组成：毫秒时间戳（相对 offset 的差值）+ 10 位机器号 + 12 位毫秒内序列。
 * - mid（workerId）：取环境变量 SNOWFLAKE_MACHINE_ID，0–1022，默认 1；
 *   注意 .env 里写的是 SNOWFLAKE_WORKER_ID，两者名字不一致，多实例部署前必须统一，
 *   并保证每个实例的 mid 唯一，否则不同进程可能生成相同 ID。
 * - offset：纪元偏移（毫秒），默认 1704067200000（2024-01-01T00:00:00Z），
 *   会从当前时间中减去，用来缩短 ID 长度；上线后不要再改，否则可能和历史 ID 冲突。
 *
 * 并发：generate() 是同步的，同一进程内靠 12 位序列号保证同毫秒不重复
 * （单毫秒最多 4096 个，超出会自旋等到下一毫秒）；跨进程/跨机器只靠 mid 区分。
 */
// Node 的 ESM→CJS 互操作会把整个 module.exports 当成 default 导出，
// 所以这里拿到的是 { default: SnowflakeId }，必须再取一次 .default。
const snowflake = new snowflakeIdExports.default({
  mid: Number(process.env.SNOWFLAKE_MACHINE_ID ?? 1),
  offset: Number(process.env.SNOWFLAKE_OFFSET ?? 1704067200000),
});

/**
 * 生成雪花 ID，返回 string。
 *
 * 之所以不返回 number：64 位整数超出 JS 安全整数范围（2^53-1），
 * 直接转 number 会丢精度；string 可直接写入 Postgres BIGINT，也可安全传给前端。
 */
export function nextSnowflakeId(): string {
  return snowflake.generate();
}

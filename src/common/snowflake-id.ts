import snowflakeIdExports from 'snowflake-id';

// Node 的 ESM→CJS 互操作会把整个 module.exports 当成 default 导出，
// 所以这里拿到的是 { default: SnowflakeId }，必须再取一次 .default。
const snowflake = new snowflakeIdExports.default({
  mid: Number(process.env.SNOWFLAKE_MACHINE_ID ?? 1),
  offset: Number(process.env.SNOWFLAKE_OFFSET ?? 1704067200000),
});

/** 生成雪花 ID（string），对应 Java long / Postgres BIGINT */
export function nextSnowflakeId(): string {
  return snowflake.generate();
}

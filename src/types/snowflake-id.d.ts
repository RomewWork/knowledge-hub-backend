declare module 'snowflake-id' {
  interface SnowflakeIdOptions {
    /** 机器 ID（0–1023），分布式部署时各实例需唯一 */
    mid?: number;
    /** 纪元偏移（毫秒），会从当前时间中减去 */
    offset?: number;
  }

  class SnowflakeId {
    constructor(options?: SnowflakeIdOptions);
    /** 生成雪花 ID 字符串（JS number 无法安全表示 64 位整数） */
    generate(): string;
  }

  // 该包只发布 CJS（main = lib/snowflake-id.js），且是 babel 转译产物：
  //   module.exports = { __esModule: true, default: SnowflakeId }
  // 而不是 module.exports = SnowflakeId。
  const _exports: { default: typeof SnowflakeId };
  export = _exports;
}

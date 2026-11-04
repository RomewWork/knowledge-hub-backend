/**
 * 用户对外展示（不含 password）
 *
 * - 接口出参统一走这个 VO，实体里的 password、deleted、emailVerified 等内部字段不外泄
 * - roleCodes 不是用户表字段，由 UserService 每次现查角色表补齐（因此列表接口会有一人一次的额外查询）
 * - 时间字段直接给 Date，序列化后为 ISO 字符串；lastLoginAt 可能为 null
 */
export class UserVO {
  id: string;
  username: string;
  email?: string | null;
  realName?: string | null;
  avatar?: string | null;
  /** 1 启用；0 禁用或注册后未激活 */
  status: number;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roleCodes: string[];
}

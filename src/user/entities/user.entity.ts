import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 用户（PostgreSQL kh_user）。
 *
 * 注意：id 是雪花 ID，用 string 承载；username 的「未删除唯一」由库里的部分唯一索引保证，
 * 业务层仍需先查重。password 存的是 bcrypt 哈希，绝不能返回给前端。
 */
@Entity('kh_user')
export class UserEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 登录用户名，未删除记录内唯一 */
  @Column({ type: 'varchar', length: 50 })
  username: string;

  /** bcrypt 哈希，不是明文密码 */
  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  email?: string | null;

  /** 真实姓名/显示名 */
  @Column({ name: 'real_name', type: 'varchar', length: 50, nullable: true })
  realName?: string | null;

  /** 头像 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string | null;

  /** 0 未验证 1 已验证 */
  @Column({ name: 'email_verified', type: 'smallint', default: 1 })
  emailVerified: number;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** 软删除标记：删除只置 true，查询需自行过滤 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}

import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 角色（PostgreSQL kh_role）。
 *
 * 注意：鉴权按 roleCode 判断（如 ROLE_ADMIN / ROLE_REVIEWER），不要用可改的 roleName；
 * roleCode 在库里唯一。本表没有软删除字段。
 */
@Entity('kh_role')
export class RoleEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 角色名称，仅用于展示 */
  @Column({ name: 'role_name', type: 'varchar', length: 50 })
  roleName: string;

  /** 角色编码，唯一，鉴权时使用 */
  @Column({ name: 'role_code', type: 'varchar', length: 50, unique: true })
  roleCode: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description?: string | null;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;
}

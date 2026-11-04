import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 角色-权限关联（表 kh_role_permission）：一个角色可挂多个权限，多对多中间表。
 *
 * 注意：库表对 (role_id, permission_id) 建了唯一约束；删除权限前需确认没有角色引用。
 */
@Entity('kh_role_permission')
export class RolePermissionEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'role_id', type: 'bigint', transformer: bigintTransformer })
  roleId: string;

  @Column({
    name: 'permission_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  permissionId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

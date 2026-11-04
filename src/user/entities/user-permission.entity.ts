import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 用户直授权限（表 kh_user_permission）：在角色权限之外，给单个用户额外授予权限。
 *
 * 注意：库表对 (user_id, permission_id) 建了唯一约束，重复分配前先查重；
 * 最终权限 = 用户直授 ∪ 其所有角色的权限（管理员角色还会追加内置操作权限）。
 */
@Entity('kh_user_permission')
export class UserPermissionEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  @Column({
    name: 'permission_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  permissionId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

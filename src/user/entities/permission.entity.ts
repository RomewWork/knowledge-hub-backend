import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 权限（PostgreSQL kh_permission）：菜单 / 按钮 / 接口统一建模。
 *
 * 注意：parentId 自关联成树，'0' 为根；菜单类型用 menuUrl，接口类型用 apiUrl + method；
 * permissionCode 唯一且在运行时参与鉴权。查询默认要过滤 deleted = false。
 */
@Entity('kh_permission')
export class PermissionEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 父权限 ID，'0' 表示根节点 */
  @Column({
    name: 'parent_id',
    type: 'bigint',
    default: '0',
    transformer: bigintTransformer,
  })
  parentId: string;

  @Column({ name: 'permission_name', type: 'varchar', length: 50 })
  permissionName: string;

  /** 权限编码，唯一，运行时按它判断（如 document:edit） */
  @Column({ name: 'permission_code', type: 'varchar', length: 100, unique: true })
  permissionCode: string;

  /** 1 菜单 2 按钮 3 接口 */
  @Column({ name: 'permission_type', type: 'smallint' })
  permissionType: number;

  /** 菜单路由，permissionType=1 时使用 */
  @Column({ name: 'menu_url', type: 'varchar', length: 200, nullable: true })
  menuUrl?: string | null;

  /** 接口路径，permissionType=3 时使用 */
  @Column({ name: 'api_url', type: 'varchar', length: 500, nullable: true })
  apiUrl?: string | null;

  /** HTTP 方法，配合 apiUrl 做接口级鉴权 */
  @Column({ type: 'varchar', length: 10, nullable: true })
  method?: string | null;

  /** 菜单图标标识（前端图标库的组件名） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon?: string | null;

  /** 同级排序值，升序展示 */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** 软删除标记：删除只置 true，查询需自行过滤 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}

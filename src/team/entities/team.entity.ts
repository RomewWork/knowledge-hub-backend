import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 团队（表 kh_team），通过 parentId 自关联组成树。
 *
 * 注意：查询默认要带 deleted = false；parentId 为 '0' 表示根团队。
 */
@Entity('kh_team')
export class TeamEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'team_name', type: 'varchar', length: 100 })
  teamName: string;

  /** 团队编码，可选，用于外部系统对接 */
  @Column({ name: 'team_code', type: 'varchar', length: 50, nullable: true })
  teamCode?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string | null;

  /** 负责人用户 ID（kh_user.id） */
  @Column({
    name: 'leader_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  leaderId?: string | null;

  /** 上级团队 ID，'0' 表示根团队 */
  @Column({
    name: 'parent_id',
    type: 'bigint',
    default: '0',
    transformer: bigintTransformer,
  })
  parentId: string;

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

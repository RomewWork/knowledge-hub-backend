import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 团队成员关系（表 kh_team_member）：记录用户属于哪个团队及团队内角色。
 *
 * 注意：库表对 (team_id, user_id) 建了唯一约束，同一用户在同一团队只会有一行；
 * 目前业务代码只写入 member，leader 角色由初始化数据/人工维护。
 */
@Entity('kh_team_member')
export class TeamMemberEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'team_id', type: 'bigint', transformer: bigintTransformer })
  teamId: string;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 团队内角色：leader / member，默认 member */
  @Column({ name: 'member_role', type: 'varchar', length: 20, default: 'member' })
  memberRole: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

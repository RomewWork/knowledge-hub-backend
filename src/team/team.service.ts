import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { TeamEntity } from './entities/team.entity.js';
import { TeamMemberEntity } from './entities/team-member.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { CreateTeamDto, QueryTeamDto, UpdateTeamDto } from './dto/team.dto.js';

/**
 * 团队管理服务（含团队-成员关系）
 *
 * 职责：团队的增删改查、树形结构组装、成员关系的增删查。
 *
 * 关键依赖：TypeORM 仓库 TeamEntity / TeamMemberEntity / UserEntity，雪花 ID 生成器。
 *
 * 坑与取舍：
 * 1. 团队是一棵树，parentId = '0'（或空）表示根节点；只靠约定字符串，没有独立的根标记。
 * 2. 删除是「软删团队 + 物理删成员关系」的组合：团队保留用于审计追溯，成员关系直接 delete，
 *    所以删掉的团队无法通过数据还原找回成员，只能重新添加。
 * 3. 树是整表取出后在内存里递归拼的，团队量级小可以接受，量级变大需要换成闭包表或递归 SQL。
 */
@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TeamEntity)
    private readonly teamRepo: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity)
    private readonly memberRepo: Repository<TeamMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  /** 新建团队：parentId 缺省落到 '0' 即根团队，其余可选项都做空值兜底 */
  async create(dto: CreateTeamDto) {
    const team = this.teamRepo.create({
      id: nextSnowflakeId(),
      teamName: dto.teamName,
      teamCode: dto.teamCode ?? null,
      description: dto.description ?? null,
      leaderId: dto.leaderId ?? null,
      parentId: dto.parentId ?? '0',
      sort: dto.sort ?? 0,
      status: dto.status ?? 1,
    });
    return this.teamRepo.save(team);
  }

  /**
   * 更新团队：按字段是否传入做增量更新（未传的保持原值）。
   *
   * 只挡了「父团队 = 自己」这一层自环，更深的循环（A 挂到自己的孙节点下）没有校验，
   * 调用方需要自己保证层级合法。
   */
  async update(id: string, dto: UpdateTeamDto) {
    const team = await this.findByIdOrThrow(id);
    if (dto.teamName !== undefined) team.teamName = dto.teamName;
    if (dto.teamCode !== undefined) team.teamCode = dto.teamCode;
    if (dto.description !== undefined) team.description = dto.description;
    if (dto.leaderId !== undefined) team.leaderId = dto.leaderId;
    if (dto.parentId !== undefined) {
      if (dto.parentId === id) {
        throw new BadRequestException('父团队不能是自己');
      }
      team.parentId = dto.parentId;
    }
    if (dto.sort !== undefined) team.sort = dto.sort;
    if (dto.status !== undefined) team.status = dto.status;
    return this.teamRepo.save(team);
  }

  private async findByIdOrThrow(id: string) {
    const team = await this.teamRepo.findOne({
      where: { id, deleted: false },
    });
    if (!team) throw new NotFoundException('团队不存在');
    return team;
  }

  /**
   * 删除团队：先确认没有存活的子团队，再软删团队本身并物理清掉成员关系。
   *
   * 之所以要求「无子团队」，是因为软删父节点后子团队会变成孤儿节点，
   * getTree 从根遍历时就再也带不出它们，等于数据被静默藏起来。
   */
  async delete(id: string) {
    const team = await this.findByIdOrThrow(id);
    const childCount = await this.teamRepo.count({
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException('存在子团队，无法删除');
    }
    team.deleted = true;
    await this.teamRepo.save(team);
    await this.memberRepo.delete({ teamId: id });
  }

  /** 详情额外算一次成员数，省掉前端再发一次成员列表请求 */
  async getDetail(id: string) {
    const team = await this.findByIdOrThrow(id);
    const memberCount = await this.memberRepo.count({ where: { teamId: id } });
    return { ...team, memberCount };
  }

  /** 分页：关键词同时匹配团队名与团队编码，排序按 sort 升序、创建时间倒序 */
  async page(query: QueryTeamDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.teamRepo.createQueryBuilder('t').where('t.deleted = false');
    if (query.keyword?.trim()) {
      qb.andWhere('(t.team_name ILIKE :kw OR t.team_code ILIKE :kw)', {
        kw: `%${query.keyword.trim()}%`,
      });
    }
    if (query.status !== undefined) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    qb.orderBy('t.sort', 'ASC')
      .addOrderBy('t.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /**
   * 取团队树：一次查出所有启用且未删的团队，在内存里按 parentId 递归挂子节点。
   *
   * rootOnly=true 时只给根节点的扁平列表（children 置空），用于下拉框这类只选顶层或懒加载的场合。
   * 注意根判定为 parentId 为空或 '0'，两种写法都存在，判断时不能只比 '0'。
   */
  async getTree(rootOnly = false) {
    const teams = await this.teamRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    const build = (parentId: string): unknown[] =>
      teams
        .filter((t) => t.parentId === parentId)
        .map((t) => ({
          ...t,
          children: rootOnly ? [] : build(t.id),
        }));
    const rootNodes = teams.filter((t) => !t.parentId || t.parentId === '0');
    return rootOnly
      ? rootNodes
      : rootNodes.map((t) => ({
          ...t,
          children: build(t.id),
        }));
  }

  /**
   * 批量加成员：先整体校验用户都存在，再逐个 filter 掉已存在的，保证重复调用幂等。
   *
   * 之所以一个个查再插而不是直接批量 insert，是为了在成员关系表没有唯一约束时
   * 也能避免产生重复行；代价是成员多时会有 N 次查询。
   *
   * 注意：入参里若有重复 userId，In 查询会去重，数量对不上会误报「部分用户不存在」，
   * 所以调用前最好自己先去重。
   */
  async addMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    const users = await this.userRepo.find({
      where: { id: In(userIds), deleted: false },
    });
    if (users.length !== userIds.length) {
      throw new NotFoundException('部分用户不存在');
    }
    for (const userId of userIds) {
      const exists = await this.memberRepo.findOne({ where: { teamId, userId } });
      if (exists) continue;
      await this.memberRepo.save(
        this.memberRepo.create({
          id: nextSnowflakeId(),
          teamId,
          userId,
          memberRole: 'member',
        }),
      );
    }
    return true;
  }
  /** 批量移除成员：按条件直接 delete，用户本来不在团队里也不会报错 */
  async removeMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    await this.memberRepo.delete({ teamId, userId: In(userIds) });
    return true;
  }

  /**
   * 成员列表：join 用户表拿名称并过滤已删用户，返回扁平字段而不是实体。
   *
   * 用 getRawMany 是因为 select 里做了列别名，前端需要的键名和表结构并不一致。
   */
  async listMembers(teamId: string) {
    await this.findByIdOrThrow(teamId);
    return this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(UserEntity, 'u', 'u.id = m.user_id')
      .where('m.team_id = :teamId', { teamId })
      .andWhere('u.deleted = false')
      .select([
        'm.user_id AS "userId"',
        'm.member_role AS "memberRole"',
        'u.username AS username',
        'u.real_name AS "realName"',
      ])
      .getRawMany();
  }
}

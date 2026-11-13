import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleCode } from '../common/constants/roles.js';
import { AuthUser } from '../auth/auth-user.interface.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UpdateProfileDto } from './dto/profile.dto.js';
import { UserVO } from './vo/user.vo.js';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { PermissionService } from './permission.service.js';
import { TeamService } from '../team/team.service.js';

/**
 * 用户服务：账号生命周期、登录凭据校验、角色绑定与个人统计
 *
 * - 依赖 4 个仓储：用户 / 角色 / 用户角色关联 / 文档；权限码由 PermissionService 汇总
 * - 登录成功后的 AuthUser 在这里组装，鉴权守卫直接用它的 roles、permissions
 *
 * 注意：
 * - 用户表查询一律显式带 deleted: false（角色表没有软删字段）；deleteUser 只是置位软删
 * - 密码只存 bcrypt 哈希（cost=10），任何出口（含 VO）都不返回 password
 * - replaceRoles 是先删后插的全量替换，不是增量追加，调用方需先保证入参合法
 */
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepo: Repository<DocumentEntity>,
    private readonly permissionService: PermissionService,
    private readonly teamService: TeamService,
  ) {}

  /**
   * 自助注册
   * - 用户名、邮箱（填了才校验）唯一性检查，冲突抛 409
   * - 密码 hash(pwd, 10) 入库；注册即自动绑定 ROLE_USER
   * - requireEmailVerification && 填了 email 时冻结账号：status=0、emailVerified=0，
   *   需要走邮箱激活才能登录；否则直接 status=1、emailVerified=1
   */
  async register(input: {
    username: string;
    password: string;
    email?: string;
    realName?: string;
    requireEmailVerification?: boolean;
  }): Promise<{ userId: string; emailVerificationRequired?: boolean }> {
    const exists = await this.findByUsername(input.username);
    if (exists) {
      throw new ConflictException('用户名已存在');
    }

    if (input.email) {
      const emailUsed = await this.findByEmail(input.email);
      if (emailUsed) throw new ConflictException('邮箱已被使用');
    }

    const userId = nextSnowflakeId();
    const needVerify = input.requireEmailVerification && !!input.email;
    const user = this.userRepo.create({
      id: userId,
      username: input.username,
      password: await hash(input.password, 10),
      email: input.email ?? null,
      realName: input.realName ?? null,
      status: needVerify ? 0 : 1,
      emailVerified: needVerify ? 0 : 1,
    });
    await this.userRepo.save(user);
    await this.assignRole(userId, RoleCode.USER);
    return { userId, emailVerificationRequired: needVerify };
  }

  /** 管理员创建用户 */
  async createUser(dto: CreateUserDto): Promise<string> {
    const exists = await this.findByUsername(dto.username);
    if (exists) {
      throw new ConflictException('用户名已存在');
    }

    const userId = nextSnowflakeId();
    const user = this.userRepo.create({
      id: userId,
      username: dto.username,
      password: await hash(dto.password, 10),
      email: dto.email ?? null,
      realName: dto.realName ?? null,
      avatar: dto.avatar ?? null,
      status: dto.status ?? 1,
      emailVerified: 1,
    });
    await this.userRepo.save(user);

    const roleCodes = dto.roleCodes?.length ? dto.roleCodes : [RoleCode.USER];
    await this.replaceRoles(userId, roleCodes);
    return userId;
  }

  /** 管理员更新用户资料（仅这些字段可改，密码与角色有独立接口） */
  async updateUser(userId: string, dto: UpdateUserDto): Promise<UserVO> {
    const user = await this.findByIdOrThrow(userId);
    if (dto.email !== undefined) user.email = dto.email;
    if (dto.realName !== undefined) user.realName = dto.realName;
    if (dto.avatar !== undefined) user.avatar = dto.avatar;
    if (dto.status !== undefined) user.status = dto.status;
    await this.userRepo.save(user);
    return this.toUserVO(user);
  }

  /** 软删用户：只置 deleted=true，历史文档与审计数据保留 */
  async deleteUser(userId: string): Promise<void> {
    const user = await this.findByIdOrThrow(userId);
    user.deleted = true;
    await this.userRepo.save(user);
  }

  /** 追加单个角色（幂等：已绑定则直接返回，不重复插入） */
  async assignRole(userId: string, roleCode: string): Promise<void> {
    const role = await this.roleRepo.findOne({ where: { roleCode } });
    if (!role) {
      throw new NotFoundException(`角色 ${roleCode} 不存在`);
    }
    const exists = await this.userRoleRepo.findOne({
      where: { userId, roleId: role.id },
    });
    if (exists) return;

    await this.userRoleRepo.save(
      this.userRoleRepo.create({
        id: nextSnowflakeId(),
        userId,
        roleId: role.id,
      }),
    );
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email, deleted: false } });
  }

  async findByUsername(username: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { username, deleted: false },
    });
  }

  /** 按 ID 取未删除用户，不存在抛 404（所有写操作的统一入口） */
  async findByIdOrThrow(userId: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({
      where: { id: userId, deleted: false },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  /** 用户已启用角色的 roleCode 列表（join 角色表，停用角色不计入） */
  async getRoleCodes(userId: string): Promise<string[]> {
    const rows = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('r.status = 1')
      .select('r.role_code', 'roleCode')
      .getRawMany<{ roleCode: string }>();
    return rows.map((r) => r.roleCode);
  }

  /** 实体转 VO：手动挑字段（因此不含 password），再补上角色码 */
  async toUserVO(user: UserEntity): Promise<UserVO> {
    const roleCodes = await this.getRoleCodes(user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      realName: user.realName,
      avatar: user.avatar,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roleCodes,
    };
  }

  /**
   * 管理端用户分页
   * - 固定 u.deleted = false；关键词同时模糊匹配用户名 / 真实姓名 / 邮箱
   * - 按角色筛选走 innerJoin，会过滤掉没有该角色的用户；排序按创建时间倒序
   * - 命中后逐条 toUserVO（每个用户一次角色查询，默认每页 20 条，开销可接受）
   */
  async pageUsers(query: QueryUserDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.userRepo.createQueryBuilder('u').where('u.deleted = false');

    if (query.keyword?.trim()) {
      const kw = `%${query.keyword.trim()}%`;
      qb.andWhere('(u.username ILIKE :kw OR u.real_name ILIKE :kw OR u.email ILIKE :kw)', { kw });
    }

    if (query.status !== undefined) {
      qb.andWhere('u.status = :status', { status: query.status });
    }

    if (query.roleCode) {
      qb.innerJoin(UserRoleEntity, 'ur', 'ur.user_id = u.id').innerJoin(
        RoleEntity,
        'r',
        'r.id = ur.role_id AND r.role_code = :roleCode',
        { roleCode: query.roleCode },
      );
    }

    qb.orderBy('u.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [users, total] = await qb.getManyAndCount();
    const items = await Promise.all(users.map((u) => this.toUserVO(u)));
    return { items, total, page, pageSize };
  }

  async getUserVO(userId: string): Promise<UserVO> {
    const user = await this.findByIdOrThrow(userId);
    return this.toUserVO(user);
  }

  async getUserRoleCodes(userId: string): Promise<string[]> {
    await this.findByIdOrThrow(userId);
    return this.getRoleCodes(userId);
  }

  /** 全量替换用户角色 */
  async replaceRoles(userId: string, roleCodes: string[]): Promise<string[]> {
    await this.findByIdOrThrow(userId);

    const roles = await this.roleRepo.find({
      where: { roleCode: In(roleCodes), status: 1 },
    });
    if (roles.length !== roleCodes.length) {
      const found = new Set(roles.map((r) => r.roleCode));
      const missing = roleCodes.filter((c) => !found.has(c));
      throw new NotFoundException(`角色不存在: ${missing.join(', ')}`);
    }

    // 全量替换：先清空旧关联再逐条插入；roles 已在上方按数量校验过存在性
    await this.userRoleRepo.delete({ userId });
    for (const role of roles) {
      await this.userRoleRepo.save(
        this.userRoleRepo.create({
          id: nextSnowflakeId(),
          userId,
          roleId: role.id,
        }),
      );
    }
    return roleCodes;
  }

  /**
   * 登录凭据校验，依次过四道闸门
   * 1. 用户不存在（含已软删）→ 401
   * 2. status != 1（被禁用）→ 401
   * 3. emailVerified === 0（注册后未激活）→ 401
   * 4. bcrypt 比对失败 → 401
   *
   * 坑：第 1、4 关统一用「用户名或密码错误」，避免通过错误文案枚举已存在的用户名；
   *     「账户已禁用 / 未激活」属于可信状态提示，只在账号确实存在时才会出现。
   */
  async validateCredentials(username: string, password: string): Promise<AuthUser> {
    const user = await this.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.status !== 1) {
      throw new UnauthorizedException('账户已禁用');
    }
    if (user.emailVerified === 0) {
      throw new UnauthorizedException('账户未激活，请先验证邮箱');
    }
    const ok = await compare(password, user.password);
    if (!ok) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const roles = await this.getRoleCodes(user.id);
    const permissions = await this.permissionService.getUserPermissionCodes(user.id);
    return this.toAuthUser(user, roles, permissions);
  }

  /** 组装注入 request.user 的登录态（JWT 载荷视图，不含密码） */
  async toAuthUser(user: UserEntity, roles: string[], permissions: string[]): Promise<AuthUser> {
    const teamIds = await this.teamService.listAccessibleTeamIds(user.id);
    return {
      userId: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      avatar: user.avatar,
      roles,
      permissions,
      teamIds: teamIds.map(String),
    };
  }

  /** 登录成功后刷新最近登录时间（只更新这一个字段） */
  async touchLastLogin(userId: string): Promise<void> {
    await this.userRepo.update(userId, { lastLoginAt: new Date() });
  }

  /**
   * 按 userId 重建登录态（刷新 Token、GET /auth/me 等场景）
   * 与 validateCredentials 的区别：不再校验密码，但会重新判断是否被禁用，
   * 这样管理员停用账号后，已签发的 Token 在下次刷新时就失效。
   */
  async buildAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.findByIdOrThrow(userId);
    if (user.status !== 1) {
      throw new UnauthorizedException('账户已禁用');
    }
    const roles = await this.getRoleCodes(userId);
    const permissions = await this.permissionService.getUserPermissionCodes(userId);
    return this.toAuthUser(user, roles, permissions);
  }

  /** 按角色编码取用户 ID（只算启用且未删除用户），如按 ROLE_REVIEWER 找审核人 */
  async getUserIdsByRoleCode(roleCode: string): Promise<string[]> {
    const rows = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .innerJoin(UserEntity, 'u', 'u.id = ur.user_id')
      .where('r.role_code = :roleCode', { roleCode })
      .andWhere('u.deleted = false')
      .andWhere('u.status = 1')
      .select('u.id', 'userId')
      .addSelect('u.username', 'userName')
      .getRawMany<{ userId: string }>();
    return rows.map((r) => String(r.userId));
  }

  /** 启用中的角色列表，按角色名升序（供角色选择等场景复用） */
  async listAllRoles(): Promise<RoleEntity[]> {
    return this.roleRepo.find({
      where: { status: 1 },
      order: { roleName: 'ASC' },
    });
  }

  /** 当前用户自助修改资料（只动邮箱 / 姓名 / 头像，改不了状态和角色） */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserVO> {
    const user = await this.findByIdOrThrow(userId);
    if (dto.email !== undefined) user.email = dto.email;
    if (dto.realName !== undefined) user.realName = dto.realName;
    if (dto.avatar !== undefined) user.avatar = dto.avatar;
    await this.userRepo.save(user);
    return this.toUserVO(user);
  }

  /** 自助改密码：先 bcrypt 校验原密码（错则 400），再用新密码重新哈希 */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.findByIdOrThrow(userId);
    const ok = await compare(oldPassword, user.password);
    if (!ok) throw new BadRequestException('原密码错误');
    user.password = await hash(newPassword, 10);
    await this.userRepo.save(user);
  }

  /** 管理员重置密码：不校验原密码，直接覆盖为新哈希 */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const user = await this.findByIdOrThrow(userId);
    user.password = await hash(newPassword, 10);
    await this.userRepo.save(user);
  }

  /** 邮箱找回密码：按邮箱定位未删除用户，未注册抛 404，命中则覆盖密码 */
  async resetPasswordByEmail(email: string, newPassword: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user) throw new NotFoundException('该邮箱未注册');
    user.password = await hash(newPassword, 10);
    await this.userRepo.save(user);
  }

  /** 邮箱激活：幂等，已激活直接返回提示；首次激活同时解除 status=0 的冻结 */
  async activateEmail(userId: string): Promise<string> {
    const user = await this.findByIdOrThrow(userId);
    if (user.emailVerified === 1) return '账户已激活，请直接登录';
    user.emailVerified = 1;
    user.status = 1;
    await this.userRepo.save(user);
    return '账户激活成功，请登录';
  }

  /**
   * 个人主页统计：仅统计本人 authorId 且未删除的文档
   * 计数列在 SQL 里用 COALESCE 兜底 0（SUM 无行时为 NULL），返回前再 Number 转一次
   */
  async getUserStatistics(userId: string) {
    await this.findByIdOrThrow(userId);
    const documentCount = await this.documentRepo.count({
      where: {
        authorId: userId,
        deleted: false,
      },
    });
    const raw = await this.documentRepo
      .createQueryBuilder('d')
      .select('COALESCE(SUM(d.view_count), 0)', 'viewCount')
      .addSelect('COALESCE(SUM(d.like_count), 0)', 'likeCount')
      .addSelect('COALESCE(SUM(d.comment_count), 0)', 'commentCount')
      .where('d.author_id = :userId', { userId })
      .andWhere('d.deleted = false')
      .getRawOne<{ viewCount: string; likeCount: string; commentCount: string }>();
    return {
      documentCount,
      viewCount: Number(raw?.viewCount ?? 0),
      likeCount: Number(raw?.likeCount ?? 0),
      commentCount: Number(raw?.commentCount ?? 0),
    };
  }
}

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { ADMIN_OPERATION_PERMISSIONS, ADMIN_ROLES } from '../common/constants/permissions.js';
import { PermissionEntity } from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserPermissionEntity } from './entities/user-permission.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import {
  AssignPermissionIdsDto,
  CreatePermissionDto,
  QueryPermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto.js';

/**
 * 权限服务：权限树（菜单 / 按钮 / 接口）维护，以及角色-权限、用户-权限两种绑定
 *
 * - 权限是树结构：parentId = '0' 为根，排序按 sort、再按 createdAt
 * - 权限实体是软删（deleted 标记）；两张关联表（kh_role_permission / kh_user_permission）是物理删
 * - assignRolePermissions / assignUserPermissions 都是全量替换：先按归属 delete 再逐条 insert
 *
 * 注意：getUserPermissionCodes 是运行时鉴权的唯一数据来源，
 *      最终权限 = 直授权限 ∪ 角色继承权限 ∪（管理员固定追加 ADMIN_OPERATION_PERMISSIONS），
 *      每一路都必须过滤 status=1 且 deleted=false，否则停用权限会继续生效。
 */
@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(PermissionEntity)
    private readonly permRepo: Repository<PermissionEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermRepo: Repository<RolePermissionEntity>,
    @InjectRepository(UserPermissionEntity)
    private readonly userPermRepo: Repository<UserPermissionEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
  ) {}

  /** 全部启用且未删除的权限（扁平列表，前端可自行组树） */
  async listAll() {
    return this.permRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
  }

  /** 按 ID 取权限，不存在或已软删抛 404 */
  async getById(id: string) {
    const perm = await this.permRepo.findOne({
      where: { id, deleted: false },
    });

    if (!perm) throw new NotFoundException('权限不存在');
    return perm;
  }

  /** 直接子权限（只返回启用的），用于逐级懒加载 */
  async getChildren(parentId: string) {
    return this.permRepo.find({
      where: { parentId, deleted: false, status: 1 },
      order: { sort: 'ASC' },
    });
  }

  /** 新建权限：permissionCode 未删除范围内唯一，parentId 缺省挂到根 '0' */
  async create(dto: CreatePermissionDto) {
    const exists = await this.permRepo.findOne({
      where: { permissionCode: dto.permissionCode, deleted: false },
    });
    if (exists) throw new ConflictException('权限编码已存在');
    const perm = this.permRepo.create({
      id: nextSnowflakeId(),
      parentId: dto.parentId ?? '0',
      permissionName: dto.permissionName,
      permissionCode: dto.permissionCode,
      permissionType: dto.permissionType,
      menuUrl: dto.menuUrl ?? null,
      apiUrl: dto.apiUrl ?? null,
      method: dto.method ?? null,
      icon: dto.icon ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? 1,
    });
    return this.permRepo.save(perm);
  }

  /**
   * 更新权限：改编码时重新做唯一性校验；改 parentId 时只拦「父级是自己」，
   * 不做环路检测 —— 把父级改成自己的子孙后，这条分支会从根节点 '0' 的树上整体消失
   */
  async update(id: string, dto: UpdatePermissionDto) {
    const perm = await this.getById(id);
    if (dto.permissionCode && dto.permissionCode !== perm.permissionCode) {
      const exists = await this.permRepo.findOne({
        where: { permissionCode: dto.permissionCode, deleted: false },
      });
      if (exists) throw new ConflictException('权限编码已存在');
      perm.permissionCode = dto.permissionCode;
    }

    if (dto.permissionName !== undefined) perm.permissionName = dto.permissionName;
    if (dto.permissionType !== undefined) perm.permissionType = dto.permissionType;
    if (dto.parentId !== undefined) {
      if (dto.parentId === id) {
        throw new BadRequestException('父权限不能是自己');
      }
      perm.parentId = dto.parentId;
    }
    if (dto.menuUrl !== undefined) perm.menuUrl = dto.menuUrl;
    if (dto.apiUrl !== undefined) perm.apiUrl = dto.apiUrl;
    if (dto.method !== undefined) perm.method = dto.method;
    if (dto.icon !== undefined) perm.icon = dto.icon;
    if (dto.sort !== undefined) perm.sort = dto.sort;
    if (dto.status !== undefined) perm.status = dto.status;
    return this.permRepo.save(perm);
  }

  /**
   * 删除权限（软删，只置 deleted=true）
   * 三重保护，任一命中即 400：
   * 1. 还有未删除的子权限
   * 2. 仍被角色绑定（kh_role_permission）
   * 3. 仍被用户直授绑定（kh_user_permission）
   * 据此不会产生孤儿关联，但删除前要先把绑定解开
   */
  async delete(id: string) {
    const perm = await this.getById(id);
    const childCount = await this.permRepo.count({
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException('存在子权限，无法删除');
    }
    const roleBound = await this.rolePermRepo.count({
      where: { permissionId: id },
    });
    const userBound = await this.userPermRepo.count({
      where: { permissionId: id },
    });
    if (roleBound > 0 || userBound > 0) {
      throw new BadRequestException('权限仍有关联角色或用户，无法删除');
    }
    perm.deleted = true;
    await this.permRepo.save(perm);
  }

  /** 权限分页：固定 deleted=false，keyword 模糊匹配名称 / 编码 */
  async page(query: QueryPermissionDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.permRepo.createQueryBuilder('p').where('p.deleted = false');
    if (query.keyword?.trim()) {
      qb.andWhere('(p.permission_name ILIKE :kw OR p.permission_code ILIKE :kw)', {
        kw: `%${query.keyword.trim()}%`,
      });
    }
    qb.orderBy('p.sort', 'ASC')
      .addOrderBy('p.created_at', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /**
   * 组装权限树：一次性取出全部启用权限，在内存里按 parentId 递归挂 children
   * 数据量小（权限表通常几十到几百行），不做逐层查库
   */
  async getTree() {
    const perms = await this.permRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });

    const build = (parentId: string): unknown[] =>
      perms
        .filter((p) => p.parentId === parentId)
        .map((p) => ({
          ...p,
          children: build(p.id),
        }));
    return build('0');
  }

  /** 角色已绑定的权限 ID 列表（角色不存在先 404） */
  async getRolePermissionIds(roleId: string): Promise<string[]> {
    await this.ensureRoleExists(roleId);
    const rows = await this.rolePermRepo.find({ where: { roleId } });
    return rows.map((r) => r.permissionId);
  }

  /**
   * 给角色分配权限：全量替换（先删该角色全部关联，再逐条插入）
   * 先校验角色存在与权限 ID 合法，避免删完才报错留下空绑定
   */
  async assignRolePermissions(roleId: string, dto: AssignPermissionIdsDto) {
    await this.ensureRoleExists(roleId);
    await this.validatePermissionIds(dto.permissionIds);
    await this.rolePermRepo.delete({ roleId });
    for (const permissionId of dto.permissionIds) {
      await this.rolePermRepo.save(
        this.rolePermRepo.create({
          id: nextSnowflakeId(),
          roleId,
          permissionId,
        }),
      );
    }
    return dto.permissionIds;
  }

  /** 用户被直授的权限 ID 列表（不含角色继承来的） */
  async getUserDirectPermissionIds(userId: string): Promise<string[]> {
    const rows = await this.userPermRepo.find({ where: { userId } });
    return rows.map((r) => r.permissionId);
  }

  /**
   * 给用户直授权限：全量替换
   * 只覆盖 kh_user_permission，不触碰角色权限，两者在鉴权时叠加
   */
  async assignUserPermissions(userId: string, dto: AssignPermissionIdsDto) {
    await this.validatePermissionIds(dto.permissionIds);
    await this.userPermRepo.delete({ userId });
    for (const permissionId of dto.permissionIds) {
      await this.userPermRepo.save(
        this.userPermRepo.create({
          id: nextSnowflakeId(),
          userId,
          permissionId,
        }),
      );
    }
    return dto.permissionIds;
  }

  /** 合并直接权限 + 角色权限；管理员追加 ADMIN_OPERATION_PERMISSIONS */
  async getUserPermissionCodes(userId: string): Promise<string[]> {
    const direct = await this.userPermRepo
      .createQueryBuilder('up')
      .innerJoin(PermissionEntity, 'p', 'p.id = up.permission_id')
      .where('up.user_id = :userId', { userId })
      .andWhere('p.status = 1')
      .andWhere('p.deleted = false')
      .select('p.permission_code', 'code')
      .getRawMany<{ code: string }>();

    const viaRole = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RolePermissionEntity, 'rp', 'rp.role_id = ur.role_id')
      .innerJoin(PermissionEntity, 'p', 'p.id = rp.permission_id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('p.status = 1')
      .andWhere('p.deleted = false')
      .select('DISTINCT p.permission_code', 'code')
      .getRawMany<{ code: string }>();

    const set = new Set<string>([...direct.map((r) => r.code), ...viaRole.map((r) => r.code)]);

    const roleCodes = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('r.status = 1')
      .select('r.role_code', 'roleCode')
      .getRawMany<{ roleCode: string }>();

    const isAdmin = roleCodes.some((r) => (ADMIN_ROLES as readonly string[]).includes(r.roleCode));
    if (isAdmin) {
      for (const code of ADMIN_OPERATION_PERMISSIONS) {
        set.add(code);
      }
    }

    return [...set];
  }

  /** 角色是否存在的轻量校验（只看主键，不判断 status） */
  private async ensureRoleExists(roleId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('角色不存在');
  }

  /**
   * 校验权限 ID 是否全部可用：一条 In(ids) 查出未删除且启用的权限，
   * 用「查到的数量 === 传入的数量」反推，少一条即 404。
   * 注意入参不能带重复 ID，否则数量天然对不上会被误判为不存在。
   * 空数组直接放行（等价于清空绑定）。
   */
  private async validatePermissionIds(ids: string[]) {
    if (!ids.length) return;
    const found = await this.permRepo.find({
      where: { id: In(ids), deleted: false, status: 1 },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException('部分权限不存在或已禁用');
    }
  }
}

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/extra.dto.js';

/**
 * 角色服务：角色的增删改查（角色与权限的绑定在 PermissionService）
 *
 * - 依赖角色、用户角色关联两个仓储
 * - 角色 status：1 启用 / 0 停用；listAll 只返回启用角色，但 getById 不过滤状态
 * - delete 是物理删除，且只拦截「仍被用户绑定」的情况，不级联清理 kh_role_permission
 */
@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
  ) {}

  /** 启用中的角色，按角色名升序（角色下拉 / 列表复用） */
  async listAll() {
    return this.roleRepo.find({ where: { status: 1 }, order: { roleName: 'ASC' } });
  }

  /** 按 ID 取角色，不存在抛 404（停用角色也能取到） */
  async getById(id: string) {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new NotFoundException('角色不存在');
    return role;
  }

  /** 新建角色：roleCode 全局唯一，冲突抛 409；新建角色默认启用 */
  async create(dto: CreateRoleDto) {
    const exists = await this.roleRepo.findOne({
      where: { roleCode: dto.roleCode },
    });
    if (exists) throw new ConflictException('角色编码已存在');
    const role = this.roleRepo.create({
      id: nextSnowflakeId(),
      roleName: dto.roleName,
      roleCode: dto.roleCode,
      description: dto.description ?? null,
      status: 1,
    });
    return this.roleRepo.save(role);
  }

  /** 更新角色名称 / 描述 / 状态；roleCode 创建后不允许改 */
  async update(id: string, dto: UpdateRoleDto) {
    const role = await this.getById(id);
    if (dto.roleName !== undefined) role.roleName = dto.roleName;
    if (dto.description !== undefined) role.description = dto.description;
    if (dto.status !== undefined) role.status = dto.status;
    return this.roleRepo.save(role);
  }

  /** 物理删除角色；仍被用户绑定（任何状态）时拒绝，避免留下悬空 user_role */
  async delete(id: string) {
    const role = await this.getById(id);
    const bound = await this.userRoleRepo.count({ where: { roleId: id } });
    if (bound > 0) {
      throw new BadRequestException('角色仍有关联用户，无法删除');
    }
    await this.roleRepo.remove(role);
  }
}

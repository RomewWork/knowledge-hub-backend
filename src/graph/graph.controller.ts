import { Controller, Get, Query } from '@nestjs/common';
import { GraphBuildService } from '../pipeline/graph-build.service.js';
import { GraphQueryDto, GraphSearchDto, GraphOverviewDto } from './dto/graph-query.dto.js';
import { PermissionCode } from '../common/constants/permissions.js';
import { CurrentUser } from '../auth/decorators/current-user.decorators.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { accessFromUser } from '../document/document-access.js';

/**
 * 图谱查询入口（只读）
 *
 * 直接复用 GraphBuildService 的读方法，不另建 service：
 * 建图与查图共用同一个 Neo4j driver，拆两个 service 会变成两个连接池。
 *
 * 三个接口都是 **GET**：查询条件放 query string。
 * 用 POST 打会得到 `Cannot POST /graph/search`（404），这是方法不匹配，不是路由不存在。
 *
 * 权限：当前只要求登录（全局 JwtAuthGuard），没有额外的 @RequirePermission。
 * 若要和 /search 保持一致，可在此处补上权限码。
 */
@Controller('graph')
export class GraphController {
  constructor(private readonly graph: GraphBuildService) {}

  /** 全景：文档 / 实体 / 标签 + 统计，供前端力导向图 */
  @Get('overview')
  overview(@Query() query: GraphOverviewDto, @CurrentUser() user: AuthUser) {
    return this.graph.getOverview({
      keyword: query.keyword,
      entityType: query.entityType,
      from: query.from,
      to: query.to,
      docLimit: query.docLimit,
      scope: accessFromUser(user),
    });
  }

  /**
   * 按关键词搜节点（文档 / 块 / 实体混排）。
   *
   * 三类节点存名字的字段不同（title / chunkId / name），
   * service 里用 coalesce 归一后再比较，返回靠 `label` 区分类型。
   */
  @Get('search')
  search(@Query() query: GraphSearchDto, @CurrentUser() user: AuthUser) {
    return this.graph.searchGraph(query.keyword, query.limit ?? 50, accessFromUser(user));
  }

  /** 知识实体节点列表，可选按 `type`（PERSON / CONCEPT / ...）过滤 */
  @Get('nodes')
  listNodes(@Query() query: GraphQueryDto, @CurrentUser() user: AuthUser) {
    return this.graph.listNodes(query.type, query.limit ?? 200, accessFromUser(user));
  }

  /** 实体之间的 RELATED_TO 边（source / target / relation / weight） */
  @Get('edges')
  listEdges(@Query() query: GraphQueryDto, @CurrentUser() user: AuthUser) {
    return this.graph.listEdges(query.limit ?? 500, accessFromUser(user));
  }
}

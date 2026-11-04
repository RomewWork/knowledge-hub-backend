import { Body, Controller, Post } from '@nestjs/common';
import { SearchIndexService } from '../pipeline/search-index.service.js';
import { SearchDocumentsDto } from './dto/search.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { PermissionCode } from '../common/constants/permissions.js';

/**
 * 全文检索入口（只读）
 *
 * 职责很薄，只有三步：
 * 1. 接收并校验查询参数（keyword / 分页 / 分类 / 作者）
 * 2. 交给 SearchIndexService 查 ES `kh_document`
 * 3. 原样返回 { items, total, page, pageSize }
 *
 * 两个容易踩的点：
 * - 本接口是 **POST**（查询条件放 body，方便后续扩展复杂过滤），不是 GET；
 * - 需要 `search` 权限码，ROLE_ADMIN 在 PermissionsGuard 里自动放行。
 *
 * 数据由发布链路异步写入 ES，所以这里能看到的前提是文档已发布且索引已建好。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly searchIndex: SearchIndexService) {}

  /**
   * 关键词检索已发布文档。
   *
   * 返回项包含 `highlight.{title,summary,content}`（命中词已被包成 <em>），
   * 列表不回传全文（`_source.excludes: ['content']`），前端进详情页再单独请求。
   */
  @Post()
  @RequirePermission(PermissionCode.search)
  search(@Body() dto: SearchDocumentsDto) {
    return this.searchIndex.searchDocuments({
      keyword: dto.keyword,
      page: dto.page,
      pageSize: dto.pageSize,
      categoryId: dto.categoryId,
      authorId: dto.authorId,
    });
  }
}

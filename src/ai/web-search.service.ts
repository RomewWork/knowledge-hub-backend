import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 联网搜索服务：给 Agent 的 web_search 工具提供外部结果（Bocha Web Search）。
 *
 * 职责：按关键词调 https://api.bochaai.com/v1/web-search，把结果收敛成 { title, url, snippet, siteName }。
 * 关键依赖：ConfigService 读取 BOCHA_API_KEY；请求用全局 fetch，无额外 SDK。
 *
 * 坑：
 * - 无 key / 非 2xx / 业务 code 非 200 一律返回 { query, items: [], error } 而不是抛错：
 *   这是 Agent 的工具，工具抛错会打断 Agent 循环，整轮回答直接失败。
 * - freshness 固定 noLimit、summary 开启，count 必须夹在 1~10，越界会被接口拒绝。
 * - 结果里缺 url 或 name 的项直接丢弃，否则前端渲染来源时会拿到空链接。
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export interface WebSearchResult {
  query: string;
  items: WebSearchHit[];
  error?: string;
}

/** Bocha Web Search，与 cron-job-tool 同一接口 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 单次搜索：调用方（Agent 工具）只看 items 与 error，从不 catch 异常，
   * 所以这里所有失败分支都必须转成返回值而不是 throw。
   */
  async search(query: string, count = 5): Promise<WebSearchResult> {
    const apiKey = this.config.get<string>('BOCHA_API_KEY');
    // 缺 key 属于预期内的未配置，直接给出可读 error，让模型自己决定要不要换别的说法
    if (!apiKey) {
      return {
        query,
        items: [],
        error: '未配置 BOCHA_API_KEY，无法联网搜索',
      };
    }

    const response = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        freshness: 'noLimit',
        summary: true,
        count: Math.min(Math.max(count, 1), 10),
      }),
    });

    // 非 2xx 只记状态码、返回 error 字段：不抛错，也不把 detail 全量透出去（可能很长）
    if (!response.ok) {
      const detail = await response.text();
      this.logger.warn(`Bocha 搜索失败：status=${response.status}`);
      return {
        query,
        items: [],
        error: `搜索失败（${response.status}）${detail.slice(0, 120)}`,
      };
    }

    const json = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: {
        webPages?: {
          value?: Array<{
            name?: string;
            url?: string;
            summary?: string;
            snippet?: string;
            siteName?: string;
          }>;
        };
      };
    };

    // 业务码异常同样算「没搜到」：返回空 items + msg，让模型决定继续回答还是换个问法
    if (json.code !== 200 || !json.data) {
      return {
        query,
        items: [],
        error: json.msg ?? '搜索接口返回异常',
      };
    }

    // webPages.value 里常有空项：先按 url + name 过滤再映射，保证前端拿到的每条都能直接渲染
    const items = (json.data.webPages?.value ?? [])
      .filter((page) => page.url && page.name)
      .map((page) => ({
        title: page.name as string,
        url: page.url as string,
        snippet: (page.summary || page.snippet || '').trim(),
        siteName: page.siteName,
      }));

    return { query, items };
  }
}

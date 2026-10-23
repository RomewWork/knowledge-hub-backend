/**
 * turndown-plugin-gfm 的补充类型声明。
 *
 * 该包不提供类型定义，npm 上也不存在 @types/turndown-plugin-gfm。
 *
 * 运行时的包结构（v1.0.2）：
 *   package.json: main = lib/turndown-plugin-gfm.cjs.js（CJS），无 exports 字段
 *   源码: module.exports = { gfm, tables, strikethrough, taskListItems, highlightedCodeBlock }
 *
 * Node 的 ESM 互操作会把 module.exports 上的属性暴露为具名导出，
 * 因此可以直接写 `import { gfm } from 'turndown-plugin-gfm'`。
 * 注意：不能用 require()——本项目是 ESM（package.json 的 "type": "module"）。
 */
declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  /** 一次性启用 tables + strikethrough + taskListItems 的组合插件 */
  export const gfm: TurndownService.Plugin;
  /** GitHub 风格表格 */
  export const tables: TurndownService.Plugin;
  /** ~~删除线~~ */
  export const strikethrough: TurndownService.Plugin;
  /** - [ ] 任务列表 */
  export const taskListItems: TurndownService.Plugin;
  /** 围栏代码块的语言标记 */
  export const highlightedCodeBlock: TurndownService.Plugin;
}

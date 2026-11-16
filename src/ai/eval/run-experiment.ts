import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { LangfuseClient } from '@langfuse/client';
import type { ExperimentTask } from '@langfuse/client';
import { AppModule } from '../../app.module.js';
import { AiStreamService } from '../ai-stream.service.js';
import { RoleCode } from '../../common/constants/roles.js';
import {
  isLangfuseEnabled,
  startLangfuseTracing,
  shutdownLangfuseTracing,
} from '../../observability/langfuse.js';
import type { AuthUser } from '../../auth/auth-user.interface.js';
import { GOLDEN_DATASET } from './golden-dataset.js';
import { AGENT_EVALUATORS } from './evaluators.js';
import type { GoldenExpected } from './eval.types.js';

const logger = new Logger('EvalRag');

/** 评测用管理员，避免文档 ACL 把公开制度测成空召回。 */
function evalUser(): AuthUser {
  return {
    userId: process.env.EVAL_USER_ID || 'eval-admin',
    username: 'eval',
    roles: [RoleCode.ADMIN],
    permissions: [],
    teamIds: [],
  };
}

async function main() {
  startLangfuseTracing();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const stream = app.get(AiStreamService);
  const filter = process.env.EVAL_FILTER;
  const data = filter
    ? GOLDEN_DATASET.filter((item) => item.metadata.id === filter || item.metadata.suite === filter)
    : GOLDEN_DATASET;
  const user = evalUser();

  // Langfuse 5.14 的 ExperimentItem.input 是可选字段，任务签名要跟着放宽，
  // 否则 GoldenItem（input 必填）与 ExperimentTaskParams 不兼容。
  const task: ExperimentTask<
    { question: string },
    GoldenExpected,
    { id: string; suite: string }
  > = async (raw) => {
    // ExperimentItem 是 `{input?} | DatasetItem` 的联合类型，DatasetItem 的 input 是 unknown，
    // 直接读字段会报「Property does not exist on type '{}'」，这里按金标结构收窄。
    const item = raw as {
      input?: { question?: string };
      metadata?: { id?: string; suite?: string };
    };
    const question = item.input?.question ?? '';
    if (!question) return stream.runForEval('', 5, user);
    logger.log(`评测：${item.metadata?.id ?? '-'} ${question}`);
    // 走线上同一个 Agent；runForEval 不落会话和记忆
    return stream.runForEval(question, 5, user);
  };

  if (isLangfuseEnabled()) {
    const langfuse = new LangfuseClient();
    const result = await langfuse.experiment.run({
      name: 'agentic-rag',
      description: '流式 Agent：意图/工具/检索 Hit·Precision/拒答/忠实度',
      data,
      task,
      evaluators: AGENT_EVALUATORS,
      maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 2),
      metadata: {
        model: process.env.MODEL_NAME || process.env.LLM_MODEL || '',
      },
    });
    console.log(await result.format());
    await langfuse.flush();
  } else {
    logger.warn('未配置 LANGFUSE_*，只在终端打印分数');
    for (const item of data) {
      const output = await task(item);
      const scores = await Promise.all(
        AGENT_EVALUATORS.map((fn) =>
          fn({
            input: item.input,
            output,
            expectedOutput: item.expectedOutput,
          }),
        ),
      );
      console.log(
        `\n[${item.metadata.id}] intent=${output.intent} answer=${output.answer.slice(0, 80)}`,
      );
      for (const s of scores.flat()) {
        console.log(`  ${s.name}=${s.value}  ${s.comment ?? ''}`);
      }
    }
  }

  await shutdownLangfuseTracing();
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

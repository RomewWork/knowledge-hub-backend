import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { extname } from 'path';

export interface UploadBytesOptions {
  fileName: string;
  contentType: string;
  /** 对象 key 前缀，默认 documents */
  prefix?: string;
}

/**
 * RustFS 文件存储（S3 兼容）
 *
 * 职责：把 PDF 原件等二进制上传到 S3 兼容对象存储，返回可访问 URL 存进文档表；
 * 不负责鉴权、删除和生命周期管理，对象由存储侧的策略清理。
 *
 * 关键依赖：@aws-sdk/client-s3、ConfigService（RUSTFS_ENDPOINT / ACCESS_KEY / SECRET_KEY / BUCKET / PUBLIC_URL / ENABLED）。
 *
 * 坑与取舍：
 * 1. forcePathStyle 必须为 true：RustFS / MinIO 这类自建存储不支持虚拟主机风格域名。
 * 2. 降级分两种情况：isEnabled() 为 false 时调用方只记 warn、跳过上传，文档照样入库但 fileUrl 为空，
 *    后果是原件不能预览/下载，也无法从原件重新解析正文；而 enabled 但上传抛错时，调用方会把异常转成 400，整次创建失败。
 *    排查线上「文档没有原件」时先看 RUSTFS_ENABLED 与 bucket 是否存在。
 * 3. bucket 在 onModuleInit 里异步创建，失败只 warn，真正的重试发生在首次上传时。
 */
@Injectable()
export class RustfsService implements OnModuleInit {
  private readonly logger = new Logger(RustfsService.name);
  private client: S3Client | null = null;
  private enabled = false;
  private bucket = '';
  private publicBaseUrl = '';

  constructor(private readonly config: ConfigService) {}

  /**
   * 初始化 S3 客户端并尝试建 bucket。
   *
   * 这里不 await ensureBucket，是为了不让对象存储的可用性阻塞服务启动；
   * 代价是 bucket 缺失的问题会推迟到第一次上传才暴露（日志里已有 warn）。
   */
  onModuleInit() {
    this.enabled = this.config.get<string>('RUSTFS_ENABLED', 'true').toLowerCase() !== 'false';
    if (!this.enabled) {
      this.logger.warn('RustFS 已禁用（RUSTFS_ENABLED=false），文件上传将跳过');
      return;
    }

    const endpoint = this.config.get<string>('RUSTFS_ENDPOINT', 'http://localhost:9000');
    const accessKey = this.config.get<string>('RUSTFS_ACCESS_KEY', 'rustfsadmin');
    const secretKey = this.config.get<string>('RUSTFS_SECRET_KEY', 'rustfsadmin');
    const region = this.config.get<string>('RUSTFS_REGION', 'us-east-1');
    this.bucket = this.config.get<string>('RUSTFS_BUCKET', 'knowledge-hub');
    this.publicBaseUrl = (this.config.get<string>('RUSTFS_PUBLIC_URL') || endpoint).replace(
      /\/$/,
      '',
    );

    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true,
    });

    void this.ensureBucket().catch((err) => {
      this.logger.warn(
        `RustFS 初始化 bucket 失败（首次上传时会重试）: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  /** 是否真的能上传：既要开关打开，也要客户端已创建成功 */
  isEnabled(): boolean {
    return this.enabled && this.client != null;
  }

  /**
   * 上传字节，返回可访问 URL：{publicBase}/{bucket}/{key}
   *
   * key 会拼上日期目录与随机 UUID，避免同名文件互相覆盖，也让对象在桶里按时间自然分布。
   * 上传失败不吞异常，直接抛 503；当前文档上传会把异常转成 400 并中断创建，
   * 所以调用方在调用前通常先问 isEnabled()，以免存储故障连累不依赖原件的主流程。
   */
  async uploadBytes(bytes: Buffer | Uint8Array, options: UploadBytesOptions): Promise<string> {
    if (!this.isEnabled() || !this.client) {
      throw new ServiceUnavailableException('RustFS 未启用或未配置，无法上传文件');
    }

    await this.ensureBucket();

    const prefix = (options.prefix ?? 'documents').replace(/^\/+|\/+$/g, '');
    const ext = extname(options.fileName) || guessExt(options.contentType);
    const safeBase = sanitizeBaseName(options.fileName);
    const key = `${prefix}/${formatDatePath()}/${safeBase}-${randomUUID()}${ext}`;
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.length,
      }),
    );

    const url = `${this.publicBaseUrl}/${this.bucket}/${key}`;
    this.logger.log(`RustFS 上传成功: key=${key}, size=${body.length}, url=${url}`);
    return url;
  }

  /**
   * 确保 bucket 存在：先 HEAD 探测，不存在再创建。
   *
   * 并发场景下两个请求可能同时创建，所以 CreateBucket 报已存在也视为成功。
   */
  private async ensureBucket(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // bucket 不存在则创建
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`RustFS bucket 已创建: ${this.bucket}`);
    } catch (err) {
      // 并发创建时可能已存在
      const message = err instanceof Error ? err.message : String(err);
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists|already exists/i.test(message)) {
        throw err;
      }
    }
  }
}

/** 按年月日生成对象目录前缀，便于按时间归档和批量清理 */
function formatDatePath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/**
 * 清洗文件名主体：保留中英文、数字和少量安全符号，其余替换成下划线并截断。
 * 目的是让 key 在各家 S3 实现和 URL 里都安全，避免特殊字符导致 403 或签名异常。
 */
function sanitizeBaseName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '') || 'file';
  return base.replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 64);
}

/** 文件名没有扩展名时按 content-type 兜底，识别不了就返回空串 */
function guessExt(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

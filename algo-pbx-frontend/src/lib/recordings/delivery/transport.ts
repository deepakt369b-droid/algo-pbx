import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TargetConfig, S3Config, SftpConfig } from "./targets";

// The two delivery transports, behind one interface.
//
// Every transport must implement `verify()` as a genuine READ-BACK of the
// object it just wrote, compared by content hash. Not a HEAD, not a size
// check, not the upload's own return value: this is the sole evidence that
// authorises deleting the customer's local copy, and the failure it guards
// against (an upload that succeeds while the write silently does not land) is
// unrecoverable.

export interface DeliveryOutcome {
  ok: boolean;
  verified: boolean;
  bytes?: number;
  error?: { message: string; code?: string; statusCode?: number; name?: string };
}

export interface Transport {
  /** Upload, then read back and compare. Returns verified: true only when the
   * remote content hash matches the local one. */
  deliver(localPath: string, remoteKey: string): Promise<DeliveryOutcome>;
  /** Cheap connectivity/credential check for the "test target" button. */
  test(): Promise<{ ok: boolean; error?: string }>;
  close(): Promise<void>;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function describeError(err: unknown): DeliveryOutcome["error"] {
  const e = err as { message?: string; code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return {
    message: e?.message ?? "Unknown error",
    code: e?.code,
    name: e?.name,
    statusCode: e?.$metadata?.httpStatusCode,
  };
}

// --- S3 --------------------------------------------------------------------

class S3Transport implements Transport {
  private client: import("@aws-sdk/client-s3").S3Client | null = null;

  constructor(private config: S3Config) {}

  private async getClient() {
    if (this.client) return this.client;
    // Imported lazily so the AWS SDK is not pulled into every process that
    // merely imports this module — the web app does not deliver recordings,
    // the worker does.
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.client = new S3Client({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
    return this.client;
  }

  async deliver(localPath: string, remoteKey: string): Promise<DeliveryOutcome> {
    try {
      const body = await readFile(localPath);
      const localHash = sha256(body);

      const { PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await this.getClient();

      await client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: remoteKey,
          Body: body,
          ContentType: "audio/wav",
          // Recorded so a customer auditing their own bucket can match an
          // object back to our copy without downloading it.
          Metadata: { "sha256-hex": localHash },
        })
      );

      // THE READ-BACK. Full object, hashed and compared — the only evidence
      // that authorises purging the local file.
      const got = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: remoteKey })
      );
      const remoteBytes = Buffer.from(await got.Body!.transformToByteArray());

      return {
        ok: true,
        verified: sha256(remoteBytes) === localHash && remoteBytes.length === body.length,
        bytes: body.length,
      };
    } catch (err) {
      return { ok: false, verified: false, error: describeError(err) };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
      await (await this.getClient()).send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err)?.message };
    }
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }
}

// --- SFTP ------------------------------------------------------------------

class SftpTransport implements Transport {
  // ssh2-sftp-client has no bundled types in this project; the surface used
  // here is small and declared inline rather than pulling a types package.
  private client: {
    connect(opts: Record<string, unknown>): Promise<unknown>;
    put(src: Buffer, dest: string): Promise<unknown>;
    get(src: string): Promise<Buffer>;
    mkdir(dir: string, recursive: boolean): Promise<unknown>;
    list(dir: string): Promise<unknown[]>;
    end(): Promise<unknown>;
  } | null = null;

  constructor(private config: SftpConfig) {}

  private connectOptions() {
    return {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      ...(this.config.privateKey
        ? { privateKey: this.config.privateKey, passphrase: this.config.passphrase }
        : { password: this.config.password }),
      readyTimeout: 20_000,
    };
  }

  private async getClient() {
    if (this.client) return this.client;
    // ssh2-sftp-client ships no type declarations, and its @types package
    // drags in a large transitive tree for the five methods used here. The
    // untyped import is narrowed immediately to the interface declared on
    // `client` above, so `any` does not spread through this module.
    const mod: unknown = await import("ssh2-sftp-client");
    const candidate = (mod as { default?: unknown })?.default ?? mod;
    const Ctor = candidate as new () => NonNullable<SftpTransport["client"]>;
    const c = new Ctor();
    await c.connect(this.connectOptions());
    this.client = c;
    return c;
  }

  async deliver(localPath: string, remoteKey: string): Promise<DeliveryOutcome> {
    try {
      const body = await readFile(localPath);
      const localHash = sha256(body);

      const client = await this.getClient();
      const remoteFull = `${this.config.remotePath.replace(/\/+$/, "")}/${remoteKey}`;
      const remoteDir = remoteFull.slice(0, remoteFull.lastIndexOf("/"));

      // Recursive mkdir is idempotent in this client; a pre-existing
      // directory is not an error worth failing a delivery over.
      await client.mkdir(remoteDir, true).catch(() => undefined);
      await client.put(body, remoteFull);

      // THE READ-BACK. Pulls the file back and compares — an SFTP server
      // writing to a full disk can accept a put and produce a truncated file.
      const remoteBytes = await client.get(remoteFull);
      const remoteBuf = Buffer.isBuffer(remoteBytes) ? remoteBytes : Buffer.from(remoteBytes);

      return {
        ok: true,
        verified: sha256(remoteBuf) === localHash && remoteBuf.length === body.length,
        bytes: body.length,
      };
    } catch (err) {
      return { ok: false, verified: false, error: describeError(err) };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      await client.list(this.config.remotePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err)?.message };
    }
  }

  async close(): Promise<void> {
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }
}

export function createTransport(config: TargetConfig): Transport {
  return config.kind === "CUSTOMER_S3" ? new S3Transport(config) : new SftpTransport(config);
}

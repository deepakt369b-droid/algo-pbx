// Minimal ambient declaration for ssh2-sftp-client.
//
// The package ships no types of its own. Its DefinitelyTyped package pulls in
// @types/ssh2 and a sizeable transitive tree to describe an API surface of
// which this codebase uses exactly five methods, all in
// src/lib/recordings/delivery/transport.ts.
//
// Declaring that surface here keeps the dependency tree small and, more
// usefully, makes the contract we actually rely on explicit and reviewable in
// one place. If a sixth method is ever needed, it gets added here
// deliberately rather than arriving invisibly with a version bump.

declare module "ssh2-sftp-client" {
  interface ConnectOptions {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
    [key: string]: unknown;
  }

  class SftpClient {
    connect(options: ConnectOptions): Promise<unknown>;
    put(src: Buffer | string, dest: string): Promise<unknown>;
    get(src: string): Promise<Buffer>;
    mkdir(dir: string, recursive?: boolean): Promise<unknown>;
    list(dir: string): Promise<unknown[]>;
    end(): Promise<unknown>;
  }

  export = SftpClient;
}

declare module "pg" {
  export type PoolConfig = {
    host?: string; port?: number; database?: string; user?: string; password?: string; max?: number;
  };
  export class Pool {
    constructor(config?: PoolConfig);
    end(): Promise<void>;
  }
}

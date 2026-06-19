// y-leveldb ships types but its package.json "exports" map doesn't surface them
// under bundler module resolution. Declare the slice we use.
declare module "y-leveldb" {
  import type * as Y from "yjs";
  export class LeveldbPersistence {
    constructor(location: string, options?: unknown);
    getYDoc(name: string): Promise<Y.Doc>;
    storeUpdate(name: string, update: Uint8Array): Promise<void>;
    clearDocument(name: string): Promise<void>;
    getStateVector(name: string): Promise<Uint8Array>;
  }
}

import {tsImport} from 'tsx/esm/api';

// 定向验证直接加载源码 worker，避免依赖完整构建产物。
await tsImport('../../src/storage/worker.ts', import.meta.url);

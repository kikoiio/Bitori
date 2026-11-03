import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    pool: 'forks',
    // 默认 5s 对集成与 TUI 用例偏紧：Windows runner 一旦负载高，10s 量级的用例会假性超时，
    // 超时又会打断清理、留下占用的临时目录。放宽到 20s，真正挂死的用例仍会失败。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});

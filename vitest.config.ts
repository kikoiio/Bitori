import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    pool: 'forks',
    // [s15] 收尾清理历史运行遗留的 /tmp/bitori-* 测试目录，防止 tmpfs 配额被慢慢吃掉。
    globalSetup: './tests/helpers/global-teardown.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});

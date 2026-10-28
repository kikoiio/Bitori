import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.js', '.tmp/**', 'chrome-profile*/**', 'benchmarks/tasks/**/workspace/**']},
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['src/desktop/**/*.cjs', 'src/desktop/renderer/**/*.js', 'tests/desktop/**/*.mjs', 'benchmarks/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly', __dirname: 'readonly', module: 'readonly', require: 'readonly',
        process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        URL: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly',
      },
    },
  },
  {files: ['src/desktop/**/*.cjs'], rules: {'@typescript-eslint/no-require-imports': 'off'}},
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {'react-hooks': reactHooks},
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      'require-yield': 'off',
    },
  },
);

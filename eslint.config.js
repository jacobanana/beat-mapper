import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test/legacy'] },
  { files: ['e2e/**', '*.config.*'], languageOptions: { globals: { ...globals.node } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The core must stay portable: no DOM, no Web Audio, no app state.
    files: ['src/core/**/*.ts', 'src/io/formats/**/*.ts'],
    languageOptions: { globals: { ...globals.es2022 } },
    rules: {
      'no-restricted-globals': ['error', 'document', 'window', 'localStorage', 'AudioContext', 'navigator'],
      'no-restricted-imports': ['error', { patterns: ['**/app/**', '**/ui/**', '**/engine/**', '**/state/**'] }],
    },
  },
);

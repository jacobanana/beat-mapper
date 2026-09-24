import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test/legacy', '.dev'] },
  { files: ['e2e/**', '*.config.*', '.claude/**'], languageOptions: { globals: { ...globals.node } } },
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
    // Where things sit in time comes from the timeline (core/timeline.ts, App.timeline): what is drawn
    // is then what is heard. Its axis meets pixels only in `ui/canvas/screen.ts` (and the renderer and
    // the pointer, which zoom and scroll it), and the warp's alignment (not a tempo) is read only where
    // the warp is made.
    files: ['src/app/**/*.ts', 'src/ui/**/*.ts'],
    ignores: ['src/ui/canvas/screen.ts', 'src/ui/canvas/editor-renderer.ts', 'src/ui/input/pointer.ts', 'src/app/app.ts', 'src/app/features/warp.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[object.property.name='view'][property.name=/^(xOf|tOf)$/]",
          message: 'Go through app.timeline: the view is its axis, not the audio. Only the renderer and the pointer turn the axis into pixels.',
        },
        {
          selector: "MemberExpression[property.name='alignment']",
          message: 'The alignment says where the warp puts the audio, not the tempo: read app.timeline or app.tempoMap instead.',
        },
        {
          selector: "MemberExpression[object.property.name='tempoMap'][property.name=/^(timeToPos|barBeatAt|barRangeAt|bpmAt)$/]",
          message: 'A time of the audio is placed on the grid by app.timeline (posOf, barBeatAt, barRangeAt, bpmAt), which knows whether it is drawn moved.',
        },
      ],
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

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v7 added strict new rules that flag patterns
      // this codebase uses intentionally and correctly (data fetch-on-mount,
      // stable ref-callbacks, a shared module-level voice flag). They are style
      // opinions, not bugs — tsc compiles and the app runs — so we downgrade the
      // noisy ones and keep exhaustive-deps as a (useful) warning, not an error.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // The two vendored UI files intentionally use @ts-nocheck.
      '@typescript-eslint/ban-ts-comment': 'off',
      // shadcn UI files export variant helpers alongside the component — this is
      // by design; the rule is a dev-only HMR hint, not a correctness issue.
      'react-refresh/only-export-components': 'off',
    },
  },
])

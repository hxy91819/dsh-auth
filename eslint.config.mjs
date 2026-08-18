import eslint from '@eslint/js'
import globals from 'globals'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

function healthRules(severity, limits) {
  return {
    'complexity': [severity, limits.cyclomaticComplexity],
    'max-lines': [severity, { max: limits.fileLines, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': [severity, {
      max: limits.functionLines,
      skipBlankLines: true,
      skipComments: true,
      IIFEs: true,
    }],
    'max-statements': [severity, limits.statements],
    'sonarjs/cognitive-complexity': [severity, limits.cognitiveComplexity],
  }
}

export default tseslint.config(
  {
    ignores: ['lib/**', 'coverage/**', '.tmp/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    plugins: { sonarjs },
  },
  {
    files: ['**/*.{cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['tsdown.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      'curly': ['error', 'multi-line'],
      'eqeqeq': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: healthRules('error', {
      fileLines: 800,
      functionLines: 120,
      statements: 80,
      cognitiveComplexity: 30,
      cyclomaticComplexity: 25,
    }),
  },
  {
    files: ['tests/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    rules: healthRules('warn', {
      fileLines: 1200,
      functionLines: 180,
      statements: 120,
      cognitiveComplexity: 45,
      cyclomaticComplexity: 40,
    }),
  },
)

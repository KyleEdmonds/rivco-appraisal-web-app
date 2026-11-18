// ESLint flat config (ESLint v9).
// Minimal setup for the audit — only the two requested rules:
//   no-unused-vars        (catch dead imports / variables)
//   no-duplicate-imports  (catch repeated import statements from one module)
// Add `@eslint/js` recommended + `globals` later if you want no-undef / style rules.
export default [
  {
    ignores: [
      'node_modules/**',
      'storage/**',
      'bin/**',
      'obj/**',
      'input/**',
      'output/**',
      'wwwroot/lib/**', // vendored Leaflet
    ],
  },
  {
    files: ['wwwroot/js/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'no-duplicate-imports': 'error',
    },
  },
];

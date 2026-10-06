import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import perfectionist from "eslint-plugin-perfectionist";
import regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

const SOURCE_GLOBS = [
  "packages/**/src/**/*.ts",
  "packages/**/test/**/*.ts",
  "packages/**/bin/**/*.ts",
  "packages/**/scripts/**/*.ts",
  "scripts/**/*.ts",
];

export default tseslint.config(
  {
    // Global ignores MUST be the sole key in this object so eslint treats them
    // as global (not config-scoped) — otherwise built dist/ artifacts leak into
    // the lint and make the gate non-deterministic w.r.t. build state.
    ignores: [
      "**/dist/**",
      "coverage/**",
      "node_modules/**",
      "bun.lock",
      "docs/**",
      "eslint.config.mjs",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  {
    files: SOURCE_GLOBS,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {},
  },
  {
    files: SOURCE_GLOBS,
    plugins: {
      unicorn,
      "import-x": importX,
      "unused-imports": unusedImports,
      sonarjs,
      perfectionist,
      regexp,
      security,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/only-throw-error": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-alert": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "prefer-const": "error",
      "no-var": "error",
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-unused-capturing-group": "error",
      "regexp/no-useless-flag": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "import-x/first": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      // verbatimModuleSyntax is enabled in tsconfig.eslint.json (the strict
      // gate config these rules type-check against), so type-only imports must
      // be explicit. Both are clean today; keep them as errors to stop drift.
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-warning-comments": [
        "warn",
        { terms: ["todo", "fixme", "hack", "xxx"], location: "anywhere" },
      ],
      "perfectionist/sort-imports": [
        "warn",
        {
          type: "natural",
          order: "asc",
          newlinesBetween: 1,
          groups: [
            "type-import",
            ["value-builtin", "value-external"],
            ["type-internal", "value-internal"],
            ["type-parent", "type-sibling", "type-index"],
            ["value-parent", "value-sibling", "value-index"],
            "ts-equals-import",
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-named-exports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-exports": ["warn", { type: "natural", order: "asc" }],
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["warn", 12],
      "unicorn/no-for-loop": "warn",
      "unicorn/no-array-for-each": "warn",
      "unicorn/prefer-node-protocol": "warn",
      "unicorn/prefer-string-replace-all": "warn",
      "unicorn/prefer-set-has": "warn",
      "unicorn/throw-new-error": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-non-literal-regexp": "warn",
      "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/member-ordering": "off",
      "perfectionist/sort-object-types": "off",
      "import-x/order": "off",
      complexity: "off",
      "sonarjs/no-duplicate-string": "off",
      "security/detect-object-injection": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
    },
  },
  {
    files: ["packages/**/tools/**/*.ts"],
    rules: {
      "max-lines-per-function": ["warn", { max: 250, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines-per-function": "off",
    },
  },
  prettierConfig,
);

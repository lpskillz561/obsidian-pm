import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' }
    }
  },
  {
    files: ['src/views/table/**/*.ts'],
    rules: {
      'obsidianmd/no-static-styles-assignment': 'off'
    }
  },
  {
    // Spawning a local Claude agent needs Node's APIs, which the submission
    // ruleset bans outright because they break mobile. This file loads them
    // lazily inside `Platform.isDesktopApp` guards, so the plugin still loads
    // on mobile — the feature is just absent there.
    //
    // If this fork is ever submitted to the community store, expect a reviewer
    // to ask about exactly this file.
    files: ['src/services/ClaudeRunner.ts'],
    languageOptions: {
      globals: { require: 'readonly', process: 'readonly', Buffer: 'readonly' }
    },
    rules: {
      'import/no-nodejs-modules': 'off'
    }
  }
])

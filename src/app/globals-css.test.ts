import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Next's own copies of the plugins it runs over CSS when a project has no
// PostCSS config, as this one hasn't, for the browsers it targets when a
// project names none (next/dist/build/webpack/config/blocks/css/plugins.js),
// then its minifier: globals.css as `next build` writes it.
const require = createRequire(import.meta.url);
const postcss = require('postcss');
const flexbugs = require('next/dist/compiled/postcss-flexbugs-fixes');
const presetEnv = require('next/dist/compiled/postcss-preset-env');
const minify = require('next/dist/compiled/cssnano-simple');
const { MODERN_BROWSERSLIST_TARGET } = require('next/dist/shared/lib/constants');

async function built(css: string): Promise<string> {
  const env = await postcss([
    flexbugs,
    presetEnv({ browsers: MODERN_BROWSERSLIST_TARGET, autoprefixer: { flexbox: 'no-2009' }, stage: 3, features: { 'custom-properties': false } }),
  ]).process(css, { from: undefined });
  return (await postcss([minify()]).process(env.css, { from: undefined })).css;
}

describe('globals.css as next build writes it', () => {
  it('keeps the -webkit- text size that stops iPhones enlarging a report\'s text', async () => {
    const css = await built(readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8'));
    // Field bug 2026-10-17: autoprefixer dropped it, leaving only the form iOS ignores.
    expect(css).toContain('.rep-table{-webkit-text-size-adjust:100%;text-size-adjust:100%}');
  });
});

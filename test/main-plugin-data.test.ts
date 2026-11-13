import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');

describe('plugin data goes through the guard (A3 / P2a)', () => {
  it('main.ts builds its only plugin-data access with createPluginDataGuard and hands the guard to the registration', () => {
    expect(main).toMatch(/createPluginDataGuard\(\{\s*loadData: this\.loadData\.bind\(this\),\s*saveData: this\.saveData\.bind\(this\)\s*\}\)/);
    expect(main).toContain('installKeys: this.pluginData');
    expect(main).toContain('pluginVersion: this.manifest.version');
  });

  it('never calls loadData or saveData directly on the plugin', () => {
    expect(main).not.toMatch(/this\.(loadData|saveData)\s*\(/);
  });
});

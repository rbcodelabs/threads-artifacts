import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldReportSupport, type DesignArtifactFs } from '../src/designArtifact';
import { REPORT_JS } from '../src/reportTemplate';

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fileFs: DesignArtifactFs = {
    mkdir: async () => undefined,
    writeFile: async (target, data, options) => {
      if (options?.flag === 'wx' && files.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(target, data);
    },
  };
  return { files, fileFs };
}

describe('legend swatch accessible name in the report scaffold', () => {
  const root = path.join('/artifact');

  it('a new report gets a report.js whose legend swatch is a named image, not aria-hidden', async () => {
    const { files, fileFs } = memFs();
    await scaffoldReportSupport(fileFs, root);
    const reportJs = files.get(path.join(root, 'report.js'))!;
    expect(reportJs).toBe(REPORT_JS);
    expect(reportJs).toContain('role="img" aria-label="');
    expect(reportJs).toContain(' legend color"></span>');
    expect(reportJs).not.toMatch(/class="swatch"[^>]*aria-hidden/);
  });

  it('an existing report.js is left exactly as it was (scaffold files are written only if missing)', async () => {
    const old = '/* an older report.js that still has aria-hidden swatches */\n';
    const { files, fileFs } = memFs({ [path.join(root, 'report.js')]: old });
    await scaffoldReportSupport(fileFs, root);
    expect(files.get(path.join(root, 'report.js'))).toBe(old);
    expect(files.has(path.join(root, 'data.js'))).toBe(true);
  });
});

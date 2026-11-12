import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { nodeCommandRunner } from '../src/commandRunner';

// These spawn the current Node binary only (no shell, no POSIX-only tools), so they run on any CI platform.
describe('nodeCommandRunner (real processes)', () => {
  it('captures stdout and the exit code of a normal command', async () => {
    const result = await nodeCommandRunner()({ command: process.execPath, args: ['-e', "console.log('hello')"], cwd: os.tmpdir(), timeoutMs: 20_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  it('settles shortly after the timeout even when a background process keeps the output pipes open', async () => {
    // The grandchild inherits our pipes and lives for 8 s; waiting for the pipes to close would hang the caller.
    const script = "require('child_process').spawn(process.execPath,['-e','setTimeout(function(){},8000)'],{stdio:'inherit',detached:true}).unref();setTimeout(function(){},8000)";
    const started = Date.now();
    const result = await nodeCommandRunner()({ command: process.execPath, args: ['-e', script], cwd: os.tmpdir(), timeoutMs: 300, killTree: true });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('does the same without killTree', async () => {
    const script = "require('child_process').spawn(process.execPath,['-e','setTimeout(function(){},8000)'],{stdio:'inherit',detached:true}).unref();setTimeout(function(){},8000)";
    const started = Date.now();
    const result = await nodeCommandRunner()({ command: process.execPath, args: ['-e', script], cwd: os.tmpdir(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const CODE_DIR = path.resolve(import.meta.dirname, '..');

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
type NpmLock = { packages: Record<string, { version?: string }> };
/** A direct dependency the two lockfiles resolve differently; null where a lockfile has no entry for it. */
type Drift = { name: string; bun: string | null; npm: string | null };

/**
 * The direct dependencies of `manifest` that `bun.lock` and `package-lock.json` resolve differently. bun.lock is JSON
 * with trailing commas, and keys each top-level package by its name with `"<name>@<version>"` first.
 */
function lockDrift(manifest: Manifest, bunLockText: string, npmLock: NpmLock): Drift[] {
  const bunLock = JSON.parse(bunLockText.replace(/,(\s*[}\]])/g, '$1')) as { packages: Record<string, [string, ...unknown[]]> };
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).sort();
  return names
    .map((name) => {
      const spec = bunLock.packages[name]?.[0];
      return { name, bun: spec === undefined ? null : spec.slice(spec.lastIndexOf('@') + 1), npm: npmLock.packages[`node_modules/${name}`]?.version ?? null };
    })
    .filter((d) => d.bun === null || d.bun !== d.npm);
}

const read = (file: string): string => readFileSync(path.join(CODE_DIR, file), 'utf8');

describe('lockfile parity: the Bun gate and the Node gate install the same direct dependencies', () => {
  it('bun.lock and package-lock.json resolve every direct dependency in package.json to the same version', () => {
    const drift = lockDrift(JSON.parse(read('package.json')), read('bun.lock'), JSON.parse(read('package-lock.json')));
    assert.deepEqual(drift, [], drift.map((d) => `${d.name}: bun.lock ${d.bun ?? 'missing'}, package-lock.json ${d.npm ?? 'missing'}`).join('; '));
  });

  it('names the dependency and both versions when the lockfiles disagree or one lacks it', () => {
    const manifest = { dependencies: { '@boatdev/sdk': '^1.5.0', yaml: '^2.9.1' }, devDependencies: { tsx: '^4.23.15' } };
    const bunLock = '{ "packages": { "@boatdev/sdk": ["@boatdev/sdk@1.6.0", "", {}, "sha512-a"], "yaml": ["yaml@2.9.1", "", {}, "sha512-b"], }, }';
    const npmLock = { packages: { 'node_modules/@boatdev/sdk': { version: '1.5.0' }, 'node_modules/tsx': { version: '4.23.15' }, 'node_modules/yaml': { version: '2.9.1' } } };
    assert.deepEqual(lockDrift(manifest, bunLock, npmLock), [
      { name: '@boatdev/sdk', bun: '1.6.0', npm: '1.5.0' },
      { name: 'tsx', bun: null, npm: '4.23.15' },
    ]);
  });
});

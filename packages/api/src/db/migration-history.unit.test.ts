import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(currentDir, '../../drizzle');
const deployScriptPath = resolve(currentDir, '../../../../deploy/deploy.sh');
const migrationDirPattern = /^\d{14}_[A-Za-z0-9_-]+$/;

function listMigrationDirs(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => {
      const path = resolve(drizzleDir, name);
      return statSync(path).isDirectory() && migrationDirPattern.test(name);
    })
    .sort();
}

function readMigrationSql(dirName: string): string {
  return readFileSync(resolve(drizzleDir, dirName, 'migration.sql'), 'utf8');
}

describe('Drizzle v1 migration history', () => {
  it('uses v1 folder migrations instead of the legacy journal format', () => {
    expect(existsSync(resolve(drizzleDir, 'meta/_journal.json'))).toBe(false);

    const legacySqlFiles = readdirSync(drizzleDir).filter((name) => /^\d{4}_.+\.sql$/.test(name));
    expect(legacySqlFiles).toEqual([]);
  });

  it('has a migration.sql and snapshot.json for every migration folder', () => {
    const migrationDirs = listMigrationDirs();
    expect(migrationDirs.length).toBeGreaterThan(0);

    for (const dirName of migrationDirs) {
      expect(
        existsSync(resolve(drizzleDir, dirName, 'migration.sql')),
        `${dirName}/migration.sql`,
      ).toBe(true);
      expect(
        existsSync(resolve(drizzleDir, dirName, 'snapshot.json')),
        `${dirName}/snapshot.json`,
      ).toBe(true);
    }
  });

  it('keeps migration folder timestamps strictly increasing', () => {
    const migrationDirs = listMigrationDirs();
    let previousTimestamp = 0;

    for (const dirName of migrationDirs) {
      const timestamp = Number(dirName.slice(0, 14));
      expect(timestamp, `${dirName} must be newer than the previous migration`).toBeGreaterThan(
        previousTimestamp,
      );
      previousTimestamp = timestamp;
    }
  });

  it('checks migration compatibility before modifying deployment artifacts', () => {
    const deployScript = readFileSync(deployScriptPath, 'utf8');
    const compatibilityCheck = deployScript.indexOf('MIGRATION_BASELINE');
    const codePull = deployScript.indexOf('git pull origin master');
    const quadletUpdate = deployScript.indexOf('cp "$REPO_DIR/deploy/quadlet/markdawn.pod"');
    const imageBuild = deployScript.indexOf('podman build -t localhost/markdawn-api:latest');
    const serviceStop = deployScript.indexOf('systemctl --user stop');

    expect(compatibilityCheck).toBeGreaterThan(-1);
    expect(codePull).toBeGreaterThan(compatibilityCheck);
    expect(quadletUpdate).toBeGreaterThan(compatibilityCheck);
    expect(imageBuild).toBeGreaterThan(compatibilityCheck);
    expect(serviceStop).toBeGreaterThan(compatibilityCheck);
    expect(deployScript).toContain('20260708053035_init');
  });

  it('enforces one link share and numeric page ordering values', () => {
    const integrityMigration = listMigrationDirs().find((dirName) =>
      dirName.endsWith('_enforce_share_and_position_integrity'),
    );
    expect(integrityMigration, 'integrity migration is missing').toBeDefined();

    const migrationSql = readMigrationSql(integrityMigration ?? '');
    expect(migrationSql).toContain('shares_link_unique');
    expect(migrationSql).toContain('folders_position_numeric_check');
    expect(migrationSql).toContain('pages_position_numeric_check');
    expect(migrationSql).toContain('char_length("position") <= 128');
    expect(migrationSql.indexOf('DELETE FROM shares')).toBeLessThan(
      migrationSql.indexOf('CREATE UNIQUE INDEX "shares_link_unique"'),
    );
  });

  it('does not reintroduce the legacy access restriction column', () => {
    const migrationDirs = listMigrationDirs();
    const migrationText = migrationDirs.map(readMigrationSql).join('\n');

    expect(migrationText).not.toContain('is_access_restricted');
  });

  it('keeps sharing helpers tied to inheritance_policy', () => {
    const helpersMigration = listMigrationDirs().find((dirName) =>
      dirName.endsWith('_sharing_helpers'),
    );
    expect(helpersMigration, 'sharing helper migration is missing').toBeDefined();

    const migrationSql = readMigrationSql(helpersMigration ?? '');
    const requiredHelpers = [
      'is_folder_inheritance_blocked',
      'is_folder_path_restricted',
      'is_page_path_restricted',
      'is_page_folder_inheritance_blocked',
      'get_effective_page_permission',
      'get_effective_folder_permission',
      'get_page_base_permissions',
      'get_accessible_page_ids',
    ];

    for (const helper of requiredHelpers) {
      expect(migrationSql).toContain(helper);
    }

    expect(migrationSql).toContain('inheritance_policy');
    expect(migrationSql).not.toContain('is_access_restricted');
  });
});

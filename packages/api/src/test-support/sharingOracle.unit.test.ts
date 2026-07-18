import { describe, expect, it } from 'vitest';
import {
  decideSharingPermission,
  type OracleLinkPermission,
  type OraclePermission,
} from './sharingOracle';

const roles: readonly OraclePermission[] = [null, 'view', 'edit', 'admin'];
const links: readonly OracleLinkPermission[] = [null, 'view', 'edit'];
const rank = (permission: OraclePermission) => roles.indexOf(permission);

describe('independent sharing permission oracle', () => {
  it('exhausts the 55,296 depth-two permission cells', () => {
    let checked = 0;
    for (const workspace of roles) {
      for (const targetGrant of roles) {
        for (const parentGrant of roles) {
          for (const grandparentGrant of roles) {
            for (const targetLink of links) {
              for (const parentLink of links) {
                for (const grandparentLink of links) {
                  for (let boundaryBits = 0; boundaryBits < 8; boundaryBits += 1) {
                    const decision = decideSharingPermission({
                      workspace,
                      nodes: [
                        {
                          grant: targetGrant,
                          link: targetLink,
                          restricted: (boundaryBits & 1) !== 0,
                        },
                        {
                          grant: parentGrant,
                          link: parentLink,
                          restricted: (boundaryBits & 2) !== 0,
                        },
                        {
                          grant: grandparentGrant,
                          link: grandparentLink,
                          restricted: (boundaryBits & 4) !== 0,
                        },
                      ],
                    });

                    const highestActiveRank = decision.activeSources.reduce(
                      (highest, source) => Math.max(highest, rank(source.permission)),
                      0,
                    );
                    expect(rank(decision.permission)).toBe(highestActiveRank);
                    expect(decision.winningSources).toEqual(
                      decision.activeSources.filter(
                        (source) => rank(source.permission) === highestActiveRank,
                      ),
                    );
                    checked += 1;
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(55_296);
  }, 30_000);

  it('keeps target grants active through every boundary combination', () => {
    for (let boundaryBits = 0; boundaryBits < 8; boundaryBits += 1) {
      const decision = decideSharingPermission({
        workspace: 'admin',
        nodes: [
          { grant: 'edit', link: null, restricted: (boundaryBits & 1) !== 0 },
          { grant: null, link: null, restricted: (boundaryBits & 2) !== 0 },
          { grant: null, link: null, restricted: (boundaryBits & 4) !== 0 },
        ],
      });
      expect(decision.activeSources).toContainEqual({
        kind: 'grant',
        nodeIndex: 0,
        permission: 'edit',
      });
    }
  });

  it('activates the exact next-highest fallback when a winning source is removed', () => {
    const before = decideSharingPermission({
      workspace: 'view',
      nodes: [
        { grant: 'admin', link: null, restricted: false },
        { grant: 'edit', link: 'view', restricted: false },
      ],
    });
    const after = decideSharingPermission({
      workspace: 'view',
      nodes: [
        { grant: null, link: null, restricted: false },
        { grant: 'edit', link: 'view', restricted: false },
      ],
    });

    expect(before.permission).toBe('admin');
    expect(after.permission).toBe('edit');
  });
});

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sanitizeCanonicalYjsUpdate } from './collaborationProtocol';

describe('canonical wiki-link target metadata', () => {
  const targetId = '11111111-1111-1111-1111-111111111111';

  it('rejects an unresolved attribute update before its parent can integrate', () => {
    const attacker = new Y.Doc();
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('path', 'Roadmap');
    attacker.getXmlFragment('prosemirror').push([link]);
    const afterCreation = Y.encodeStateVector(attacker);

    link.setAttribute('targetId', targetId);
    const attributeOnlyUpdate = Y.encodeStateAsUpdate(attacker, afterCreation);
    expect(() => sanitizeCanonicalYjsUpdate(attributeOnlyUpdate)).toThrow(
      'Canonical Yjs state contains unresolved updates',
    );
  });

  it('preserves a stable targetId in canonical content', () => {
    const source = new Y.Doc();
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('targetId', targetId);
    link.setAttribute('path', '');
    link.setAttribute('label', 'Plan');
    source.getXmlFragment('prosemirror').push([link]);
    const canonicalState = sanitizeCanonicalYjsUpdate(Y.encodeStateAsUpdate(source));

    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, canonicalState);
    const loadedLink = loaded.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    expect(loadedLink.getAttribute('targetId')).toBe(targetId);
    expect(loadedLink.getAttribute('path')).toBe('');
    expect(loadedLink.getAttribute('label')).toBe('Plan');
  });
});

import { describe, expect, it } from 'vitest';

import {
  IMPORT_MODULE_CAPTURE,
  IMPORT_NAME_CAPTURE,
  INHERITANCE_EXTENDS_CAPTURE,
  INHERITANCE_IMPLEMENTS_CAPTURE,
  NAME_CAPTURE,
  parseCaptureName,
} from '../../src/extract/captures.js';

describe('parseCaptureName', () => {
  it.each([
    ['definition.class', { role: 'definition', kind: 'class' }],
    ['definition.trait', { role: 'definition', kind: 'trait' }],
    ['reference.call', { role: 'reference', kind: 'call' }],
    ['reference.some.dotted.kind', { role: 'reference', kind: 'some.dotted.kind' }],
    [NAME_CAPTURE, { role: 'name' }],
    [IMPORT_MODULE_CAPTURE, { role: 'importModule' }],
    [IMPORT_NAME_CAPTURE, { role: 'importName' }],
    [INHERITANCE_EXTENDS_CAPTURE, { role: 'inheritance', relation: 'extends' }],
    [INHERITANCE_IMPLEMENTS_CAPTURE, { role: 'inheritance', relation: 'implements' }],
  ])('maps @%s to its role', (name, role) => {
    expect(parseCaptureName(name)).toEqual(role);
  });

  it.each(['doc', 'local.scope', 'definition.', 'reference.', 'import', 'inheritance.mixes', ''])(
    'ignores @%s, a name outside the vocabulary',
    (name) => {
      expect(parseCaptureName(name)).toEqual({ role: 'ignored' });
    },
  );

  it('publishes the names the registry writes its queries in', () => {
    expect([
      NAME_CAPTURE,
      IMPORT_MODULE_CAPTURE,
      IMPORT_NAME_CAPTURE,
      INHERITANCE_EXTENDS_CAPTURE,
      INHERITANCE_IMPLEMENTS_CAPTURE,
    ]).toEqual([
      'name',
      'import.module',
      'import.name',
      'inheritance.extends',
      'inheritance.implements',
    ]);
  });
});

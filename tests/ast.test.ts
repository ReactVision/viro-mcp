/**
 * Tests for the AST extractor (indexer/ast.ts).
 *
 * These cover the four main component shapes we encounter in ReactViro:
 *   1. Type alias Props (`type ViroXProps = { ... }`)
 *   2. Interface Props
 *   3. Intersection types (`type Props = ViewProps & { ... }`)
 *   4. Files with no Props at all (extraction should return null)
 *
 * Plus malformed source that must not crash the extractor.
 */
import { describe, it, expect } from 'vitest';
import { extractApi, extractNamedType, classExtendsIdentifier } from '../indexer/ast.js';
import ts from 'typescript';

describe('extractApi', () => {

  it('extracts props + events from a type alias with JSDoc + @since', () => {
    const src = `
      import React, { Component } from 'react';
      type ViroBoxProps = {
        /** Size of the box along each axis (meters). */
        width?: number;
        /** Whether the box is interactable. @since 2.40.0 */
        canClick?: boolean;
        onClick?: (position: number[], source: string) => void;
      };
      export class ViroBox extends Component<ViroBoxProps> {}
    `;
    const api = extractApi(src, 'ViroBox.tsx');
    expect(api).not.toBeNull();
    expect(api!.props_type).toBe('ViroBoxProps');
    expect(api!.props.map(p => p.name).sort()).toEqual(['canClick', 'width']);
    const canClick = api!.props.find(p => p.name === 'canClick')!;
    expect(canClick.since).toBe('2.40.0');
    expect(canClick.description).toMatch(/interactable/);
    expect(api!.events.map(e => e.name)).toEqual(['onClick']);
    expect(api!.events[0]!.signature).toContain('=> void');
  });

  it('extracts from an interface declaration', () => {
    const src = `
      interface ViroSphereProps {
        /** Radius in meters. */
        radius?: number;
        position?: [number, number, number];
        onLoadEnd?: () => void;
      }
      export class ViroSphere extends Component<ViroSphereProps> {}
    `;
    const api = extractApi(src, 'ViroSphere.tsx');
    expect(api).not.toBeNull();
    expect(api!.props_type).toBe('ViroSphereProps');
    expect(api!.props.map(p => p.name).sort()).toEqual(['position', 'radius']);
    expect(api!.events.map(e => e.name)).toEqual(['onLoadEnd']);
  });

  it('handles intersection types — picks members from the type literal portion only', () => {
    const src = `
      type Props = ViewProps & {
        /** Texture source. */
        source?: any;
        width?: number;
        onError?: (event: any) => void;
      };
      export class ViroImage extends Component<Props> {}
    `;
    const api = extractApi(src, 'ViroImage.tsx');
    expect(api).not.toBeNull();
    // Should pick up only what's in the literal, not the inherited ViewProps.
    expect(api!.props.map(p => p.name).sort()).toEqual(['source', 'width']);
    expect(api!.events.map(e => e.name)).toEqual(['onError']);
  });

  it('returns null when no Props declaration is present', () => {
    const src = `
      export const VIRO_VERSION = '2.55.0';
      export function helper() {}
    `;
    expect(extractApi(src, 'Constants.tsx')).toBeNull();
  });

  it('does not throw on malformed source — returns either null or partial data', () => {
    const src = `
      type Props = {
        name: string
        age??
      };
    `;
    expect(() => extractApi(src, 'Broken.tsx')).not.toThrow();
  });

  it('respects the file basename when choosing between competing Props types', () => {
    // Two Props types: a generic one and a basename-matching one.
    // The basename match should win.
    const src = `
      type SomeOtherProps = { foo?: string };
      type ViroExampleProps = { bar?: number };
      export class ViroExample extends Component<ViroExampleProps> {}
    `;
    const api = extractApi(src, 'ViroExample.tsx');
    expect(api).not.toBeNull();
    expect(api!.props_type).toBe('ViroExampleProps');
    expect(api!.props.map(p => p.name)).toEqual(['bar']);
  });

  it('treats `on...` prop names as events, others as props', () => {
    const src = `
      type ViroFooProps = {
        position?: [number, number, number];
        onClick?: () => void;
        onHover?: (isHovering: boolean) => void;
        onceLoaded?: boolean;  // does NOT match onX naming convention strictly
      };
      export class ViroFoo extends Component<ViroFooProps> {}
    `;
    const api = extractApi(src, 'ViroFoo.tsx')!;
    expect(api.events.map(e => e.name).sort()).toEqual(['onClick', 'onHover']);
    expect(api.props.map(p => p.name).sort()).toEqual(['onceLoaded', 'position']);
  });

  // Regression coverage for the real bug reactviro_validate_scene shipped
  // with: every Viro component's common props (position, materials, onClick,
  // ...) arrive via `class X extends ViroBase<T>` (ViroBase's OWN heritage is
  // `extends React.Component<ViroBaseProps & T>`), not via `interface`
  // inheritance — which findPropsType/getMembers deliberately don't follow.
  // A component with no own props at all (`extends ViroBase<{}>`, e.g. the
  // real ViroBox/ViroNode) got null from extractApi and vanished from the
  // component index entirely, reported as an unknown component.
  describe('classExtendsIdentifier', () => {
    it('detects a direct extends of the named identifier', () => {
      const src = `export class ViroBox extends ViroBase<{}> {}`;
      const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      expect(classExtendsIdentifier(sf, 'ViroBase')).toBe(true);
    });

    it('returns false for classes extending something else', () => {
      const src = `export class Thing extends Component<{}> {}`;
      const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      expect(classExtendsIdentifier(sf, 'ViroBase')).toBe(false);
    });
  });

  describe('extractNamedType', () => {
    it('extracts a specifically-named type even when it is not the first Props-like type in the file', () => {
      const src = `
        export type ViroCommonProps = { opacity?: number; onClick?: () => void; };
        export type ViroObjectProps = { position?: [number, number, number]; materials?: string[]; };
      `;
      // findPropsType's heuristic would only ever find the FIRST "*Props"
      // type in a file — extractNamedType must reach the second one directly.
      const result = extractNamedType(src, 'ViroCommonProps.ts', 'ViroObjectProps');
      expect(result).not.toBeNull();
      expect(result!.props.map(p => p.name).sort()).toEqual(['materials', 'position']);
    });

    it('returns null when the named type does not exist', () => {
      const src = `export type Foo = { bar?: number };`;
      expect(extractNamedType(src, 'x.ts', 'DoesNotExist')).toBeNull();
    });
  });

  describe('extractApi with common props/events (ViroBase merge)', () => {
    const common = {
      props: [{ name: 'position', type: '[number, number, number]', optional: true }],
      events: [{ name: 'onClick', signature: '() => void' }],
    };

    it('merges common props/events into a ViroBase subclass that also has its own props', () => {
      const src = `
        type Props = { radius?: number; };
        export class ViroSphere extends ViroBase<Props> {}
      `;
      const api = extractApi(src, 'ViroSphere.tsx', common);
      expect(api).not.toBeNull();
      expect(api!.props.map(p => p.name).sort()).toEqual(['position', 'radius']);
      expect(api!.events.map(e => e.name)).toEqual(['onClick']);
      expect(api!.props_type).toBe('Props & ViroBaseProps');
    });

    it('returns common props alone for a ViroBase subclass with no own props (e.g. real ViroBox/ViroNode)', () => {
      const src = `export class ViroBox extends ViroBase<{}> {}`;
      const api = extractApi(src, 'ViroBox.tsx', common);
      expect(api).not.toBeNull();
      expect(api!.props.map(p => p.name)).toEqual(['position']);
      expect(api!.events.map(e => e.name)).toEqual(['onClick']);
    });

    it('does NOT merge common props into a class that does not extend ViroBase', () => {
      const src = `
        type Props = { text?: string; };
        export class NotAViroComponent extends Component<Props> {}
      `;
      const api = extractApi(src, 'NotAViroComponent.tsx', common);
      expect(api).not.toBeNull();
      expect(api!.props.map(p => p.name)).toEqual(['text']);
    });

    it('lets a component\'s own prop win over a same-named common one', () => {
      const src = `
        type Props = { position?: string; };
        export class Weird extends ViroBase<Props> {}
      `;
      const api = extractApi(src, 'Weird.tsx', common)!;
      const position = api.props.filter(p => p.name === 'position');
      expect(position).toHaveLength(1);
      expect(position[0]!.type).toBe('string'); // the own declaration, not common's
    });
  });

});

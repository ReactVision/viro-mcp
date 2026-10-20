/**
 * ast.ts — Extract a component's public API surface (props + events) from
 * its TypeScript source, using the TypeScript compiler API.
 *
 * The extractor is intentionally pragmatic: if anything fails it returns
 * `null` so the indexer can carry on. The resulting JSON is stored in the
 * files table's `props_json` and `events_json` columns and consumed by
 * the components tools at runtime.
 */
import ts from 'typescript';

export interface ExtractedProp {
  name:         string;
  type:         string;
  optional:     boolean;
  default?:     string;
  description?: string;
  since?:       string;
}

export interface ExtractedEvent {
  name:         string;
  signature:    string;
  description?: string;
}

export interface ExtractedApi {
  /** Source path the extraction came from (relative). Useful for debugging. */
  source_path?: string;
  /** Name of the Props type/interface that was parsed. */
  props_type?:  string;
  props:        ExtractedProp[];
  events:       ExtractedEvent[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nodeText(node: ts.Node, src: ts.SourceFile): string {
  return node.getText(src).replace(/\s+/g, ' ').trim();
}

function getJsDocCommentText(node: ts.Node): string | undefined {
  const jsDocs = (ts as unknown as { getJSDocCommentsAndTags(n: ts.Node): ts.Node[] }).getJSDocCommentsAndTags(node);
  if (!jsDocs || jsDocs.length === 0) return undefined;
  for (const d of jsDocs) {
    if (ts.isJSDoc(d)) {
      const c = typeof d.comment === 'string' ? d.comment : Array.isArray(d.comment) ? d.comment.map(p => ('text' in p ? p.text : '')).join('') : '';
      if (c) return c.trim();
    }
  }
  return undefined;
}

function getSinceTag(node: ts.Node): string | undefined {
  const tags = ts.getJSDocTags(node);
  for (const t of tags) {
    if (t.tagName.text === 'since') {
      return typeof t.comment === 'string' ? t.comment.trim() : undefined;
    }
  }
  return undefined;
}

/**
 * Find a candidate Props type/interface for a component file.
 * Preference order:
 *   1. Type/interface named <Basename>Props (e.g. ViroBoxProps)
 *   2. Type/interface named "Props"
 *   3. The type argument of the first `extends Component<X>` or `extends React.Component<X>`
 *   4. The type argument of `extends React.PureComponent<X>` / `extends PureComponent<X>`
 */
function findPropsType(src: ts.SourceFile, basename: string): { name: string; node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration } | null {
  const target = `${basename}Props`;
  let firstPropsAlias:    { name: string; node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration } | null = null;
  let exactMatch:         { name: string; node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration } | null = null;

  ts.forEachChild(src, (node) => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const n = node.name.text;
      if (n === target) exactMatch = { name: n, node };
      else if (n === 'Props' && !firstPropsAlias) firstPropsAlias = { name: n, node };
      else if (n.endsWith('Props') && !firstPropsAlias) firstPropsAlias = { name: n, node };
    }
  });

  if (exactMatch)      return exactMatch;
  if (firstPropsAlias) return firstPropsAlias;

  // Fallback: scan classes extending Component<X>
  let classGeneric: { name: string; node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration } | null = null;
  ts.forEachChild(src, (node) => {
    if (classGeneric) return;
    if (!ts.isClassDeclaration(node) || !node.heritageClauses) return;
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of clause.types) {
        const args = t.typeArguments;
        if (!args || args.length === 0) continue;
        const arg = args[0]!;
        if (ts.isTypeReferenceNode(arg) && ts.isIdentifier(arg.typeName)) {
          // Resolve the typeName to its declaration in the same source file
          const refName = arg.typeName.text;
          ts.forEachChild(src, (sib) => {
            if (classGeneric) return;
            if ((ts.isTypeAliasDeclaration(sib) || ts.isInterfaceDeclaration(sib)) && sib.name.text === refName) {
              classGeneric = { name: refName, node: sib };
            }
          });
        }
      }
    }
  });

  return classGeneric;
}

/**
 * Walk a TypeNode and pull out PropertySignature members from any
 * TypeLiteral inside (handles intersection types like `Foo & { ... }`).
 */
function collectMembersFromType(typeNode: ts.TypeNode): ts.TypeElement[] {
  const out: ts.TypeElement[] = [];
  const visit = (t: ts.TypeNode): void => {
    if (ts.isTypeLiteralNode(t)) {
      out.push(...t.members);
    } else if (ts.isIntersectionTypeNode(t)) {
      for (const sub of t.types) visit(sub);
    } else if (ts.isParenthesizedTypeNode(t)) {
      visit(t.type);
    }
  };
  visit(typeNode);
  return out;
}

/**
 * Extract members from a Props alias or interface.
 */
function getMembers(node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): ts.TypeElement[] {
  if (ts.isInterfaceDeclaration(node)) {
    // Direct members only — we don't follow heritage to avoid pulling React.Component bag.
    return [...node.members];
  }
  return collectMembersFromType(node.type);
}

/**
 * Parse a Props type and produce ExtractedProp[].
 */
function extractMembers(members: ts.TypeElement[], src: ts.SourceFile): ExtractedProp[] {
  const props: ExtractedProp[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    if (!m.name || !ts.isIdentifier(m.name)) continue;
    const name = m.name.text;
    const optional = !!m.questionToken;
    const type = m.type ? nodeText(m.type, src) : 'unknown';
    const description = getJsDocCommentText(m);
    const since = getSinceTag(m);
    const prop: ExtractedProp = { name, type, optional };
    if (description) prop.description = description;
    if (since)       prop.since = since;
    props.push(prop);
  }
  return props;
}

/** Detect event props by `^on[A-Z]` naming convention. */
function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

function splitPropsAndEvents(all: ExtractedProp[]): { props: ExtractedProp[]; events: ExtractedEvent[] } {
  const props: ExtractedProp[] = [];
  const events: ExtractedEvent[] = [];
  for (const p of all) {
    if (isEventProp(p.name)) {
      const e: ExtractedEvent = { name: p.name, signature: p.type };
      if (p.description) e.description = p.description;
      events.push(e);
    } else {
      props.push(p);
    }
  }
  return { props, events };
}

/**
 * Whether the class declared in this already-parsed source extends the
 * named identifier directly (e.g. `class ViroBox extends ViroBase<{}>`).
 * Exported for testing; extractApi calls this on its own already-parsed
 * sourceFile rather than re-parsing.
 */
export function classExtendsIdentifier(sourceFile: ts.SourceFile, identifierName: string): boolean {
  let result = false;
  ts.forEachChild(sourceFile, (node) => {
    if (result || !ts.isClassDeclaration(node) || !node.heritageClauses) return;
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of clause.types) {
        if (ts.isIdentifier(t.expression) && t.expression.text === identifierName) result = true;
      }
    }
  });
  return result;
}

/**
 * Extract members of a SPECIFICALLY NAMED type alias/interface (not the
 * "guess from filename" heuristic findPropsType uses) — for pulling
 * ViroCommonProps/ViroObjectProps out of AR/ViroCommonProps.ts once, up
 * front, so their members can be merged into every ViroBase subclass's own
 * extraction (see extractApi's `common` parameter and why: ViroBase<T>'s own
 * heritage is `extends React.Component<ViroBaseProps & T>` — the common
 * props arrive via the base class's generic parameter, not via `interface X
 * extends Y`, so findPropsType/getMembers (which deliberately don't follow
 * heritage) never see them on the subclass itself).
 */
export function extractNamedType(
  source: string,
  filename: string,
  typeName: string,
): { props: ExtractedProp[]; events: ExtractedEvent[] } | null {
  try {
    const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (found) return;
      if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === typeName) {
        found = node;
      }
    });
    if (!found) return null;
    const members = getMembers(found);
    if (members.length === 0) return null;
    return splitPropsAndEvents(extractMembers(members, sourceFile));
  } catch {
    return null;
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Extract props + events from a single component source file.
 * Returns null when nothing recognizable was found.
 *
 * `common`, when given, is merged into every class that `extends ViroBase`
 * (see extractNamedType's doc comment for why this needs special-casing
 * instead of just working through heritage resolution). A component's own
 * prop wins over a same-named common one; that only actually happens for a
 * handful of props ViroCommonProps/ViroObjectProps re-declare on themselves
 * (renderingOrder, visible, opacity, onCollision) — own-file wins there too,
 * arbitrarily but harmlessly, since the types agree.
 */
export function extractApi(
  source: string,
  filename: string,
  common?: { props: ExtractedProp[]; events: ExtractedEvent[] },
): ExtractedApi | null {
  try {
    const basename = filename.replace(/\.(tsx|ts)$/i, '').split('/').pop() ?? filename;
    const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TSX);

    const propsType = findPropsType(sourceFile, basename);
    const isViroBaseSubclass = common ? classExtendsIdentifier(sourceFile, 'ViroBase') : false;
    if (!propsType && !isViroBaseSubclass) return null;

    let props: ExtractedProp[] = [];
    let events: ExtractedEvent[] = [];
    let propsTypeName: string | undefined;

    if (propsType) {
      const members = getMembers(propsType.node);
      const split = splitPropsAndEvents(extractMembers(members, sourceFile));
      props = split.props;
      events = split.events;
      propsTypeName = propsType.name;
    }

    if (isViroBaseSubclass && common) {
      const ownProps  = new Set(props.map(p => p.name));
      const ownEvents = new Set(events.map(e => e.name));
      for (const p of common.props)  if (!ownProps.has(p.name))   props.push(p);
      for (const e of common.events) if (!ownEvents.has(e.name)) events.push(e);
      propsTypeName = propsTypeName ? `${propsTypeName} & ViroBaseProps` : 'ViroBaseProps';
    }

    if (props.length === 0 && events.length === 0) return null;

    return {
      source_path: filename,
      props_type:  propsTypeName,
      props,
      events,
    };
  } catch (e) {
    console.warn(`  ⚠ AST extraction failed for ${filename}: ${(e as Error).message}`);
    return null;
  }
}

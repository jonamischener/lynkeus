/**
 * The screen graph of a React Navigation app, read from its source. Routes are
 * declared on the navigator and implemented elsewhere, so a component is
 * resolved through the type checker, not by file name. Most navigations live in
 * shared components rather than screen files, so facts are recorded per file
 * and attributed to screens later through the import graph.
 */
import path from 'node:path';
import { Node, Project, SyntaxKind, type JsxAttribute, type SourceFile } from 'ts-morph';

import { packageName } from '../config.js';

import type { FileFacts, NavigationEdge, NavigationTrigger, ScreenGraph, ScreenNode, Selector, SourcePath } from './types.js';

// Only on a receiver that looks like the navigation object: `push` and `replace` are also Array and String methods.
const NAVIGATION_METHODS = new Set(['navigate', 'push', 'replace', 'reset']);

const isNavigationReceiver = (text: string): boolean => /(^|\.)nav(igation)?$/i.test(text.trim());

type ExtractOptions = {
  root: string;
  navigatorGlobs?: string[];
  /** First-party source, relative to the root. */
  sourceDir?: string;
};

export const extractScreenGraph = ({ root, navigatorGlobs = ['app/navigation/**/*.tsx'], sourceDir = 'app' }: ExtractOptions): ScreenGraph => {
  const warnings: string[] = [];
  const project = new Project({
    tsConfigFilePath: path.join(root, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });

  const rel = (file: SourceFile | string): SourcePath => path.relative(root, typeof file === 'string' ? file : file.getFilePath());

  const sourceRoot = path.join(root, sourceDir);
  const firstParty = project
    .getSourceFiles()
    .filter((f) => !f.getFilePath().includes('/node_modules/'))
    .filter((f) => f.getFilePath().startsWith(sourceRoot));

  const navigators = project.getSourceFiles(navigatorGlobs.map((g) => path.join(root, g))).filter((f) => !f.getFilePath().includes('/node_modules/'));

  if (navigators.length === 0) {
    warnings.push(`No navigator files matched ${navigatorGlobs.join(', ')}`);
  }

  const screens: Record<string, ScreenNode> = {};
  for (const navigator of navigators) {
    for (const { route, component } of screenDeclarations(navigator)) {
      if (!component) {
        warnings.push(`${rel(navigator)}: route "${route}" has no resolvable component`);
        continue;
      }

      if (screens[route]) {
        warnings.push(`Route "${route}" declared more than once; keeping the first`);
        continue;
      }

      const file = resolveComponentFile(navigator, component);
      if (!file) {
        warnings.push(`${rel(navigator)}: "${route}" -> <${component}> unresolved to a file`);
      }

      screens[route] = {
        route,
        component,
        file: file ? rel(file) : null,
        declaredIn: rel(navigator),
      };
    }
  }

  const files: Record<SourcePath, FileFacts> = {};
  for (const source of firstParty) {
    files[rel(source)] = {
      selectors: collectSelectors(source),
      navigates: collectNavigationEdges(source),
      ...collectImports(source, root),
    };
  }

  return {
    app: packageName(root),
    root,
    extractedAt: new Date().toISOString(),
    screens,
    files,
    warnings,
  };
};

type ScreenElement = { attr: (name: string) => JsxAttribute | undefined };

export type ScreenDeclaration = { route: string; component: string | null };

/** Routes in either of React Navigation's shapes: `<Stack.Screen name component />`, or `screens: { 'A.B': { screen: AB } }`. */
export const screenDeclarations = (source: SourceFile): ScreenDeclaration[] => {
  const out: ScreenDeclaration[] = [];
  for (const element of findScreenElements(source)) {
    const route = stringAttribute(element.attr('name'));
    if (route) out.push({ route, component: identifierAttribute(element.attr('component')) });
  }
  for (const prop of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const value = prop.getInitializer();
    if (!value || !Node.isObjectLiteralExpression(value)) continue;
    const screen = value.getProperty('screen');
    if (!screen || !Node.isPropertyAssignment(screen)) continue;
    const nameNode = prop.getNameNode();
    const route = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : Node.isIdentifier(nameNode) ? nameNode.getText() : null;
    if (!route) continue;
    // `params: { screen, params }` is React Navigation's nested-navigate payload, never a route.
    if (route === 'params' || route === 'initialParams') continue;
    const target = screen.getInitializer();
    if (!target) continue;
    if (Node.isCallExpression(target)) continue; // a nested navigator, not a screen
    // `params: { screen: 'X' }` is a navigate() payload naming a route, not a declaration.
    if (Node.isStringLiteral(target) || Node.isNoSubstitutionTemplateLiteral(target)) continue;
    out.push({ route, component: Node.isIdentifier(target) ? target.getText() : null });
  }
  return out;
};

/** `<Stack.Screen …>` / `<Tab.Screen …>`, self-closing or not. */
const findScreenElements = (source: SourceFile): ScreenElement[] => {
  const elements: ScreenElement[] = [];

  const consider = (tagName: string, attributes: JsxAttribute[]) => {
    if (!tagName.endsWith('.Screen') && tagName !== 'Screen') return;
    elements.push({ attr: (name) => attributes.find((a) => a.getNameNode().getText() === name) });
  };

  for (const node of source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
    consider(node.getTagNameNode().getText(), node.getAttributes().filter(Node.isJsxAttribute));
  }
  for (const node of source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
    consider(node.getTagNameNode().getText(), node.getAttributes().filter(Node.isJsxAttribute));
  }

  return elements;
};

const stringAttribute = (attr: JsxAttribute | undefined): string | null => {
  const initializer = attr?.getInitializer();
  if (!initializer) return null;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  if (Node.isJsxExpression(initializer)) {
    const expression = initializer.getExpression();
    if (expression && Node.isStringLiteral(expression)) return expression.getLiteralValue();
  }
  return null;
};

const identifierAttribute = (attr: JsxAttribute | undefined): string | null => {
  const initializer = attr?.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return null;
  const expression = initializer.getExpression();
  return expression && Node.isIdentifier(expression) ? expression.getText() : null;
};

const resolveComponentFile = (navigator: SourceFile, componentName: string): SourceFile | null => {
  const identifier = navigator.getDescendantsOfKind(SyntaxKind.Identifier).find((id) => id.getText() === componentName);
  if (!identifier) return null;

  for (const definition of identifier.getDefinitionNodes()) {
    const file = definition.getSourceFile();
    if (file.getFilePath().includes('/node_modules/')) continue;
    // A barrel re-export resolves to the export declaration itself; keep walking.
    if (Node.isExportSpecifier(definition) || Node.isExportDeclaration(definition)) continue;
    return file;
  }
  return null;
};

const collectSelectors = (source: SourceFile): Selector[] => {
  const selectors: Selector[] = [];
  for (const attr of source.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attr.getNameNode().getText() !== 'testID') continue;
    const id = stringAttribute(attr);
    if (!id) continue; // dynamic testID: the agent discovers it at runtime instead
    selectors.push({ id, line: attr.getStartLineNumber() });
  }
  return selectors;
};

const collectNavigationEdges = (source: SourceFile): NavigationEdge[] => {
  const handlerTriggers = mapHandlersToTriggers(source);
  const edges: NavigationEdge[] = [];

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (!NAVIGATION_METHODS.has(callee.getNameNode().getText())) continue;
    if (!isNavigationReceiver(callee.getExpression().getText())) continue;

    const target = call.getArguments()[0];
    if (!target) continue;

    const trigger = triggerFor(call, handlerTriggers);
    edges.push({
      ...(Node.isStringLiteral(target)
        ? { to: target.getLiteralValue(), confidence: 'static' as const }
        : {
            to: target.getText().replace(/\s+/g, ' ').slice(0, 120),
            confidence: 'dynamic' as const,
          }),
      line: call.getStartLineNumber(),
      via: trigger.via,
      ...(trigger.linkage ? { linkage: trigger.linkage } : {}),
    });
  }
  return edges;
};

const testIdOfElementOwning = (attribute: Node): NavigationTrigger | null => {
  const element = attribute.getFirstAncestor((a) => Node.isJsxSelfClosingElement(a) || Node.isJsxOpeningElement(a));
  if (!element) return null;

  const attributes = (Node.isJsxSelfClosingElement(element) || Node.isJsxOpeningElement(element) ? element.getAttributes() : []).filter(Node.isJsxAttribute);

  const testId = attributes.find((a) => a.getNameNode().getText() === 'testID');
  if (!testId) return null;

  const literal = stringAttribute(testId);
  if (literal) return { kind: 'testId', testId: literal };

  // Assembled at runtime (a list row keyed by item, a prop passed down): the device resolves it.
  const initializer = testId.getInitializer();
  return {
    kind: 'dynamicTestId',
    expression: (initializer?.getText() ?? '').replace(/\s+/g, ' ').slice(0, 80),
  };
};

// Separate from the one above: `getFirstAncestorByKind` does not match the node itself, so given an attribute it would look past it.
const owningElementTestId = (node: Node): NavigationTrigger | null => {
  const attribute = node.getFirstAncestorByKind(SyntaxKind.JsxAttribute);
  return attribute ? testIdOfElementOwning(attribute) : null;
};

/** `onPress={goToProfile}` on an element with `testID="profile-button"`: the handler's name to that testID, once per file. */
const mapHandlersToTriggers = (source: SourceFile): Map<string, NavigationTrigger> => {
  const handlers = new Map<string, NavigationTrigger>();

  for (const attribute of source.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const initializer = attribute.getInitializer();
    if (!initializer || !Node.isJsxExpression(initializer)) continue;

    const expression = initializer.getExpression();
    if (!expression || !Node.isIdentifier(expression)) continue;

    const trigger = testIdOfElementOwning(attribute);
    if (trigger) handlers.set(expression.getText(), trigger);
  }

  return handlers;
};

const triggerFor = (call: Node, handlers: Map<string, NavigationTrigger>): { via: NavigationTrigger; linkage?: 'element' | 'handler' } => {
  const direct = owningElementTestId(call);
  if (direct) return { via: direct, linkage: 'element' };

  const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const viaHandler = declaration && handlers.get(declaration.getName());
  if (viaHandler) return { via: viaHandler, linkage: 'handler' };

  return { via: { kind: 'unknown' } };
};

const localExports = new WeakMap<SourceFile, Set<string>>();

// The names a file defines itself, read from its syntax: no type checker, so a
// whole app resolves in the time it takes to parse it.
const exportedHere = (source: SourceFile): Set<string> => {
  const known = localExports.get(source);
  if (known) return known;
  const names = new Set<string>();
  for (const statement of source.getStatements()) {
    if (Node.isExportAssignment(statement)) names.add('default');
    if (Node.isExportDeclaration(statement)) {
      if (!statement.getModuleSpecifier()) for (const spec of statement.getNamedExports()) names.add(spec.getAliasNode()?.getText() ?? spec.getName());
      continue;
    }
    if (!Node.isExportable(statement) || !statement.isExported()) continue;
    if (statement.isDefaultExport()) names.add('default');
    if (Node.isVariableStatement(statement)) for (const d of statement.getDeclarations()) names.add(d.getName());
    else if (Node.hasName(statement)) names.add(statement.getName());
  }
  localExports.set(source, names);
  return names;
};

type ReExport = { target: SourceFile; namespace?: string; names?: Map<string, string> };
const reExports = new WeakMap<SourceFile, ReExport[]>();

const reExportsOf = (source: SourceFile): ReExport[] => {
  const known = reExports.get(source);
  if (known) return known;
  const list: ReExport[] = [];
  for (const declaration of source.getExportDeclarations()) {
    const target = declaration.getModuleSpecifierSourceFile();
    if (!target || target.getFilePath().includes('/node_modules/')) continue;
    const namespace = declaration.getNamespaceExport()?.getName();
    const named = declaration.getNamedExports();
    list.push({
      target,
      namespace,
      names: named.length ? new Map(named.map((spec) => [spec.getAliasNode()?.getText() ?? spec.getName(), spec.getName()])) : undefined,
    });
  }
  reExports.set(source, list);
  return list;
};

const defined = new WeakMap<SourceFile, Map<string, SourceFile | undefined>>();

/** The file that defines `name`, following re-exports from `source`; undefined when it cannot be told. */
const definingFile = (source: SourceFile, name: string, seen = new Set<SourceFile>()): SourceFile | undefined => {
  const memo = defined.get(source) ?? new Map<string, SourceFile | undefined>();
  defined.set(source, memo);
  if (memo.has(name)) return memo.get(name);
  if (seen.has(source)) return undefined;
  seen.add(source);
  const find = (): SourceFile | undefined => {
    if (exportedHere(source).has(name)) return source;
    for (const { target, namespace, names } of reExportsOf(source)) {
      if (namespace !== undefined) {
        if (namespace === name) return target;
        continue;
      }
      if (!names) {
        const found = definingFile(target, name, seen);
        if (found) return found;
        continue;
      }
      const original = names.get(name);
      if (original !== undefined) return definingFile(target, original, seen) ?? target;
    }
    return undefined;
  };
  const found = find();
  memo.set(name, found);
  return found;
};

/**
 * Import edges. A named import through a barrel (`import { useThing } from
 * '~hooks'`) points at the file that defines the name, not at the barrel:
 * otherwise a change to one hook reaches every screen that imports any hook.
 * The barrels passed through are kept apart, for when the barrel itself changes.
 */
export const collectImports = (source: SourceFile, root: string): { imports: SourcePath[]; barrels: SourcePath[] } => {
  const imports = new Set<SourcePath>();
  const barrels = new Set<SourcePath>();
  const own = (file: SourceFile | undefined): file is SourceFile => !!file && !file.getFilePath().includes('/node_modules/');
  const relative = (file: SourceFile) => path.relative(root, file.getFilePath());

  for (const declaration of source.getImportDeclarations()) {
    const target = declaration.getModuleSpecifierSourceFile();
    if (!own(target)) continue;
    const named = declaration.getNamedImports();
    if (named.length === 0 || declaration.getDefaultImport() || declaration.getNamespaceImport()) imports.add(relative(target));
    for (const spec of named) {
      const defined = definingFile(target, spec.getName());
      if (!defined || defined === target) imports.add(relative(target));
      else {
        imports.add(relative(defined));
        barrels.add(relative(target));
      }
    }
  }
  for (const declaration of source.getExportDeclarations()) {
    const target = declaration.getModuleSpecifierSourceFile();
    if (own(target)) imports.add(relative(target));
  }

  return { imports: [...imports], barrels: [...barrels].filter((b) => !imports.has(b)) };
};

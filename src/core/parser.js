const path = require('path');
const fs = require('fs-extra');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;
const TSX = require('tree-sitter-typescript').tsx;
const logger = require('../utils/logger');

/**
 * ARCHITECTURE NOTE:
 *
 * This parser module uses a single Parser instance that gets
 * re-configured per file. Why not create a new Parser per file?
 *
 * Tree-sitter's Parser is expensive to instantiate — it allocates
 * memory for the parse tree internally. Re-using one instance and
 * just swapping the language grammar is significantly faster when
 * processing dozens or hundreds of files.
 *
 * This pattern (expensive resource created once, reused many times)
 * is called the "Flyweight Pattern" in software design.
 */
const parser = new Parser();

/**
 * Map from file extension to Tree-sitter grammar.
 * When we encounter a .ts file, we use the TypeScript grammar.
 * When we encounter a .tsx file, we use the TSX grammar (TypeScript + JSX).
 *
 * Why separate TSX from TypeScript?
 * Because JSX syntax (the HTML-like tags in React) requires a different
 * grammar ruleset. TypeScript grammar would fail to parse <Component />.
 */
const GRAMMAR_MAP = {
  '.js':  JavaScript,
  '.jsx': JavaScript,   // Tree-sitter-javascript handles JSX natively
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.ts':  TypeScript,
  '.tsx': TSX,
};

/**
 * Parses a single file and extracts all documentable constructs.
 *
 * A "documentable construct" is anything a developer would write
 * documentation for: functions, classes, interfaces, type aliases,
 * API route handlers, React components.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<ParsedFile>} Structured extraction result
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const grammar = GRAMMAR_MAP[ext];

  if (!grammar) {
    logger.warn(`No grammar available for ${ext} files. Skipping: ${filePath}`);
    return { status: 'skipped', reason: 'unsupported_file_type', filePath };
  }

  // Read file contents
  let sourceCode;
  try {
    sourceCode = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    logger.warn(`Cannot read file: ${filePath} — ${error.message}`);
    return { status: 'skipped', reason: 'file_read_error', filePath };
  }

  // Skip empty files — nothing to document
  if (!sourceCode.trim()) {
    return { status: 'skipped', reason: 'empty_file', filePath };
  }

  // Configure the parser for this file's language
  parser.setLanguage(grammar);

  // Parse the source code into an AST.
  // Tree-sitter is synchronous — despite the async function wrapper,
  // this line blocks. We wrap in async because file reading is async
  // and callers expect a Promise interface for consistency.
  const tree = parser.parse(sourceCode);

  // Tree-sitter never throws on syntax errors — instead, it creates
  // ERROR nodes in the tree. We check for these and warn the user.
if (tree.rootNode && typeof tree.rootNode.hasError === "function" && tree.rootNode.hasError()) {
    logger.warn(`Syntax errors detected in ${path.basename(filePath)} — extraction may be incomplete`);
    // We continue parsing anyway — Tree-sitter recovers gracefully
    // and most of the file will still be correctly parsed
  }

  // Extract all constructs from the AST
  const constructs = extractConstructs(tree.rootNode, sourceCode, filePath);

  return {
    filePath,
    language: ext.replace('.', ''),
    constructCount: constructs.length,
    constructs,
    // Store a hash of the source code.
    // This is used by the drift detector in Part 3:
    // if the hash changes between runs, something changed.
    contentHash: hashContent(sourceCode),
    parsedAt: new Date().toISOString(),
  };
}

/**
 * Walks the AST and extracts all documentable constructs.
 *
 * This function uses a technique called "visitor pattern" —
 * we walk every node in the tree and for certain node types,
 * we "visit" them (extract information from them).
 *
 * The AST walk is depth-first, which means we process parent
 * nodes before their children. This matters because we need to
 * know if a function is inside a class (method) vs at the top
 * level (standalone function).
 *
 * @param {SyntaxNode} rootNode - The root node of the AST
 * @param {string} sourceCode - The original source code string
 * @param {string} filePath - File path for error reporting
 * @returns {Construct[]} Array of extracted constructs
 */
function extractConstructs(rootNode, sourceCode, filePath) {
  const constructs = [];

  // We use an iterative walk (stack-based) instead of recursion.
  // Why? Because deeply nested code can cause stack overflow errors
  // with recursive approaches. Real-world files can be thousands of
  // lines deep with heavy nesting. Iterative is safer.
  const stack = [rootNode];

  while (stack.length > 0) {
    const node = stack.pop();

    // For each node type we care about, extract information
    switch (node.type) {

      case 'function_declaration':
        constructs.push(extractFunction(node, sourceCode, 'function'));
        break;

      case 'export_statement': {
        // Export statements wrap other declarations:
        // export function foo() {}
        // export const foo = () => {}
        // export class Foo {}
        // export default function() {}
        const exported = extractExportedConstruct(node, sourceCode);
        if (exported) constructs.push(exported);
        break;
      }

      case 'class_declaration':
        constructs.push(extractClass(node, sourceCode));
        break;

      case 'lexical_declaration':
      case 'variable_declaration': {
        // These cover: const foo = () => {}
        // Arrow functions assigned to variables are extremely
        // common in modern JavaScript but aren't caught by
        // 'function_declaration' — they're a different AST node type
        const arrowFn = extractArrowFunction(node, sourceCode);
        if (arrowFn) constructs.push(arrowFn);
        break;
      }

      case 'expression_statement': {
        // Catches Express.js route patterns:
        // app.get('/users', handler)
        // router.post('/create', ...)
        const route = extractAPIRoute(node, sourceCode);
        if (route) constructs.push(route);
        break;
      }
    }

    // Push children onto the stack so they get processed.
    // We push in reverse order so the first child is processed first
    // (stack is LIFO — last in, first out)
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      // Skip nodes that are just punctuation or whitespace —
      // they have no semantic meaning and slow down the walk
      if (child && child.isNamed) {
        stack.push(child);
      }
    }
  }

  // Filter out nulls (from extractors that returned null for non-matches)
  // and constructs with no name (anonymous functions we can't document)
  return constructs.filter(c => c !== null && c.name);
}

/**
 * Extracts a named function declaration.
 *
 * Handles both:
 *   function createUser(email, password) {}
 *   async function fetchData(url) {}
 *
 * @param {SyntaxNode} node - The function_declaration AST node
 * @param {string} sourceCode - Full source code
 * @param {string} kind - 'function' | 'method'
 * @returns {Construct}
 */
function extractFunction(node, sourceCode, kind = 'function') {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');

  const name = nameNode ? nameNode.text : null;
  const params = paramsNode ? extractParameters(paramsNode) : [];
  const isAsync = node.children.some(child => child.type === 'async');
  const jsDoc = extractJSDoc(node, sourceCode);
  const returnType = extractReturnType(node);

  return {
    kind,
    name,
    params,
    isAsync,
    returnType,
    jsDoc,
    // Store line numbers for linking docs to specific lines
    location: {
      startLine: node.startPosition.row + 1,  // Tree-sitter is 0-indexed, humans are 1-indexed
      endLine: node.endPosition.row + 1,
    },
    // The raw signature as it appears in code — useful for the drift detector
    // to detect when a signature changes
    signature: buildSignature(name, params, isAsync, returnType),
  };
}

/**
 * Extracts an arrow function assigned to a variable.
 *
 * Handles:
 *   const createUser = (email, password) => {}
 *   const fetchData = async (url) => {}
 *   export const createUser = ...
 *
 * @param {SyntaxNode} node - lexical_declaration or variable_declaration node
 * @param {string} sourceCode
 * @returns {Construct|null}
 */
function extractArrowFunction(node, sourceCode) {
  // A variable declaration can have multiple declarators:
  // const a = 1, b = () => {}
  // We want the ones where the value is an arrow function
  for (const child of node.namedChildren) {
    if (child.type !== 'variable_declarator') continue;

    const valueNode = child.childForFieldName('value');
    if (!valueNode) continue;

    // Unwrap parenthesized expressions: const x = (() => {})
    const actualValue = valueNode.type === 'parenthesized_expression'
      ? valueNode.namedChild(0)
      : valueNode;

    if (!actualValue) continue;

    // Only interested in arrow functions
    if (actualValue.type !== 'arrow_function') continue;

    const nameNode = child.childForFieldName('name');
    const paramsNode = actualValue.childForFieldName('parameters');
    const isAsync = actualValue.children.some(c => c.type === 'async');
    const name = nameNode ? nameNode.text : null;
    const params = paramsNode ? extractParameters(paramsNode) : [];
    const jsDoc = extractJSDoc(node, sourceCode);
    const returnType = extractReturnType(actualValue);

    return {
      kind: 'arrow_function',
      name,
      params,
      isAsync,
      returnType,
      jsDoc,
      location: {
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      },
      signature: buildSignature(name, params, isAsync, returnType),
    };
  }

  return null;
}

/**
 * Extracts a class declaration and all its methods.
 *
 * Why extract the class AND its methods?
 * Because documentation for a class needs both:
 * - A class-level description (what does this class represent?)
 * - Method-level descriptions (what does each method do?)
 *
 * @param {SyntaxNode} node - class_declaration AST node
 * @param {string} sourceCode
 * @returns {Construct}
 */
function extractClass(node, sourceCode) {
  const nameNode = node.childForFieldName('name');
  const bodyNode = node.childForFieldName('body');
  const jsDoc = extractJSDoc(node, sourceCode);

  const methods = [];

  if (bodyNode) {
    for (const child of bodyNode.namedChildren) {
      // method_definition covers: constructor, regular methods, getters, setters
      if (child.type === 'method_definition') {
        const methodName = child.childForFieldName('name');
        const paramsNode = child.childForFieldName('parameters');
        const isStatic = child.children.some(c => c.type === 'static');
        const isAsync = child.children.some(c => c.type === 'async');
        const params = paramsNode ? extractParameters(paramsNode) : [];
        const returnType = extractReturnType(child);
        const methodJsDoc = extractJSDoc(child, sourceCode);

        methods.push({
          kind: 'method',
          name: methodName ? methodName.text : null,
          params,
          isStatic,
          isAsync,
          returnType,
          jsDoc: methodJsDoc,
          location: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          signature: buildSignature(
            methodName ? methodName.text : null,
            params,
            isAsync,
            returnType
          ),
        });
      }
    }
  }

  return {
    kind: 'class',
    name: nameNode ? nameNode.text : null,
    jsDoc,
    methods: methods.filter(m => m.name), // Remove unnamed methods
    location: {
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
    signature: `class ${nameNode ? nameNode.text : 'Anonymous'}`,
  };
}

/**
 * Extracts constructs from export statements.
 *
 * Export statements are wrappers around other declarations.
 * We detect the inner declaration type and delegate to the right extractor.
 *
 * Handles:
 *   export function foo() {}
 *   export const foo = () => {}
 *   export class Foo {}
 *   export default function() {}
 *
 * @param {SyntaxNode} node - export_statement AST node
 * @param {string} sourceCode
 * @returns {Construct|null}
 */
function extractExportedConstruct(node, sourceCode) {
  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'function_declaration':
        return { ...extractFunction(child, sourceCode), exported: true };

      case 'class_declaration':
        return { ...extractClass(child, sourceCode), exported: true };

      case 'lexical_declaration':
      case 'variable_declaration': {
        const arrow = extractArrowFunction(child, sourceCode);
        if (arrow) return { ...arrow, exported: true };
        break;
      }
    }
  }
  return null;
}

/**
 * Extracts Express.js / Fastify / Hapi API route definitions.
 *
 * This is one of DocSync's most powerful features — it can detect
 * API endpoints and document them automatically, similar to Swagger/OpenAPI
 * but without any annotations required.
 *
 * Detects patterns like:
 *   app.get('/users', handler)
 *   router.post('/users/:id', middleware, handler)
 *   app.delete('/users/:id', handler)
 *
 * @param {SyntaxNode} node - expression_statement AST node
 * @param {string} sourceCode
 * @returns {Construct|null}
 */
function extractAPIRoute(node, sourceCode) {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);

  // expression_statement > call_expression > member_expression
  const callExpr = node.namedChild(0);
  if (!callExpr || callExpr.type !== 'call_expression') return null;

  const memberExpr = callExpr.childForFieldName('function');
  if (!memberExpr || memberExpr.type !== 'member_expression') return null;

  const methodNode = memberExpr.childForFieldName('property');
  if (!methodNode) return null;

  const httpMethod = methodNode.text.toLowerCase();
  if (!HTTP_METHODS.has(httpMethod)) return null;

  // The first argument is the route path
  const argsNode = callExpr.childForFieldName('arguments');
  if (!argsNode || argsNode.namedChildCount === 0) return null;

  const firstArg = argsNode.namedChild(0);
  // Route path should be a string literal
  if (!firstArg || (firstArg.type !== 'string' && firstArg.type !== 'template_string')) return null;

  // Remove the quotes around the string: "'/users'" → "/users"
  const routePath = firstArg.text.replace(/^['"`]|['"`]$/g, '');

  // Get the object the method is called on (app, router, etc.)
  const objectNode = memberExpr.childForFieldName('object');
  const objectName = objectNode ? objectNode.text : 'router';

  return {
    kind: 'api_route',
    name: `${httpMethod.toUpperCase()} ${routePath}`,
    httpMethod: httpMethod.toUpperCase(),
    routePath,
    objectName,
    params: [],  // Route params extracted from path (e.g., :id from /users/:id)
    pathParams: extractPathParams(routePath),
    jsDoc: extractJSDoc(node, sourceCode),
    location: {
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
    signature: `${objectName}.${httpMethod}('${routePath}', ...)`,
  };
}

/**
 * Extracts path parameters from a route string.
 * '/users/:id/posts/:postId' → ['id', 'postId']
 *
 * @param {string} routePath
 * @returns {string[]}
 */
function extractPathParams(routePath) {
  const matches = routePath.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return matches ? matches.map(m => m.slice(1)) : [];
}

/**
 * Extracts parameters from a parameter list node.
 *
 * Handles:
 *   (a, b, c)                    - simple params
 *   (a = 'default', b)           - default values
 *   ({ email, password })        - destructured objects
 *   (...args)                    - rest parameters
 *   (email: string, age: number) - TypeScript type annotations
 *
 * @param {SyntaxNode} paramsNode
 * @returns {Parameter[]}
 */
function extractParameters(paramsNode) {
  const params = [];

  for (const child of paramsNode.namedChildren) {
    switch (child.type) {
      case 'identifier':
        params.push({ name: child.text, type: null, defaultValue: null });
        break;

      case 'assignment_pattern': {
        // param = defaultValue
        const nameNode = child.childForFieldName('left');
        const defaultNode = child.childForFieldName('right');
        params.push({
          name: nameNode ? nameNode.text : '?',
          type: null,
          defaultValue: defaultNode ? defaultNode.text : null,
        });
        break;
      }

      case 'rest_pattern': {
        // ...args
        const restName = child.namedChild(0);
        params.push({
          name: restName ? `...${restName.text}` : '...args',
          type: null,
          defaultValue: null,
          isRest: true,
        });
        break;
      }

      case 'object_pattern':
        // { email, password } — destructured
        params.push({
          name: child.text,  // Keep the full destructure pattern as the name
          type: null,
          defaultValue: null,
          isDestructured: true,
        });
        break;

      case 'required_parameter':
      case 'optional_parameter': {
        // TypeScript: email: string  OR  name?: string
        const paramName = child.childForFieldName('pattern');
        const typeAnnotation = child.childForFieldName('type');
        params.push({
          name: paramName ? paramName.text : '?',
          type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null,
          defaultValue: null,
          isOptional: child.type === 'optional_parameter',
        });
        break;
      }
    }
  }

  return params;
}

/**
 * Extracts the TypeScript return type annotation if present.
 *
 * function foo(): Promise<User>  → 'Promise<User>'
 * const bar = (): void => {}     → 'void'
 * function baz() {}              → null (no annotation)
 *
 * @param {SyntaxNode} node
 * @returns {string|null}
 */
function extractReturnType(node) {
  const returnTypeNode = node.childForFieldName('return_type');
  if (!returnTypeNode) return null;
  // Strip the leading colon and whitespace: ": Promise<User>" → "Promise<User>"
  return returnTypeNode.text.replace(/^:\s*/, '').trim();
}

/**
 * Extracts the JSDoc comment immediately preceding a node.
 *
 * JSDoc comments look like:
 *   /**
 *    * Creates a new user in the database.
 *    * @param {string} email - The user's email address
 *    * @param {string} password - The user's password
 *    * @returns {Promise<User>} The created user object
 *    *\/
 *
 * Tree-sitter doesn't automatically associate comments with nodes —
 * we have to find the comment that appears immediately before our node.
 *
 * @param {SyntaxNode} node
 * @param {string} sourceCode
 * @returns {JSDoc|null}
 */
function extractJSDoc(node, sourceCode) {
  // Look at the lines immediately before this node
  const startLine = node.startPosition.row;
  if (startLine === 0) return null;

  // Get the source lines
  const lines = sourceCode.split('\n');

  // Walk backwards from the node's start line looking for a JSDoc block
  let endCommentLine = startLine - 1;

  // Skip blank lines between comment and function
  while (endCommentLine >= 0 && lines[endCommentLine].trim() === '') {
    endCommentLine--;
  }

  // Check if this line ends a JSDoc block
  if (endCommentLine < 0 || !lines[endCommentLine].trim().endsWith('*/')) {
    return null;
  }

  // Walk back to find the start of the JSDoc block
  let startCommentLine = endCommentLine;
  while (startCommentLine >= 0 && !lines[startCommentLine].trim().startsWith('/**')) {
    startCommentLine--;
  }

  if (startCommentLine < 0) return null;

  // Extract the raw comment block
  const rawComment = lines
    .slice(startCommentLine, endCommentLine + 1)
    .join('\n');

  return parseJSDoc(rawComment);
}

/**
 * Parses a raw JSDoc string into a structured object.
 *
 * @param {string} raw - Raw JSDoc comment string
 * @returns {JSDoc}
 */
function parseJSDoc(raw) {
  // Strip comment markers: /**, *\/, and leading * on each line
  const cleaned = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim();

  const lines = cleaned.split('\n');
  const tags = [];
  const descriptionLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@')) {
      // Parse tag: @param {string} email - The email address
      const tagMatch = trimmed.match(/^@(\w+)\s*(?:\{([^}]+)\})?\s*([^\s-]+)?\s*(?:-\s*(.*))?$/);
      if (tagMatch) {
        tags.push({
          tag: tagMatch[1],       // 'param', 'returns', 'throws', etc.
          type: tagMatch[2],      // '{string}' → 'string'
          name: tagMatch[3],      // 'email'
          description: tagMatch[4] || '', // 'The email address'
        });
      }
    } else {
      descriptionLines.push(trimmed);
    }
  }

  return {
    description: descriptionLines.filter(Boolean).join(' ').trim(),
    params: tags.filter(t => t.tag === 'param'),
    returns: tags.find(t => t.tag === 'returns' || t.tag === 'return') || null,
    throws: tags.filter(t => t.tag === 'throws'),
    examples: tags.filter(t => t.tag === 'example').map(t => t.description),
  };
}

/**
 * Builds a normalized function signature string.
 * This is what the drift detector hashes and compares between runs.
 *
 * Example output: "async createUser(email, password): Promise<User>"
 *
 * @param {string} name
 * @param {Parameter[]} params
 * @param {boolean} isAsync
 * @param {string|null} returnType
 * @returns {string}
 */
function buildSignature(name, params, isAsync, returnType) {
  const asyncPrefix = isAsync ? 'async ' : '';
  const paramStr = params.map(p => {
    let str = p.name;
    if (p.type) str += `: ${p.type}`;
    if (p.defaultValue) str += ` = ${p.defaultValue}`;
    return str;
  }).join(', ');
  const returnStr = returnType ? `: ${returnType}` : '';
  return `${asyncPrefix}${name}(${paramStr})${returnStr}`;
}

/**
 * Creates a simple hash of file content for drift detection.
 * We use a simple approach here — in production, you could use SHA-256,
 * but for our purposes a quick hash is sufficient.
 *
 * @param {string} content
 * @returns {string}
 */
function hashContent(content) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Parses all files found by the scanner.
 *
 * @param {string[]} files - Array of absolute file paths
 * @returns {Promise<ParsedFile[]>} Array of parsed file results
 */
async function parseFiles(files) {
  const results = [];
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const filePath of files) {
    try {
      const result = await parseFile(filePath);
      if (!result) {
        failCount++;
      } else if (result.status === 'skipped') {
        skipCount++;
        logger.info(`Skipped: ${filePath}`);
      } else {
        results.push(result);
        successCount++;
      }
    } catch (err) {
      if (logger.error) {
        logger.error(`Failed to parse ${filePath}: ${err.message}`);
      } else {
        logger.warn(`Failed to parse ${filePath}: ${err.message}`);
      }
      failCount++;
    }
  }

  logger.success(`Parsed ${successCount} file(s) successfully`);
  if (skipCount > 0) {
    if (logger.info) logger.info(`${skipCount} file(s) were skipped`);
    else console.log(`${skipCount} file(s) were skipped`);
  }
  if (failCount > 0) {
    logger.warn(`${failCount} file(s) could not be parsed`);
  }

  return results;
}

module.exports = { parseFile, parseFiles };
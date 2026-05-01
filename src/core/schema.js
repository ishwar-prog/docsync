'use strict';

/**
 * DOCUMENTATION SCHEMA
 *
 * This module defines the contract between Claude's output and DocSync's
 * rendering system. Every piece of documentation Claude generates must
 * conform to this schema.
 *
 * WHY A SCHEMA INSTEAD OF FREE-FORM TEXT?
 *
 * Free-form text output from an LLM is non-deterministic in structure.
 * One run might produce a paragraph, another a bullet list, another
 * a table. Your rendering code cannot reliably parse non-deterministic
 * structure.
 *
 * A JSON schema gives you:
 * 1. Deterministic field access: doc.description, doc.params[0].description
 * 2. Validation: you can check required fields are present
 * 3. Versioning: you can evolve the schema without breaking old docs
 * 4. Rendering flexibility: same data can render as Markdown, MDX, HTML
 *
 * This is the same approach used by Stripe (API response schemas),
 * OpenAPI (endpoint schemas), and GraphQL (type schemas).
 */

/**
 * Schema for a single parameter's documentation.
 */
const PARAM_DOC_SCHEMA = {
  name: 'string',           // Parameter name exactly as in code
  type: 'string',           // TypeScript type or inferred type
  description: 'string',    // What this parameter does
  required: 'boolean',      // Is it required or optional?
  defaultValue: 'string',   // Default value if any (null if none)
  example: 'string',        // A concrete example value
};

/**
 * Schema for a function/method's documentation.
 */
const FUNCTION_DOC_SCHEMA = {
  summary: 'string',          // One sentence: what this function does
  description: 'string',      // 2-4 sentences: why it exists, when to use it
  params: [PARAM_DOC_SCHEMA], // Array of parameter docs
  returns: {
    type: 'string',           // Return type
    description: 'string',    // What is returned and when
  },
  throws: [{
    type: 'string',           // Error type (e.g., 'TypeError', 'ApiError')
    condition: 'string',      // When this error is thrown
  }],
  example: 'string',          // A complete, runnable code example
  sideEffects: 'string',      // Network calls, DB writes, file I/O, etc. (null if pure)
  complexity: 'string',       // 'O(1)', 'O(n)', etc. (null if trivial)
};

/**
 * Schema for an API route's documentation.
 */
const ROUTE_DOC_SCHEMA = {
  summary: 'string',          // One sentence describing the endpoint
  description: 'string',      // What this endpoint does, when to use it
  method: 'string',           // HTTP method
  path: 'string',             // Route path with params
  pathParams: [{
    name: 'string',
    type: 'string',
    description: 'string',
  }],
  queryParams: [{
    name: 'string',
    type: 'string',
    description: 'string',
    required: 'boolean',
  }],
  requestBody: {
    description: 'string',
    example: 'string',        // JSON example
  },
  responses: [{
    status: 'number',         // HTTP status code
    description: 'string',
    example: 'string',        // JSON example response
  }],
  authentication: 'string',   // Auth requirement (null if public)
  rateLimit: 'string',        // Rate limit info (null if unknown)
};

/**
 * Schema for a class's documentation.
 */
const CLASS_DOC_SCHEMA = {
  summary: 'string',
  description: 'string',
  constructor: FUNCTION_DOC_SCHEMA,
  responsibilities: ['string'], // List of what this class is responsible for
  usage: 'string',              // How to instantiate and use this class
};

/**
 * Top-level schema for a complete documentation generation result.
 */
const DOCUMENTATION_RESULT_SCHEMA = {
  fileOverview: 'string',       // 2-3 sentences describing the module's purpose
  constructs: [{
    key: 'string',              // 'kind:name' identifier matching snapshot key
    kind: 'string',             // 'function' | 'class' | 'api_route' | 'arrow_function'
    name: 'string',
    documentation: {},          // FUNCTION_DOC_SCHEMA | ROUTE_DOC_SCHEMA | CLASS_DOC_SCHEMA
  }],
  generatedAt: 'string',        // ISO timestamp
  model: 'string',              // Which Claude model generated this
  tokenUsage: {
    inputTokens: 'number',
    outputTokens: 'number',
  },
};

/**
 * Validates a documentation result against the expected schema.
 * Returns an array of validation errors (empty if valid).
 *
 * We validate Claude's output before using it — never trust
 * any external system's output blindly, including an LLM.
 *
 * @param {object} result - The parsed JSON from Claude
 * @returns {string[]} Array of error messages
 */
function validateDocumentationResult(result) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    errors.push('Result must be an object');
    return errors;
  }

  if (!result.fileOverview || typeof result.fileOverview !== 'string') {
    errors.push('Missing or invalid: fileOverview');
  }

  if (!Array.isArray(result.constructs)) {
    errors.push('Missing or invalid: constructs (must be array)');
    return errors;
  }

  for (let i = 0; i < result.constructs.length; i++) {
    const construct = result.constructs[i];

    if (!construct.key) errors.push(`constructs[${i}]: missing key`);
    if (!construct.kind) errors.push(`constructs[${i}]: missing kind`);
    if (!construct.name) errors.push(`constructs[${i}]: missing name`);
    if (!construct.documentation) errors.push(`constructs[${i}]: missing documentation`);

    if (construct.documentation) {
      if (!construct.documentation.summary) {
        errors.push(`constructs[${i}] (${construct.name}): missing summary`);
      }
      if (!construct.documentation.description) {
        errors.push(`constructs[${i}] (${construct.name}): missing description`);
      }
    }
  }

  return errors;
}

module.exports = {
  FUNCTION_DOC_SCHEMA,
  ROUTE_DOC_SCHEMA,
  CLASS_DOC_SCHEMA,
  DOCUMENTATION_RESULT_SCHEMA,
  validateDocumentationResult,
};
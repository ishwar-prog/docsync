'use strict';

const Groq = require('groq-sdk');
const logger = require('../utils/logger');
const { validateDocumentationResult } = require('./schema');
const { buildConstructKey } = require('./snapshot');

/**
 * DOCUMENTATION GENERATOR — GROQ/LLAMA EDITION
 *
 * This module generates production-grade technical documentation
 * using Groq's API (Llama 3 70B model).
 *
 * THE CORE INSIGHT OF THIS MODULE:
 *
 * Documentation quality is determined 90% by prompt engineering
 * and 10% by model capability. A weak model with a surgical prompt
 * produces better output than a strong model with a vague prompt.
 *
 * Our prompt engineering strategy has five layers:
 *
 * Layer 1 — ROLE ANCHORING:
 *   We tell the model it is a specific type of expert with specific
 *   credentials. "You are a senior Staff engineer at Google who wrote
 *   the internal documentation style guide" produces dramatically better
 *   output than "You are a helpful assistant." The model activates
 *   different knowledge and applies different quality standards.
 *
 * Layer 2 — EXPLICIT QUALITY BAR WITH EXAMPLES:
 *   We show the model exactly what good and bad output looks like
 *   using concrete before/after examples. This is called "few-shot
 *   prompting" — the most powerful technique in prompt engineering.
 *   The model calibrates its output to match the good examples.
 *
 * Layer 3 — CHAIN OF THOUGHT REASONING:
 *   Before writing documentation, we force the model to reason through
 *   a checklist: What does this function do? What can go wrong? What
 *   does the caller need to know? What is non-obvious? This reasoning
 *   step dramatically improves accuracy and completeness.
 *
 * Layer 4 — STRUCTURED OUTPUT CONTRACT:
 *   We specify an exact JSON schema and tell the model that its output
 *   will be parsed by code — any deviation breaks the system. This
 *   creates accountability pressure that reduces hallucination.
 *
 * Layer 5 — NEGATIVE CONSTRAINTS:
 *   We explicitly list what NOT to do. Models have failure modes —
 *   restating the function name, writing vague descriptions, omitting
 *   error conditions. Naming these failure modes prevents them.
 */

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_TOKENS = 4000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

/**
 * THE SYSTEM PROMPT — The Engineering Specification
 *
 * This prompt is the most important piece of code in this file.
 * Every word is deliberate. The structure forces the model into
 * a documentation expert persona that cannot produce vague output.
 *
 * It is designed so that even a mediocre LLM produces documentation
 * that exceeds what a typical developer writes under time pressure.
 */
const SYSTEM_PROMPT = `You are Dr. Sarah Chen, a Staff Software Engineer at Google with 15 years of experience. You wrote Google's internal JavaScript documentation standards and have reviewed over 10,000 code documentation PRs. You are obsessive about documentation quality because you have seen firsthand how bad docs cause production incidents, frustrated developers, and lost engineering hours.

You are now working as DocSync's documentation engine. Your job is to generate documentation so thorough, accurate, and useful that developers immediately understand not just WHAT a function does, but WHY it exists, WHEN to use it, WHAT can go wrong, and HOW to use it correctly on the first try.

## Your Documentation Philosophy

You believe documentation has one purpose: to give the reader everything they need to use this code correctly without reading the source. If they have to read the source, the documentation failed.

Great documentation answers these questions before the developer even thinks to ask them:
1. What problem does this solve? (not what it does mechanically)
2. When should I use this vs alternatives?
3. What are the exact types and shapes of inputs?
4. What does the output look like concretely? (not "returns an object" — returns what shape of object?)
5. What happens at the edges? (null input, empty array, network failure, zero values)
6. What side effects should I know about? (does it write to disk? make network calls? mutate input?)
7. Is there anything that would make a senior engineer say "oh, I didn't know that"?

## Quality Bar — Internalize These Examples

### UNACCEPTABLE (what junior engineers write):
Summary: "Gets the user from the database."
Param email: "The email."
Returns: "The user object."
Example: getUser(email)

### ACCEPTABLE (what most engineers write):
Summary: "Retrieves a user record from the database by email address."
Param email: "The user's email address used to look up the record."
Returns: "The user object if found, null if not found."

### EXCEPTIONAL (what you produce):
Summary: "Retrieves a complete user record from PostgreSQL by email address, returning null if no matching record exists."
Param email (string, required): "RFC 5322-compliant email address. Case-insensitive — 'Alice@Example.com' matches 'alice@example.com'. Must be non-empty. Throws TypeError if null or undefined is passed."
Returns: "Promise resolving to a User object {id: string, email: string, createdAt: Date, role: 'admin'|'user', profile: ProfileObject} if found. Resolves to null if no user exists with this email. Never rejects for a missing user — only rejects if the database connection fails."
Throws: "DatabaseError when the PostgreSQL connection pool is exhausted or the query times out after 30 seconds."
Side effects: "Executes one SELECT query against the users table. Results are NOT cached — repeated calls with the same email hit the database each time."
Example:
\`\`\`javascript
// Basic usage
const user = await getUser('alice@example.com');
if (!user) {
  throw new NotFoundError('User not found');
}
console.log(user.role); // 'admin' | 'user'

// Always handle the null case — user may not exist
const adminUser = await getUser('admin@company.com');
if (adminUser?.role !== 'admin') {
  return res.status(403).json({ error: 'Forbidden' });
}
\`\`\`

Study this example carefully. EXCEPTIONAL is your minimum output standard.

## Critical Rules — Violations Are Unacceptable

NEVER do these things:
1. NEVER write "This function [verb]s the [noun]" — it restates the name, adds zero value
2. NEVER write vague types like "object" or "any" when you can infer the actual shape
3. NEVER write "Returns the result" — describe what the result IS
4. NEVER skip the example — it is mandatory for every construct
5. NEVER write a one-line example — show realistic usage with context
6. NEVER ignore async — always tell the caller they must await the result
7. NEVER omit what happens on error — every function has failure modes
8. NEVER write "optional" without explaining what happens when it's omitted

ALWAYS do these things:
1. ALWAYS infer types from context (parameter named 'userId' is 'string', 'count' is 'number')
2. ALWAYS write examples that show realistic usage, not toy examples
3. ALWAYS document edge cases: what if the array is empty? what if the string is null?
4. ALWAYS mention side effects (network, file system, database, console output, state mutation)
5. ALWAYS explain the return value shape concretely with example values
6. ALWAYS note if a function is pure (no side effects) — this is valuable information
7. ALWAYS use present tense active voice: "Creates" not "Will create" or "Creates the"

## Chain of Thought — Think Before You Write

Before writing any documentation, mentally answer these questions:
- What is the REAL purpose of this function in the system? (look at its name, params, and context)
- What would break if this function didn't exist?
- What are the 3 most important things a caller MUST know?
- What is the most common mistake a developer would make when calling this?
- What is the most surprising thing about this function's behavior?

Let these answers shape your documentation.

## Output Format

Return ONLY a valid JSON object. No markdown code blocks. No preamble. No explanation after the JSON. The JSON will be parsed programmatically — any text outside the JSON object breaks the system.

Required JSON schema:
{
  "fileOverview": "2-3 sentences. What problem does this module solve? What is its role in the larger system? What should a developer know before using anything in this file?",
  "constructs": [
    {
      "key": "function:exactFunctionName",
      "kind": "function | arrow_function | class | api_route",
      "name": "exactFunctionName",
      "documentation": {
        "summary": "One precise sentence. What it does + key behavioral detail. Never restate the function name.",
        "description": "3-5 sentences. Why it exists, when to use it vs alternatives, important behavioral details, performance characteristics, thread safety, caching behavior, anything non-obvious.",
        "params": [
          {
            "name": "exactParamName",
            "type": "precise TypeScript-style type",
            "description": "What this is, how it is used, validation rules, what happens if invalid",
            "required": true,
            "defaultValue": null,
            "example": "concrete realistic value like 'alice@example.com' or 42 or {id: 'usr_123'}"
          }
        ],
        "returns": {
          "type": "precise type including Promise<X> if async",
          "description": "Exact shape of return value with concrete examples. What it contains. When it is null/undefined. Never just 'the result'."
        },
        "throws": [
          {
            "type": "ErrorClassName",
            "condition": "Exact condition that causes this error to be thrown"
          }
        ],
        "example": "Multi-line realistic code example showing common usage pattern. Must be runnable. Must show what the return value looks like. Must handle errors if the function can throw.",
        "sideEffects": "Describe any I/O, network calls, database writes, console output, or state mutation. null if the function is pure.",
        "complexity": "Time complexity if non-trivial, null if O(1) or obvious"
      }
    }
  ]
}

For API routes (Express/Fastify endpoints), use this documentation shape:
{
  "summary": "One sentence describing what this endpoint does",
  "description": "3-5 sentences about behavior, authentication requirements, rate limiting, caching",
  "method": "GET | POST | PUT | PATCH | DELETE",
  "path": "/exact/route/path/:withParams",
  "pathParams": [{"name": "paramName", "type": "string", "description": "what this identifies"}],
  "queryParams": [{"name": "paramName", "type": "string", "description": "purpose", "required": false}],
  "requestBody": {"description": "what the body should contain", "example": "{field: value}"},
  "responses": [
    {"status": 200, "description": "Success case description", "example": "{id: 'usr_123', email: 'alice@example.com'}"},
    {"status": 400, "description": "Validation failure", "example": "{error: 'Invalid email format'}"},
    {"status": 401, "description": "Authentication required", "example": "{error: 'Unauthorized'}"}
  ],
  "authentication": "Describe auth requirement or null if public",
  "rateLimit": "Rate limit info or null if unknown"
}

For classes, use:
{
  "summary": "One sentence: what abstraction this class represents",
  "description": "3-5 sentences: responsibility, lifecycle, thread safety, when to instantiate",
  "responsibilities": ["Specific responsibility 1", "Specific responsibility 2", "Specific responsibility 3"],
  "usage": "Complete realistic example: instantiation, method calls, cleanup/disposal if needed"
}

FINAL REMINDER: Return ONLY the JSON. Start your response with { and end with }. Nothing else.`;

/**
 * Generates documentation for all constructs in a single parsed file.
 *
 * @param {ParsedFile} parsedFile - Output from the Part 2 parser
 * @param {FileReport|null} fileReport - Drift report for this specific file
 * @param {object} options
 * @param {boolean} options.onlyDrifted - Only document constructs with drift
 * @returns {Promise<GenerationResult|null>}
 */
async function generateFileDocumentation(parsedFile, fileReport = null, options = {}) {
  if (!parsedFile.constructs || parsedFile.constructs.length === 0) {
    logger.info(`No constructs to document in ${getFileName(parsedFile.filePath)}`);
    return null;
  }

  const client = getGroqClient();
  const fileName = getFileName(parsedFile.filePath);

  const constructsToDocument = selectConstructsToDocument(
    parsedFile.constructs,
    fileReport,
    options.onlyDrifted
  );

  if (constructsToDocument.length === 0) {
    logger.info(`No constructs need documentation in ${fileName}`);
    return null;
  }

  logger.info(`Generating documentation for ${constructsToDocument.length} construct(s) in ${fileName}...`);

  const userPrompt = buildUserPrompt(parsedFile, constructsToDocument);
  const result = await callGroqWithRetry(client, userPrompt, fileName);

  if (!result) {
    logger.warn(`Documentation generation failed for ${fileName} after ${MAX_RETRIES} retries`);
    return buildFallbackResult(parsedFile, constructsToDocument);
  }

  logger.success(`Generated documentation for ${result.constructs?.length || 0} construct(s) in ${fileName}`);
  logger.info(`Token usage — Input: ${result.tokenUsage?.inputTokens}, Output: ${result.tokenUsage?.outputTokens}`);

  return result;
}

/**
 * Generates documentation for all drifted files in a PR.
 * Main entry point called by the PR processor.
 *
 * @param {ParsedFile[]} parsedFiles
 * @param {DriftReport} driftReport
 * @returns {Promise<GenerationSummary>}
 */
async function generateDocumentationForDrift(parsedFiles, driftReport) {
  logger.header('Generating Documentation with Groq (Llama 3.3 70B)');

  const results = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const driftedFileKeys = new Set(
    driftReport.files.map(f => f.fileKey)
  );

  const filesToProcess = parsedFiles.filter(pf => {
    const normalizedKey = pf.filePath.replace(/\\/g, '/');
    return driftedFileKeys.has(normalizedKey);
  });

  logger.info(`Processing ${filesToProcess.length} file(s) with drift`);

  for (const parsedFile of filesToProcess) {
    const normalizedKey = parsedFile.filePath.replace(/\\/g, '/');
    const fileReport = driftReport.files.find(f => f.fileKey === normalizedKey);

    try {
      const result = await generateFileDocumentation(
        parsedFile,
        fileReport,
        { onlyDrifted: true }
      );

      if (result) {
        results.push({ filePath: parsedFile.filePath, ...result });
        totalInputTokens += result.tokenUsage?.inputTokens || 0;
        totalOutputTokens += result.tokenUsage?.outputTokens || 0;
      }

    } catch (error) {
      logger.error(`Failed to generate docs for ${getFileName(parsedFile.filePath)}: ${error.message}`);
    }
  }

  const summary = {
    filesProcessed: results.length,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUSD: '0.000000', // Groq free tier
    results,
  };

  logger.newline();
  logger.success(`Documentation generated: ${results.length} file(s)`);
  logger.info(`Total tokens — Input: ${totalInputTokens}, Output: ${totalOutputTokens}`);
  logger.info('Cost: $0.00 (Groq free tier)');

  return summary;
}

/**
 * Builds the user prompt sent to the model.
 *
 * PROMPT DESIGN PHILOSOPHY:
 *
 * We do not send raw source code. We send the AST-extracted structure.
 * This has three advantages:
 *
 * 1. TOKEN EFFICIENCY: AST data is 60-80% smaller than source code.
 *    Less tokens = lower cost + faster response + less context noise.
 *
 * 2. SIGNAL CLARITY: The model sees exactly what matters —
 *    function names, parameter types, signatures. No implementation
 *    noise, no variable names, no internal logic.
 *
 * 3. GUIDED REASONING: By structuring the input as data, we prime
 *    the model to think analytically rather than descriptively.
 *    It reasons about the interface, not the implementation.
 *
 * We also add CONTEXT HINTS — information about the broader system
 * that helps the model make intelligent inferences. A function named
 * `getInstallationOctokit` in a file called `client.js` is clearly
 * GitHub API related. Giving the model this context produces docs
 * that mention GitHub, authentication, and API calls — without seeing
 * the implementation.
 *
 * @param {ParsedFile} parsedFile
 * @param {Construct[]} constructs
 * @returns {string}
 */
function buildUserPrompt(parsedFile, constructs) {
  const fileName = getFileName(parsedFile.filePath);

  // Build rich construct representations
  const constructData = constructs.map(construct => {
    const base = {
      key: buildConstructKey(construct),
      kind: construct.kind,
      name: construct.name,
      signature: construct.signature,
      isAsync: construct.isAsync || false,
      isExported: construct.exported || false,
      params: (construct.params || []).map(p => ({
        name: p.name,
        type: p.type || inferTypeFromName(p.name),
        defaultValue: p.defaultValue || null,
        isOptional: p.isOptional || false,
        isRest: p.isRest || false,
        isDestructured: p.isDestructured || false,
      })),
      returnType: construct.returnType || (construct.isAsync ? 'Promise<unknown>' : null),
      // If existing JSDoc exists, include it so the model can improve upon it
      existingDocumentation: construct.jsDoc?.description
        ? {
            description: construct.jsDoc.description,
            paramDocs: construct.jsDoc.params || [],
            returns: construct.jsDoc.returns || null,
          }
        : null,
      linesOfCode: (construct.location.endLine - construct.location.startLine) + 1,
    };

    // Add kind-specific fields
    if (construct.kind === 'api_route') {
      base.httpMethod = construct.httpMethod;
      base.routePath = construct.routePath;
      base.pathParams = construct.pathParams || [];
    }

    if (construct.kind === 'class') {
      base.methods = (construct.methods || []).map(m => ({
        name: m.name,
        signature: m.signature,
        isAsync: m.isAsync || false,
        isStatic: m.isStatic || false,
        params: m.params || [],
        returnType: m.returnType || null,
      }));
    }

    return base;
  });

  // Infer module purpose from filename and construct names
  // This gives the model crucial context without reading the source
  const modulePurpose = inferModulePurpose(fileName, constructs);

  return `You are documenting a JavaScript module from a production CLI tool called DocSync.

DocSync automatically detects when code changes cause documentation to drift from reality, then generates updated documentation using AI. It uses Tree-sitter for AST parsing, GitHub Apps API for PR automation, and Express.js for webhook handling.

## Module Being Documented

**File:** \`${fileName}\`
**Inferred Purpose:** ${modulePurpose}
**Language:** ${parsedFile.language}
**Constructs to document:** ${constructs.length}

## Code Constructs (AST-Extracted Signatures)

${JSON.stringify(constructData, null, 2)}

## Your Task

Apply your Chain of Thought process to each construct:

1. UNDERSTAND: What does this construct do in the context of DocSync?
2. IDENTIFY: What are the 3 most critical things a caller must know?
3. INFER: What types, shapes, and behaviors can you infer from names and signatures?
4. ANTICIPATE: What mistakes would a developer make without good docs?
5. WRITE: Document with enough detail that no one needs to read the source.

${constructs.some(c => c.isAsync) ?
  '⚠️  This file contains async functions. Always mention that callers must await these.' : ''}
${constructs.some(c => c.exported) ?
  '⚠️  Some constructs are exported (public API). Document these with maximum thoroughness.' : ''}
${constructs.some(c => c.kind === 'api_route') ?
  '⚠️  This file contains API route handlers. Document all possible HTTP response codes.' : ''}

Generate the documentation JSON now. Start with { and end with }. Nothing else.`;
}

/**
 * Infers the likely purpose of a module from its filename and constructs.
 * This context is included in the prompt to help the model make
 * intelligent inferences without seeing the source code.
 *
 * @param {string} fileName
 * @param {Construct[]} constructs
 * @returns {string}
 */
function inferModulePurpose(fileName, constructs) {
  const name = fileName.toLowerCase().replace(/\.(js|ts|jsx|tsx)$/, '');

  const purposes = {
    'logger': 'Logging utility — provides structured terminal output with colored status indicators',
    'config': 'Configuration management — reads, validates, and provides access to docsync.yaml settings',
    'parser': 'AST parser — uses Tree-sitter to extract function signatures, classes, and API routes from source code',
    'scanner': 'File system scanner — finds trackable files using glob patterns from the config',
    'snapshot': 'Snapshot system — persists the baseline state of code signatures for drift comparison',
    'drift': 'Drift detection engine — compares current code signatures against snapshot to detect documentation drift',
    'generator': 'Documentation generator — uses AI to produce documentation prose from AST-extracted signatures',
    'client': 'GitHub API client — provides authenticated Octokit instances and GitHub API operations',
    'pr-processor': 'PR processor — orchestrates the full documentation update workflow when a PR is opened',
    'webhook-server': 'Webhook server — receives and verifies GitHub webhook events, routes to handlers',
    'init': 'Init command — scans repo, parses files, creates baseline snapshot',
    'check': 'Check command — detects documentation drift and reports severity',
    'fix': 'Fix command — generates documentation for drifted constructs using AI',
  };

  return purposes[name] ||
    `Utility module — ${constructs.length} construct(s) including: ${constructs.slice(0, 3).map(c => c.name).join(', ')}`;
}

/**
 * Infers a TypeScript type from a parameter name when no annotation exists.
 * Uses naming conventions that are universal in JavaScript/TypeScript.
 *
 * This dramatically improves documentation quality for untyped JavaScript —
 * instead of "type: unknown" everywhere, we get intelligent type inference.
 *
 * @param {string} name - Parameter name
 * @returns {string} Inferred type
 */
function inferTypeFromName(name) {
  const lowerName = name.toLowerCase();

  // Boolean patterns
  if (/^(is|has|can|should|was|will|enable|disable|allow|prevent)[A-Z_]/.test(name)) return 'boolean';
  if (['enabled', 'disabled', 'active', 'visible', 'hidden', 'draft', 'force', 'verbose', 'silent', 'debug'].includes(lowerName)) return 'boolean';

  // Number patterns
  if (/^(count|total|size|length|max|min|limit|offset|page|index|num|amount|port|timeout|delay|retries|threshold|score)/.test(lowerName)) return 'number';
  if (/^(width|height|top|left|right|bottom|x|y|z|lat|lng|latitude|longitude)$/.test(lowerName)) return 'number';

  // String patterns
  if (/^(name|title|label|text|message|description|url|path|dir|file|key|token|secret|password|hash|slug|type|status|mode|format|encoding|version|prefix|suffix|namespace|tag|ref|branch|sha|commit)/.test(lowerName)) return 'string';
  if (['email', 'username', 'login', 'owner', 'repo', 'id'].includes(lowerName)) return 'string';

  // ID patterns
  if (/[Ii]d$/.test(name) && name.length > 2) return 'string';
  if (/[Ii]ds$/.test(name)) return 'string[]';

  // Array patterns
  if (/^(list|items|entries|records|rows|results|data|files|dirs|paths|keys|values|tags|labels|options|choices|args|params|headers|errors|warnings)$/.test(lowerName)) return 'string[]';
  if (/s$/.test(name) && name.length > 4) return 'unknown[]'; // plural names are likely arrays

  // Function patterns
  if (/^(callback|cb|handler|fn|func|action|middleware|resolver|predicate|comparator|transform|map|filter|reduce)/.test(lowerName)) return 'Function';

  // Object patterns
  if (/^(options|opts|config|settings|params|props|context|ctx|req|res|request|response|event|payload|data|body|headers|meta|metadata|info|details|state)$/.test(lowerName)) return 'object';

  // Timing
  if (/^(date|time|timestamp|createdAt|updatedAt|deletedAt|expiresAt|startTime|endTime)/.test(lowerName)) return 'Date | string';

  return 'unknown';
}

/**
 * Determines which constructs need documentation.
 *
 * @param {Construct[]} allConstructs
 * @param {FileReport|null} fileReport
 * @param {boolean} onlyDrifted
 * @returns {Construct[]}
 */
function selectConstructsToDocument(allConstructs, fileReport, onlyDrifted) {
  if (!onlyDrifted || !fileReport) {
    return allConstructs;
  }

  const driftedNames = new Set(
    fileReport.changes.map(c => c.constructName)
  );

  return allConstructs.filter(c => driftedNames.has(c.name));
}

/**
 * Calls the Groq API with exponential backoff retry logic.
 *
 * GROQ-SPECIFIC CONSIDERATIONS:
 *
 * Groq's infrastructure is optimized for inference speed (they use
 * custom LPU chips). This means responses are fast but the free tier
 * has rate limits — typically 30 requests/minute and 14,400/day.
 *
 * Our retry logic handles:
 * - 429 Too Many Requests (rate limit) — back off and retry
 * - 500/503 Server Errors — transient, retry
 * - Network failures — retry
 * - JSON parse failures — do NOT retry (model produced bad output, retrying won't help)
 *
 * @param {Groq} client
 * @param {string} userPrompt
 * @param {string} fileName
 * @returns {Promise<GenerationResult|null>}
 */
async function callGroqWithRetry(client, userPrompt, fileName) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: GROQ_MODEL,
        max_tokens: MAX_TOKENS,
        // Temperature 0.1 — near-deterministic but with tiny variation
        // to prevent the model from getting "stuck" in repetitive patterns
        // Pure 0 occasionally causes issues with some Llama versions
        temperature: 0.1,
        // Top-p sampling — only consider tokens comprising 95% of probability mass
        // This eliminates low-probability garbage tokens while preserving quality
        top_p: 0.95,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });

      const responseText = completion.choices[0]?.message?.content || '';

      if (!responseText.trim()) {
        throw new Error('Empty response from Groq API');
      }

      const parsed = parseModelResponse(responseText, fileName);

      if (!parsed) {
        // JSON parse failure — model produced unparseable output
        // Retrying with same prompt usually produces same bad output
        // So we fail fast instead of wasting retries
        logger.error(`Model produced unparseable JSON for ${fileName}`);
        return null;
      }

      // Attach metadata
      parsed.tokenUsage = {
        inputTokens: completion.usage?.prompt_tokens || 0,
        outputTokens: completion.usage?.completion_tokens || 0,
      };
      parsed.model = GROQ_MODEL;
      parsed.generatedAt = new Date().toISOString();

      return parsed;

    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const isRetryable = isRetryableError(error);

      if (isLastAttempt || !isRetryable) {
        logger.error(`Groq API failed for ${fileName} (attempt ${attempt}): ${error.message}`);
        return null;
      }

      const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`Groq API attempt ${attempt}/${MAX_RETRIES} failed. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  return null;
}

/**
 * Parses and validates the model's JSON response.
 *
 * Models sometimes wrap JSON in markdown code blocks, add preamble,
 * or produce slightly malformed JSON. We handle all known failure modes.
 *
 * @param {string} responseText
 * @param {string} fileName
 * @returns {object|null}
 */
function parseModelResponse(responseText, fileName) {
  let jsonText = responseText.trim();

  // Remove markdown code block wrappers (models do this despite being told not to)
  jsonText = jsonText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Find JSON object boundaries — handles preamble/postamble text
  const jsonStart = jsonText.indexOf('{');
  const jsonEnd = jsonText.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1 || jsonStart > jsonEnd) {
    logger.error(`No valid JSON object boundaries found in response for ${fileName}`);
    if (process.env.NODE_ENV === 'development') {
      logger.info('Response preview: ' + jsonText.substring(0, 300));
    }
    return null;
  }

  jsonText = jsonText.substring(jsonStart, jsonEnd + 1);

  // Attempt to fix common JSON issues from LLMs:
  // Trailing commas before closing brackets (invalid JSON, common LLM error)
  jsonText = jsonText
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}');

  try {
    const parsed = JSON.parse(jsonText);

    // Validate against schema
    const errors = validateDocumentationResult(parsed);
    if (errors.length > 0) {
      logger.warn(`Validation warnings for ${fileName}:`);
      errors.slice(0, 3).forEach(e => logger.warn(`  - ${e}`));
    }

    return parsed;

  } catch (error) {
    logger.error(`JSON.parse failed for ${fileName}: ${error.message}`);

    // Last resort: try to salvage by finding the first complete construct
    // This handles cases where the model truncated the output mid-JSON
    try {
      const salvaged = attemptJSONSalvage(jsonText);
      if (salvaged) {
        logger.warn(`Salvaged partial JSON for ${fileName}`);
        return salvaged;
      }
    } catch {
      // Salvage failed — return null
    }

    return null;
  }
}

/**
 * Attempts to salvage a truncated JSON response by finding complete constructs.
 * When the model hits max_tokens, it cuts off mid-JSON.
 * We extract whatever complete constructs exist.
 *
 * @param {string} jsonText
 * @returns {object|null}
 */
function attemptJSONSalvage(jsonText) {
  // Find fileOverview if it exists
  const overviewMatch = jsonText.match(/"fileOverview"\s*:\s*"([^"]+)"/);
  const fileOverview = overviewMatch ? overviewMatch[1] : 'Documentation partially generated — response was truncated.';

  // Find complete construct objects
  const constructs = [];
  const constructPattern = /\{[^{}]*"key"\s*:[^{}]*"documentation"\s*:\s*\{[^{}]*\}[^{}]*\}/g;
  const matches = jsonText.match(constructPattern);

  if (matches) {
    for (const match of matches) {
      try {
        const construct = JSON.parse(match);
        if (construct.key && construct.name) {
          constructs.push(construct);
        }
      } catch {
        // Skip malformed construct
      }
    }
  }

  if (constructs.length === 0) return null;

  return { fileOverview, constructs };
}

/**
 * Builds a structured fallback result when generation fails.
 * Returns documentation stubs that signal "needs human review"
 * without crashing the PR creation flow.
 *
 * @param {ParsedFile} parsedFile
 * @param {Construct[]} constructs
 * @returns {GenerationResult}
 */
function buildFallbackResult(parsedFile, constructs) {
  const fileName = getFileName(parsedFile.filePath);

  return {
    fileOverview: `${fileName} — AI documentation generation failed. Manual documentation required. Signature information is available in the parameters table below.`,
    constructs: constructs.map(construct => ({
      key: buildConstructKey(construct),
      kind: construct.kind,
      name: construct.name,
      documentation: {
        summary: `Undocumented ${construct.kind}: \`${construct.name}\` — please add documentation.`,
        description: `**Signature:** \`${construct.signature}\`\n\nThis construct was detected by DocSync as requiring documentation. Automated generation failed. Please document manually following your team's documentation standards.`,
        params: (construct.params || []).map(p => ({
          name: p.name,
          type: p.type || inferTypeFromName(p.name),
          description: `[Requires documentation] — Parameter \`${p.name}\` of inferred type \`${p.type || inferTypeFromName(p.name)}\``,
          required: !p.isOptional,
          defaultValue: p.defaultValue || null,
          example: null,
        })),
        returns: {
          type: construct.returnType || (construct.isAsync ? 'Promise<unknown>' : 'unknown'),
          description: '[Requires documentation]',
        },
        throws: [],
        example: `// TODO: Add example for ${construct.name}\n// Signature: ${construct.signature}`,
        sideEffects: null,
        complexity: null,
      },
    })),
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    model: 'fallback',
    generatedAt: new Date().toISOString(),
    isFallback: true,
  };
}

/**
 * Renders a generation result as formatted Markdown.
 * This is the final output committed to the companion PR.
 *
 * @param {GenerationResult} result
 * @param {string} filePath
 * @returns {string}
 */
function renderDocumentationAsMarkdown(result, filePath) {
  const fileName = getFileName(filePath);
  const lines = [];

  // File header
  lines.push(`# \`${fileName}\``);
  lines.push('');
  lines.push(`> ${result.fileOverview}`);
  lines.push('');

  if (result.isFallback) {
    lines.push('> ⚠️ **Auto-generation failed.** Documentation below is a placeholder requiring manual completion.');
    lines.push('');
  } else {
    lines.push(`*Auto-generated by [DocSync](https://github.com/ishwar-prog/docsync) using ${result.model} on ${new Date(result.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}*`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Table of contents for files with many constructs
  if ((result.constructs || []).length > 3) {
    lines.push('## Contents');
    lines.push('');
    for (const construct of result.constructs) {
      const anchor = construct.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const kindIcon = getKindIcon(construct.kind);
      lines.push(`- ${kindIcon} [\`${construct.name}\`](#${anchor})`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Each construct
  for (const construct of result.constructs || []) {
    const doc = construct.documentation;
    if (!doc) continue;

    const heading = construct.kind === 'class' ? '##' : '###';
    const kindBadge = getKindBadge(construct.kind);

    lines.push(`${heading} ${kindBadge} \`${construct.name}\``);
    lines.push('');

    // Summary as bold lead
    lines.push(`**${doc.summary}**`);
    lines.push('');

    // Description
    if (doc.description) {
      lines.push(doc.description);
      lines.push('');
    }

    // Parameters table
    if (doc.params && doc.params.length > 0) {
      lines.push('#### Parameters');
      lines.push('');
      lines.push('| Parameter | Type | Required | Description |');
      lines.push('|-----------|------|:--------:|-------------|');

      for (const param of doc.params) {
        const required = param.required ? '✅' : '❌';
        const type = `\`${param.type || 'unknown'}\``;
        let desc = param.description || '';
        if (param.defaultValue) desc += ` *(Default: \`${param.defaultValue}\`)*`;
        if (param.example) desc += ` *(Example: \`${param.example}\`)*`;
        lines.push(`| \`${param.name}\` | ${type} | ${required} | ${desc} |`);
      }
      lines.push('');
    }

    // Returns
    if (doc.returns && doc.returns.description) {
      lines.push('#### Returns');
      lines.push('');
      const type = doc.returns.type ? `**\`${doc.returns.type}\`**` : '';
      lines.push(`${type}${type ? ' — ' : ''}${doc.returns.description}`);
      lines.push('');
    }

    // Throws
    if (doc.throws && doc.throws.length > 0) {
      lines.push('#### Throws');
      lines.push('');
      for (const thrown of doc.throws) {
        lines.push(`- **\`${thrown.type}\`** — ${thrown.condition}`);
      }
      lines.push('');
    }

    // Side effects
    if (doc.sideEffects) {
      lines.push('#### Side Effects');
      lines.push('');
      lines.push(`> ⚡ ${doc.sideEffects}`);
      lines.push('');
    }

    // Complexity
    if (doc.complexity) {
      lines.push(`**Complexity:** \`${doc.complexity}\``);
      lines.push('');
    }

    // Example
    if (doc.example) {
      lines.push('#### Example');
      lines.push('');
      lines.push('```javascript');
      lines.push(doc.example);
      lines.push('```');
      lines.push('');
    }

    // Class-specific fields
    if (construct.kind === 'class') {
      if (doc.responsibilities && doc.responsibilities.length > 0) {
        lines.push('#### Responsibilities');
        lines.push('');
        doc.responsibilities.forEach(r => lines.push(`- ${r}`));
        lines.push('');
      }
      if (doc.usage) {
        lines.push('#### Usage');
        lines.push('');
        lines.push('```javascript');
        lines.push(doc.usage);
        lines.push('```');
        lines.push('');
      }
    }

    // API route-specific fields
    if (construct.kind === 'api_route') {
      if (doc.responses && doc.responses.length > 0) {
        lines.push('#### Response Codes');
        lines.push('');
        lines.push('| Status | Description |');
        lines.push('|--------|-------------|');
        for (const response of doc.responses) {
          lines.push(`| \`${response.status}\` | ${response.description} |`);
        }
        lines.push('');

        // Show examples for key responses
        const successResponse = doc.responses.find(r => r.status >= 200 && r.status < 300 && r.example);
        if (successResponse) {
          lines.push('**Success Response Example:**');
          lines.push('```json');
          lines.push(successResponse.example);
          lines.push('```');
          lines.push('');
        }
      }
      if (doc.authentication) {
        lines.push(`> 🔐 **Authentication:** ${doc.authentication}`);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push('');
  lines.push('*This documentation was auto-generated by [DocSync](https://github.com/ishwar-prog/docsync).*');
  lines.push('*Review for accuracy before merging. AI is thorough but not omniscient.*');

  return lines.join('\n');
}

// ── Utility Functions ──────────────────────────────────────────────────────

function getKindIcon(kind) {
  const icons = {
    'function': '⚡',
    'arrow_function': '⚡',
    'class': '🏗️',
    'api_route': '🛣️',
    'method': '🔧',
  };
  return icons[kind] || '•';
}

function getKindBadge(kind) {
  const badges = {
    'function': '⚡ Function',
    'arrow_function': '⚡ Function',
    'class': '🏗️ Class',
    'api_route': '🛣️ API Route',
    'method': '🔧 Method',
  };
  return badges[kind] || kind;
}

let groqClient = null;
function getGroqClient() {
  if (groqClient) return groqClient;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    logger.error('GROQ_API_KEY is not set in .env');
    logger.info('Get your free API key at: console.groq.com');
    process.exit(1);
  }

  groqClient = new Groq({ apiKey });
  logger.success('Groq client initialized (Llama 3.3 70B)');
  return groqClient;
}

function isRetryableError(error) {
  if (error.status) return error.status === 429 || error.status >= 500;
  if (error.code) return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code);
  return false;
}

function getFileName(filePath) {
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  generateFileDocumentation,
  generateDocumentationForDrift,
  renderDocumentationAsMarkdown,
};
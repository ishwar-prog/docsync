<div align="center">

# DocSync

**Auto-updating documentation that stays true to your code.**

[![npm version](https://img.shields.io/npm/v/@ishwarrr/docsync.svg?style=flat)](https://www.npmjs.com/package/@ishwarrr/docsync)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-ready-2088FF?logo=github-actions)](https://github.com/ishwar-prog/docsync)

AI coding agents ship code 5–10× faster than documentation can be written.
DocSync detects when your docs drift from your code — and fixes it automatically.

[Get Started](#installation) · [How It Works](#how-it-works) · [GitHub Action](#github-action) · [CLI Reference](#cli-reference)

</div>

---

## The Problem

```javascript
// Your docs say:
async function createUser(email, password) {}

// Your code now says:
async function createUser(email, password, role, organizationId) {}
```

Two new required parameters. Zero documentation updates. Every developer
who reads the old docs writes broken code. DocSync catches this the moment
it happens.

---

## How It Works

DocSync uses Tree-sitter AST parsing to understand your code structurally —
not as text, but as a semantic tree of functions, classes, and API routes.

**On every Pull Request:**

1. Parses changed JS/TS files with Tree-sitter
2. Compares extracted signatures against your documentation baseline
3. Calculates a **Drift Score** (0–100) for each changed construct
4. If drift exceeds your threshold, generates updated docs using AI
5. Opens a **companion PR** with the updated documentation

---

## Installation

**As a CLI tool:**
```bash
npm install -g @ishwarrr/docsync
# or without installing:
npx @ishwarrr/docsync init
```

**As a GitHub Action** (recommended):
```yaml
# .github/workflows/docsync.yml
- uses: ishwar-prog/docsync@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    groq-api-key: ${{ secrets.GROQ_API_KEY }}
```

---

## Quick Start

**1. Initialize your repo (run once):**
```bash
npx @ishwarrr/docsync init
git add .docsync/snapshot.json
git commit -m "docs: initialize DocSync baseline"
```

**2. Check for drift anytime:**
```bash
npx @ishwarrr/docsync check
```

**3. Auto-fix with AI:**
```bash
npx @ishwarrr/docsync fix
```

DocSync calls the AI, generates documentation for every drifted construct,
and writes professional Markdown to your `docs/` folder.

---

## GitHub Action

Add DocSync to any repository in 3 lines:

```yaml
name: DocSync
on: [pull_request]
permissions:
  contents: write
  pull-requests: write
jobs:
  docsync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ishwar-prog/docsync@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          groq-api-key: ${{ secrets.GROQ_API_KEY }}
```

**Get a free Groq API key** at [console.groq.com](https://console.groq.com) — no credit card required.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `npx @ishwarrr/docsync init` | Scan repo, parse all files, create baseline snapshot |
| `npx @ishwarrr/docsync check` | Detect documentation drift, show drift score |
| `npx @ishwarrr/docsync fix` | Generate AI documentation for all drifted constructs |
| `npx @ishwarrr/docsync check --json` | Machine-readable output for CI integration |

---

## Configuration

```yaml
# docsync.yaml
version: 1

track:
  - src/**/*.ts
  - src/**/*.js

ignore:
  - "**/*.test.ts"
  - "**/node_modules/**"

output:
  format: markdown    # markdown | mdx
  dir: docs/

drift:
  threshold: 75       # 0-100. Higher = stricter
  auto_pr: true
```

---

## The Drift Score

| Score | Status | What It Means |
|-------|--------|---------------|
| 0 | ✅ In Sync | Documentation matches code |
| 1–39 | 🟡 Minor Drift | Small changes, low priority |
| 40–74 | 🟠 Moderate Drift | Documentation is misleading |
| 75–100 | 🔴 Severe Drift | Documentation is wrong |

---

## Comparison

| Tool | Generates Docs | Detects Drift | Auto-PRs Fix | Works in CI |
|------|:--------------:|:-------------:|:------------:|:-----------:|
| Mintlify | ✅ | ❌ | ❌ | ❌ |
| Swimm | ✅ | Partial | ❌ | ✅ |
| GitHub Copilot | ✅ inline | ❌ | ❌ | ❌ |
| **DocSync** | **✅** | **✅** | **✅** | **✅** |

---

## Supported Languages

| Language | Parsing | Route Detection |
|----------|---------|-----------------|
| JavaScript | ✅ | ✅ Express.js |
| TypeScript | ✅ | ✅ Express.js |
| JSX / TSX | ✅ | ✅ |
| Python | 🔜 Coming soon | 🔜 |
| Go | 🔜 Coming soon | 🔜 |

---

## Contributing

```bash
git clone https://github.com/ishwar-prog/docsync
cd docsync
npm install
npm link
npx @ishwarrr/docsync init
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT © [Ishwar Suthar](https://github.com/ishwar-prog)

---

<div align="center">

Built with Tree-sitter · Groq Llama 3.3 · GitHub Actions · Node.js

**[@ishwarrr/docsync](https://www.npmjs.com/package/@ishwarrr/docsync) · If DocSync saves you time, give it a ⭐**

</div>


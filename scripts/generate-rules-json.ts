/**
 * Build-time codegen: read the bundled YAML ruleset and emit a parsed JSON
 * sibling so the SDK runtime doesn't need a YAML parser.
 *
 * Run automatically by `npm run prebuild` (and so by `npm run build`). Also
 * runs before publish via `prepublishOnly`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { MaskingRulesFile } from '../src/masking/rules/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'src', 'masking', 'rules');
const yamlPath = join(rulesDir, 'data-masking-rules.yaml');
const jsonPath = join(rulesDir, 'rules.json');

const text = readFileSync(yamlPath, 'utf8');
const parsed = parseYaml(text) as MaskingRulesFile;

if (!parsed?.version || !Array.isArray(parsed.rules)) {
  throw new Error(`Invalid masking rules file at ${yamlPath} — missing version or rules array`);
}

writeFileSync(jsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');

console.log(
  `Generated ${jsonPath} from ${yamlPath} ` +
    `(version=${parsed.version}, ${parsed.rules.length} rules)`
);

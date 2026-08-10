/**
 * Project rules — the CLAUDE.md idea, generalised.
 *
 * A file in the repository that is injected into EVERY prompt, in every phase,
 * and is never summarised away. That last property is the point: conversation
 * history gets compressed as it grows, and "always run the tests with pnpm, not
 * npm" must not be the thing that falls out of the window on turn 30.
 *
 * Several filenames are accepted because the user may already keep one for
 * another tool, and having to maintain two copies of the same rules guarantees
 * they drift.
 */

import * as P from '../platform/paths.js';
import { estimateTokens, truncate } from './util.js';

const CANDIDATES = [
    '.rubus/rules.md',
    // The old name, still read: a project that already keeps its rules here
    // would otherwise go silently unruled after the rename, and "the agent
    // stopped respecting my conventions" is not a symptom anyone traces back
    // to a renamed folder. New projects get `.rubus/`; nothing has to move.
    '.agentcoder/rules.md',
    'AGENTS.md',
    'AGENT.md',
    'CLAUDE.md',
    '.cursorrules',
    '.github/copilot-instructions.md'
];

const MAX_TOKENS = 1400;

export class ProjectRules {
    constructor({ platform, config, logger }) {
        this.platform = platform;
        this.config = config;
        this.logger = logger;
        this.cache = null;
        this.cacheRoot = '';
    }

    invalidate() {
        this.cache = null;
    }

    async load({ force = false } = {}) {
        const root = P.normalize(this.config.get('workspace.root', ''));
        if (!root) return { text: '', sources: [], tokens: 0 };
        if (!force && this.cache && this.cacheRoot === root) return this.cache;

        const found = [];
        for (const rel of CANDIDATES) {
            const abs = P.join(root, rel);
            const stat = await this.platform.fs.stat(abs);
            if (!stat || !stat.isFile || stat.size === 0) continue;
            try {
                const raw = (await this.platform.fs.readText(abs)).trim();
                if (raw) found.push({ rel, text: raw });
            } catch { /* unreadable is the same as absent */ }
            // First hit wins. Loading several would double the rules and, worse,
            // let two stale copies contradict each other inside one prompt.
            if (found.length) break;
        }

        let text = '';
        if (found.length) {
            const body = found.map(f => f.text).join('\n\n');
            text = truncate(body, MAX_TOKENS * 3, '\n… [reglas recortadas: el archivo es muy largo]');
        }

        this.cache = {
            text,
            sources: found.map(f => f.rel),
            tokens: estimateTokens(text),
            path: found.length ? P.join(root, found[0].rel) : ''
        };
        this.cacheRoot = root;

        if (found.length) this.logger?.info(`Reglas de proyecto cargadas desde ${found[0].rel}`, { tokens: this.cache.tokens });
        return this.cache;
    }

    /** The block that goes into the system prompt. */
    async block() {
        const rules = await this.load();
        if (!rules.text) return '';
        return [
            '════ REGLAS DEL PROYECTO ════',
            `(de ${rules.sources.join(', ')} — tienen prioridad sobre tus preferencias por defecto)`,
            '',
            rules.text,
            '════════════════════════════'
        ].join('\n');
    }

    /** Scaffold a starter file, for the "Crear reglas" button in the UI. */
    async createTemplate({ overwrite = false } = {}) {
        const root = P.normalize(this.config.get('workspace.root', ''));
        if (!root) throw new Error('No hay carpeta de trabajo.');

        const abs = P.join(root, 'AGENTS.md');
        const existing = await this.platform.fs.stat(abs);
        if (existing && !overwrite) return { path: abs, created: false };

        await this.platform.fs.writeText(abs, TEMPLATE);
        this.invalidate();
        return { path: abs, created: true };
    }
}

const TEMPLATE = `# Reglas del proyecto

Este archivo se inyecta en TODOS los prompts del agente. Sé breve y concreto:
cada línea consume contexto en cada turno.

## Comandos

- instalar: \`npm install\`
- tests: \`npm test\`
- build: \`npm run build\`
- lint: \`npm run lint\`

## Convenciones de código

- (indentación, comillas, punto y coma, nombres de archivo…)
- (patrones que se usan y patrones prohibidos)

## Estructura importante

- \`src/\` — …
- \`tests/\` — …

## Reglas duras

- No modifiques archivos generados.
- No añadas dependencias nuevas sin pedirlo antes.
- Escribe un test para cada corrección de bug.
`;

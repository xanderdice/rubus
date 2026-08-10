/**
 * A very small Markdown renderer for chat messages.
 *
 * Escaping happens FIRST, on the raw text, and every rule after that only
 * inserts tags — no rule ever emits attacker-controllable attribute values.
 * That ordering is the whole security model: model output is untrusted input,
 * and this app hands the model the filesystem, so an injected `<img onerror>`
 * would be a genuinely bad day.
 *
 * Links are rendered as plain text on purpose. There is nowhere useful for a
 * click to go from a local agent, and a clickable URL from model output is an
 * exfiltration channel.
 */

import { escapeHtml } from './dom.js';

export function renderMarkdown(text) {
    if (!text) return '';

    let s = escapeHtml(String(text));

    // Fenced code first: its contents must not be touched by the inline rules.
    //
    // The placeholders are wrapped in NUL, spelled `\u0000` rather than written
    // as a raw byte. NUL is the right sentinel — escapeHtml has already run, so
    // every printable candidate can still legitimately occur in the text, and
    // this one cannot — but a literal NUL in the source makes the whole file
    // register as binary: grep skips it, diffs are unreadable, and editors
    // quietly mangle it. Same behaviour, debuggable source.
    const blocks = [];
    s = s.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
        blocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${code.replace(/\n$/, '')}</code></pre>`);
        return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });

    const inline = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
        inline.push(`<code>${code}</code>`);
        return `\u0000INLINE${inline.length - 1}\u0000`;
    });

    s = s
        .replace(/^###\s+(.+)$/gm, '<b>$1</b>')
        .replace(/^##\s+(.+)$/gm, '<b>$1</b>')
        .replace(/^#\s+(.+)$/gm, '<b>$1</b>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .replace(/^\s*[-*·]\s+/gm, '  · ')
        .replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ');

    s = s.replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inline[Number(i)]);
    s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);

    return s;
}

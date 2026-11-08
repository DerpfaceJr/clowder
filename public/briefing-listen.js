// Listen (plan 3.2): reads a daily briefing aloud with the browser's own speech (speechSynthesis), so nothing leaves the device.
// The routines panel puts a Listen button on a briefing routine's latest result. The text is Markdown from a model: headings, bullets,
// emphasis and links are reduced to plain words first. Long text is queued as short pieces, since some browsers stop one long
// utterance after about fifteen seconds. Pure helpers are exported for Node tests.

/** Markdown reduced to the words a listener should hear, one paragraph per line. */
export function speakableText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .split('\n')
    .map(line => line.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, '').replace(/[*_`~|]+/g, '').replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^[-=:\s]+$/.test(line))
    .join('\n');
}

/** Pieces of at most max characters, broken at line and sentence ends where it can. */
export function speechChunks(text, max = 220) {
  const out = [];
  for (const para of String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean)) {
    let current = '';
    for (const sentence of para.split(/(?<=[.!?;:])\s+/)) {
      const parts = sentence.length > max ? sentence.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')).map(s => s.trim()) : [sentence];
      for (const part of parts) {
        if (current && `${current} ${part}`.length > max) { out.push(current); current = part; } else current = current ? `${current} ${part}` : part;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * One reader for the page. toggle(id, text, onChange) starts reading the text or, for the id already reading, stops it;
 * onChange(id or null) runs whenever what is being read changes. available is false where the browser has no speech.
 */
export function createListener(win = globalThis.window) {
  const synth = win?.speechSynthesis, Utterance = win?.SpeechSynthesisUtterance;
  const available = !!synth && typeof Utterance === 'function';
  let reading = null, listener = () => {}, run = 0;
  const set = id => { reading = id; listener(id); };
  function stop() {
    if (!available) return;
    run++;
    synth.cancel();
    if (reading !== null) set(null);
  }
  function toggle(id, text, onChange = () => {}) {
    if (!available) return false;
    if (reading === id) { stop(); return false; }
    stop();
    listener = onChange;
    const pieces = speechChunks(speakableText(text));
    if (!pieces.length) return false;
    const mine = ++run, lang = win?.document?.documentElement?.lang || undefined;
    pieces.forEach((piece, i) => {
      const u = new Utterance(piece);
      if (lang) u.lang = lang;
      if (i === pieces.length - 1) u.onend = () => { if (run === mine) set(null); };
      u.onerror = () => { if (run === mine) { run++; set(null); } };
      synth.speak(u);
    });
    set(id);
    return true;
  }
  return {available, toggle, stop, get reading() { return reading; }};
}

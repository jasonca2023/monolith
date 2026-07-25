/**
 * Monolith — blockade landing page.
 *
 * Rendered whenever declarativeNetRequest intercepts a navigation to a
 * distracting domain during a focus shift. Counts down to the end of the
 * session when the host supplied a duration, and counts up otherwise.
 */

'use strict';

const FOCUS_STATE_KEY = 'monolith.focus.session';

/** 3x5 block glyphs; ':' is a single column so the clock stays centred. */
const GLYPHS = {
  0: ['███', '█ █', '█ █', '█ █', '███'],
  1: ['  █', '  █', '  █', '  █', '  █'],
  2: ['███', '  █', '███', '█  ', '███'],
  3: ['███', '  █', '███', '  █', '███'],
  4: ['█ █', '█ █', '███', '  █', '  █'],
  5: ['███', '█  ', '███', '  █', '███'],
  6: ['███', '█  ', '███', '█ █', '███'],
  7: ['███', '  █', '  █', '  █', '  █'],
  8: ['███', '█ █', '███', '█ █', '███'],
  9: ['███', '█ █', '███', '  █', '███'],
  ':': [' ', '█', ' ', '█', ' '],
  '-': ['   ', '   ', '███', '   ', '   '],
};

const TAUNTS = [
  'Monolith is holding the door. Go back to the editor.',
  'That tab was not part of the plan.',
  'The shift is still running. So are you.',
  'Nothing over here has changed since you last checked.',
  'This is the part where you close the tab yourself.',
];

const clockEl = document.getElementById('clock');
const modeEl = document.getElementById('mode');
const hostEl = document.getElementById('host');
const tauntEl = document.getElementById('taunt');

let session = null;

/** Rasterizes "MM:SS" into five lines of block glyphs. */
function renderAscii(text) {
  const rows = ['', '', '', '', ''];
  for (const character of text) {
    const glyph = GLYPHS[character] || GLYPHS['-'];
    for (let row = 0; row < 5; row += 1) {
      rows[row] += `${glyph[row]} `;
    }
  }
  return rows.join('\n');
}

function formatDuration(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function tick() {
  if (!session) {
    clockEl.textContent = renderAscii('--:--');
    return;
  }

  const now = Date.now();
  if (typeof session.endsAt === 'number' && session.endsAt > 0) {
    const remaining = (session.endsAt - now) / 1000;
    clockEl.textContent = renderAscii(formatDuration(remaining));
    if (remaining <= 0) {
      modeEl.textContent = 'Shift complete';
      tauntEl.textContent = 'The blockade lifts as soon as the host hydrates your session.';
    }
    return;
  }

  clockEl.textContent = renderAscii(formatDuration((now - (session.startedAt || now)) / 1000));
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(FOCUS_STATE_KEY);
    session = stored[FOCUS_STATE_KEY] || null;
  } catch {
    session = null;
  }

  if (session) {
    modeEl.textContent = session.profileName || 'Deep Work';
    const count = Array.isArray(session.domains) ? session.domains.length : 0;
    hostEl.textContent = count > 0 ? `${count} distraction domains` : 'this site';
  }

  tauntEl.textContent = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
  tick();
}

setInterval(tick, 1000);
void load();

// The worker rewrites focus state on every shift; follow it without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[FOCUS_STATE_KEY]) return;
  session = changes[FOCUS_STATE_KEY].newValue || null;
  if (session && session.profileName) modeEl.textContent = session.profileName;
  tick();
});

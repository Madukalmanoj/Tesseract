// OmniExtract — Content Script
(function() {
'use strict';

const PLAT = location.hostname.includes('claude.ai') ? 'claude'
           : (location.hostname.includes('chatgpt.com')||location.hostname.includes('chat.openai.com')) ? 'chatgpt'
           : location.hostname.includes('gemini.google.com') ? 'gemini'
           : (location.hostname.includes('grok.com')||location.hostname.includes('x.com')) ? 'grok'
           : 'unknown';

const TYPE_BADGES = new Set(['ZIP', 'PDF', 'DOCX', 'TXT', 'CSV', 'XLSX', 'PPTX', 'PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'HTML', 'CSS', 'JS', 'PY', 'SH', 'JSON', 'MD', 'PASTED']);

// ── Background proxy (no CORS) ───────────────────────────────────────────────
function bg(action, data) {
  return new Promise(ok => {
    chrome.runtime.sendMessage({action,...data}, r => {
      ok(chrome.runtime.lastError ? {error:chrome.runtime.lastError.message} : (r||{error:'no response'}));
    });
  });
}

// ── Get intercepted store from page hook ─────────────────────────────────────
function getStore() {
  return new Promise(ok => {
    const t = setTimeout(()=>ok({files:{},orgId:null}), 60000);
    window.addEventListener('__cepReply', function h(e) {
      clearTimeout(t); window.removeEventListener('__cepReply',h);
      ok(e.detail||{files:{},orgId:null});
    }, {once:true});
    window.dispatchEvent(new CustomEvent('__cepQuery'));
  });
}

// ── Org ID for Claude ────────────────────────────────────────────────────────
function getOrgId() {
  try {
    const m = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/);
    if (m) return m[1];
    for (const k of Object.keys(localStorage)) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v?.uuid) return v.uuid;
        if (v?.id && /^[a-f0-9-]{36}$/.test(v.id)) return v.id;
      } catch(_) {}
    }
    const pm = location.pathname.match(/\/([a-f0-9-]{36})\//);
    if (pm) return pm[1];
  } catch(_) {}
  return null;
}

// ── Fuzzy store lookup ───────────────────────────────────────────────────────
function fromStore(name, store, consumedStore = new Set()) {
  if (!store||!name) return null;

  if (PLAT === 'chatgpt') {
    const k = name.toLowerCase().trim();
    if (store[k] && !consumedStore.has(store[k])) return store[k];
    const noext = k.replace(/\.[^.]+$/,'');
    for (const [sk,sv] of Object.entries(store)) {
      if (consumedStore.has(sv)) continue;
      if (sk===noext) return sv;
      if (sk.includes(noext)) return sv;
      if (noext.includes(sk.replace(/\.[^.]+$/,''))) return sv;
    }
    return null;
  }

  const cleanName = name.replace(/^\d{10,13}_/, '');
  const k = cleanName.toLowerCase().trim();
  
  if (store[k] && !consumedStore.has(store[k])) return store[k];
  if (store[k + '.txt'] && !consumedStore.has(store[k + '.txt'])) return store[k + '.txt'];
  
  const noext = k.replace(/\.[^.]+$/,'');
  
  // Special fuzzy match for ZIP files represented as literally "ZIP"
  if (k === 'zip') {
    for (const [sk, sv] of Object.entries(store)) {
      if (consumedStore.has(sv)) continue;
      if (sk.endsWith('.zip')) return sv;
    }
  }
  
  const commonExts = ['pdf', 'docx', 'doc', 'zip', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv', 'py', 'json', 'sh', 'js', 'html', 'css', 'md'];

  for (const [sk,sv] of Object.entries(store)) {
    if (consumedStore.has(sv)) continue;
    if (sk===noext) return sv;
    if (!commonExts.includes(noext) && sk.includes(noext)) return sv;
    if (noext.includes(sk.replace(/\.[^.]+$/,''))) return sv;
  }
  return null;
}

// ── MIME → extension ─────────────────────────────────────────────────────────
function mext(mime) {
  const m=(mime||'').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('zip')) return 'zip';
  if (m.includes('wordprocessingml')||m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml')) return 'xlsx';
  if (m.includes('presentationml')) return 'pptx';
  return 'bin';
}

// ── Selectors ────────────────────────────────────────────────────────────────
// Claude: turns wrap everything; text lives in .whitespace-pre-wrap or prose divs
// ChatGPT: articles contain turns, role in data attribute
// ── Turn detection ───────────────────────────────────────────────────────────
// Claude confirmed selectors (stable data-testid attributes):
//   [data-testid="human-turn"]  — user message wrapper
//   [data-testid="ai-turn"]     — AI message wrapper
// These elements contain the full turn including text + attachments.
// We sort them by DOM order to preserve conversation sequence.

function findTurns() {
  let found = [];
  const seen  = new Set();

  if (PLAT === 'chatgpt') {
    for (const s of ['article[data-testid]','[data-message-id]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
  }

  else if (PLAT === 'gemini') {
    for (const s of ['user-query', 'model-response', 'model-turn', '[class*="user-query"]', '[class*="model-response"]', '[class*="model-turn"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
  }

  else if (PLAT === 'claude') {
    for (const s of ['[data-testid="human-turn"]', '[data-testid="ai-turn"]', '[data-testid$="-turn"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
  }

  else if (PLAT === 'grok') {
    for (const s of ['[data-testid="messageEntry"]', '[class*="messageEntry"]', 'article', '[class*="MessageContent"]', '[class*="message-content"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
  }

  // Strategy 1: Known turn selectors (Fuzzy fallback)
  if (!found.length) {
    const exactSels = [
      '[data-testid="human-turn"],[data-testid="ai-turn"]',
      '[data-testid$="-turn"]',
      '[class*="turn-"][class*="human"],[class*="turn-"][class*="assistant"]',
      '[class*="MessageContent"],[class*="message-content"]',
      '[class*="ConversationTurn"],[class*="conversation-turn"]',
      'user-query, model-response, model-turn, [class*="user-query"], [class*="model-response"], [class*="model-turn"]'
    ];
    for (const sel of exactSels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
      if (found.length) break;
    }
  }

  // Strategy 2: Look for 'sr-only' markers (You said: / Claude responded:)
  if (!found.length) {
    for (const el of document.querySelectorAll('div, span')) {
      if (el.className && typeof el.className === 'string' && el.className.includes('sr-only')) {
        const t = el.innerText || el.textContent || '';
        if (t.includes('You said:') || t.includes('responded:')) {
           let wrapper = el.parentElement;
           if (wrapper && !seen.has(wrapper)) { seen.add(wrapper); found.push(wrapper); }
        }
      }
    }
  }

  // Filter out parent containers (only keep leaf turns)
  const leaves = found.filter(el => !found.some(other => other !== el && el.contains(other)));
  if (leaves.length) {
    return leaves.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  // Strategy 3: Nuclear Fallback - Grab the main content area
  const chatArea = document.querySelector('main') || document.body;
  return [chatArea];
}

// Detect text that is clearly sidebar/navigation/UI noise, not chat content
function isUINoiseText(text) {
  const t = text.trim();
  // Sidebar nav concatenated text (e.g. "New chatCtrl+⇧+OChatsProjects...")
  if (/^New chat(Ctrl|⌘)/i.test(t)) return true;
  // Chat history list items (long concatenated titles)
  if (/^(Chats|Projects|Artifacts|Customize|Products|Cowork|Code|Starred)/i.test(t) && t.length > 100) return true;
  // Upgrade/subscription banners
  if (/^(Free plan|You are out of free messages|Upgrade)/i.test(t)) return true;
  // Claude availability messages
  if (/Claude .* (unavailable|currently)/i.test(t) && t.length < 200) return true;
  if (/Claude is AI and can make mistakes/i.test(t) && t.length < 200) return true;
  // Just a list of chat titles (no sentence structure, lots of title-case words)
  if (/^(Starred|Recents|All chats)/.test(t) && t.length > 200) return true;
  // Conversation wrapper blocks: contain "You said:" + "Claude responded:" patterns
  if (/You said:/.test(t) && /Claude responded:/.test(t) && t.length < 500) return true;
  // Tiny noise: zip filenames, single words like "Done", "Content", "Script"
  if (/^[a-f0-9]{16,}\.zip/i.test(t) && t.length < 100) return true;
  if (/^(Done|Content|Script|Table · CSV|PY)$/i.test(t)) return true;
  // Settings/account menu text
  if (/^(sasuke|Settings|Language|Get help|Upgrade plan|Log out)/i.test(t) && t.length < 300) return true;
  // Input area controls
  if (/^(Add files or photos|Take a screenshot|Add to project|Skills|Add connectors)/i.test(t)) return true;
  // Model selector
  if (/^(Sonnet|Claude|Opus|Haiku|Fable)\s+\d/i.test(t) && t.length < 200) return true;
  // Star/Rename/Delete context menus
  if (/^(Unstar|Star|Rename|Add to project|Delete|Group by)/i.test(t) && t.length < 100) return true;
  // Microphone label
  if (/^(Microphone|Hold to record)/i.test(t) && t.length < 100) return true;
  
  // Usage/Context warnings
  if (/^(Session|Weekly): \d+%/.test(t)) return true;
  if (/^(Approximate tokens|Messages sent while cached|5-hour session|7-day usage|Dynamic Context|Bar scale:)/i.test(t)) return true;

  return false;
}

// ── Role detection ────────────────────────────────────────────────────────────
function getRole(turn) {
  // Gemini tags or classes
  if (PLAT === 'gemini') {
    const tag = turn.tagName?.toLowerCase();
    if (tag === 'user-query' || turn.classList?.contains('user-query') || turn.closest('user-query') || turn.className?.includes?.('user-query')) return 'user';
    if (tag === 'model-turn' || tag === 'model-response' || turn.classList?.contains('model-turn') || turn.classList?.contains('model-response') || turn.closest('model-turn') || turn.closest('model-response') || turn.className?.includes?.('model-turn') || turn.className?.includes?.('model-response')) return 'assistant';
  }

  // Gemini tags fallback (non-Gemini platforms)
  const tag = turn.tagName?.toLowerCase();
  if (tag === 'user-query') return 'user';
  if (tag === 'model-turn' || tag === 'model-response') return 'assistant';

  // Grok specific role detection
  if (PLAT === 'grok') {
    const html = turn.outerHTML || '';
    const lowerHtml = html.toLowerCase();
    if (turn.querySelector('button[aria-label*="like" i], button[aria-label*="dislike" i], [data-testid*="like" i], [data-testid*="dislike" i], [data-testid*="feedback" i]')) return 'assistant';
    if (lowerHtml.includes('grok-response') || lowerHtml.includes('grok-message') || lowerHtml.includes('assistant-message')) return 'assistant';
    if (lowerHtml.includes('user-message') || lowerHtml.includes('human-message')) return 'user';
    if (turn.querySelector('svg[data-testid="grok-logo"], [class*="grok-logo" i], [class*="grok_logo" i]')) return 'assistant';
  }

  // ChatGPT
  const gptRole = turn.getAttribute('data-message-author-role') ||
                  turn.querySelector('[data-message-author-role]')
                      ?.getAttribute('data-message-author-role');
  if (gptRole) return gptRole === 'user' ? 'user' : 'assistant';

  // Claude — data-testid on the element itself or ancestors/descendants
  const testid = turn.getAttribute('data-testid') || '';
  if (testid.includes('human')) return 'user';
  if (testid.includes('ai'))    return 'assistant';

  // Check children for testid hints
  const childTestId = turn.querySelector('[data-testid*="human"]') ? 'user'
                    : turn.querySelector('[data-testid*="ai"]')    ? 'assistant'
                    : null;
  if (childTestId) return childTestId;

  // Check ancestor for testid
  const ancestor = turn.closest('[data-testid*="human-turn"],[data-testid*="ai-turn"]');
  if (ancestor) {
    const aid = ancestor.getAttribute('data-testid') || '';
    if (aid.includes('human')) return 'user';
    if (aid.includes('ai'))    return 'assistant';
  }

  // Claude class-based hints
  const cls = (turn.className || '') + ' ' + (turn.parentElement?.className || '');
  if (/\b(human|user)\b/i.test(cls)) return 'user';
  if (/\b(assistant|ai|claude|bot|model)\b/i.test(cls)) return 'assistant';

  // Content-based heuristic: if it has .font-claude-message, it's AI
  if (turn.querySelector('.font-claude-message,[class*="claude-message"]')) return 'assistant';

  return 'unknown';
}

// ── Text extraction ───────────────────────────────────────────────────────────
function extractText(turn) {
  const clone = turn.cloneNode(true);
  
  // Strip all UI noise containers before extracting text
  for (const el of clone.querySelectorAll(
    'script, style, noscript, iframe, button, svg, nav, aside, header, footer, form, ' +
    '[role="navigation"], [role="menu"], [role="toolbar"], [role="dialog"], ' +
    '[class*="sidebar" i], [class*="Sidebar"], ' +
    '[class*="toolbar" i], [class*="Toolbar"], ' +
    '[class*="action"], [class*="copy"], [class*="feedback"], ' +
    '[class*="tooltip"], [class*="thumb"], [aria-hidden="true"], ' +
    '[class*="sr-only" i], [class*="visually-hidden" i], [class*="assistive-text" i]'
  )) {
    el.remove();
  }
  
  const text = clone.innerText?.trim() || '';
  return isUINoiseText(text) ? '' : text;
}

const SEL = {
  claude:  { input: '.ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]' },
  chatgpt: { input: '#prompt-textarea, [contenteditable][data-id="root"]' },
  gemini:  { input: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea' },
  grok:    { input: 'textarea, div[role="textbox"][contenteditable="true"]' }
};

function cleanAttachmentName(name) {
  if (!name) return name;
  let clean = name.replace(/^\d{10,13}_/, '').trim();
  // If the filename contains a comma followed by file metadata (e.g. "file.docx, docx, 72 lines")
  const commaIdx = clean.search(/\.(pdf|docx?|zip|xlsx?|pptx?|txt|csv|py|json|sh|js|html|css|md),\s*/i);
  if (commaIdx !== -1) {
    const extMatch = clean.slice(commaIdx).match(/^\.(pdf|docx?|zip|xlsx?|pptx?|txt|csv|py|json|sh|js|html|css|md)/i);
    if (extMatch) {
      clean = clean.slice(0, commaIdx + extMatch[0].length);
    }
  }
  return clean;
}

// Recursively search the DOM, including shadow roots, for all elements matching the selector
function querySelectorAllShadow(selector, root = document) {
  const matches = [];
  function recurse(node) {
    if (!node) return;
    if (node.querySelectorAll) {
      const found = node.querySelectorAll(selector);
      for (const f of found) {
        if (!matches.includes(f)) matches.push(f);
      }
    }
    if (node.shadowRoot) {
      recurse(node.shadowRoot);
    }
    const childs = node.childNodes || [];
    for (let i = 0; i < childs.length; i++) {
      recurse(childs[i]);
    }
  }
  recurse(root);
  return matches;
}

function querySelectorShadow(selector, root = document) {
  const res = querySelectorAllShadow(selector, root);
  return res.length > 0 ? res[0] : null;
}

// Check if an element or its ancestor is part of the UI container or noise
function isInsideUI(el) {
  if (!el) return false;
  return !!el.closest(
    'nav, aside, header, footer, form, ' +
    '[role="navigation"], [role="menu"], [role="toolbar"], [role="dialog"], ' +
    '[class*="sidebar" i], [class*="Sidebar"], ' +
    '[class*="toolbar" i], [class*="Toolbar"]'
  );
}

// Check if a resolved chip text is actually just UI noise rather than a filename
function isUINoiseFileName(name) {
  const t = name.trim();
  if (!t) return true;
  // If it has a typical file extension, it's likely a real file
  if (/\.(pdf|docx|zip|csv|xlsx|pptx|txt|py|json|png|jpe?g|gif|webp|sh|js|html|css|md)$/i.test(t)) return false;
  // Claude paste representations
  if (t === 'PASTED' || t === 'ZIP') return false;
  // Common UI labels
  if (/^(Get apps|Help|Settings|Close|Cancel|Send|Upload|Attach|Menu|Log out|Upgrade|Feedback|Model|Show more|View more|See more|Star|Delete|Rename|All chats|Download all)/i.test(t)) return true;
  // Long phrase that doesn't look like a filename
  if (t.length > 50 && !t.includes('.')) return true;
  return false;
}

// Resolve real image URL (handles lazy loading data attributes and upscales CDN paths)
function resolveImageSrc(img) {
  let src = '';

  // 1. Check srcset for high-res versions
  const srcset = img.getAttribute('srcset');
  if (srcset) {
    try {
      const candidates = srcset.split(',').map(s => {
        const parts = s.trim().split(/\s+/);
        const url = parts[0];
        const desc = parts[1] || '';
        let score = 0;
        if (desc.endsWith('w')) {
          score = parseInt(desc.slice(0, -1), 10) || 0;
        } else if (desc.endsWith('x')) {
          score = parseFloat(desc.slice(0, -1)) * 1000 || 0;
        } else {
          score = 1;
        }
        return { url, score };
      });
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > 0 && candidates[0].url) {
        src = candidates[0].url;
      }
    } catch (_) {}
  }

  // 2. Check other data-attributes on the image element
  if (!src) {
    for (const attr of ['data-src', 'data-zoom', 'data-zoom-src', 'data-original-src', 'original-src', 'data-hero-src', 'data-image-url']) {
      const val = img.getAttribute(attr);
      if (val && (val.startsWith('http') || val.startsWith('blob:') || val.startsWith('data:'))) {
        src = val;
        break;
      }
    }
  }

  // 3. Fallback to parent link/container attributes if we have a blob/data URL or nothing
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) {
    let p = img.parentElement;
    let depth = 0;
    while (p && depth < 4) {
      if (p.tagName?.toLowerCase() === 'a') {
        const href = p.getAttribute('href');
        if (href && (href.startsWith('http') || href.includes('twimg.com') || href.includes('x.ai') || href.includes('grok.com'))) {
          const lowerHref = href.toLowerCase();
          if (/\.(png|jpe?g|webp|gif)/i.test(lowerHref) || lowerHref.includes('twimg.com') || lowerHref.includes('x.ai') || lowerHref.includes('/media/') || lowerHref.includes('image')) {
            src = href;
            break;
          }
        }
      }
      
      for (const attr of ['data-src', 'data-zoom', 'data-zoom-src', 'data-original-src', 'original-src', 'data-hero-src', 'data-image-url', 'href']) {
        const val = p.getAttribute(attr);
        if (val && (val.startsWith('http') || val.includes('twimg.com') || val.includes('x.ai') || val.includes('grok.com')) && !val.startsWith('blob:') && !val.startsWith('data:')) {
          src = val;
          break;
        }
      }
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) break;
      p = p.parentElement;
      depth++;
    }
  }

  // 4. Ultimate fallback to standard src
  if (!src) src = img.src || '';

  // 5. Clean up & upscale the resolved URL
  let sl = src.toLowerCase();
  
  // Twitter / X.com CDN upscaling
  if (sl.includes('twimg.com') || sl.includes('x.com')) {
    if (src.includes('name=')) {
      src = src.replace(/name=[a-zA-Z0-9_]+/gi, 'name=orig');
    } else {
      // Legacy colon syntax
      src = src.replace(/:(small|thumb|medium|large|tiny)/gi, ':orig');
    }
  }

  // assets.grok.com upscaling
  if (sl.includes('assets.grok.com')) {
    // Replace preview-image suffix with content (Grok user upload original content)
    src = src.replace(/\/preview-image$/i, '/content');
    // Remove thumbnail suffixes from filename (e.g. -thumb, _thumb, -small, _small)
    src = src.replace(/[-_](thumb|thumbnail|small|medium|preview)\b/gi, '');
    // Remove trailing size paths (e.g. /thumb)
    src = src.replace(/\/(thumb|thumbnail|small|medium|preview)$/i, '');
    // Remove query parameters that resize or compress
    src = src.replace(/[?&](width|height|size|w|h|fit|quality)=\w+/gi, '');
    // Clean up trailing ? or &
    src = src.replace(/[?&]$/, '');
  }

  // Bypass Cloudflare cdn-cgi image resizing to fetch the raw original image
  if (src.includes('/cdn-cgi/image/')) {
    const match = src.match(/(https?:\/\/[^\/]+)?\/cdn-cgi\/image\/[^\/]+\/(.*)/i);
    if (match) {
      const origin = match[1] || '';
      const rest = match[2];
      if (rest.startsWith('http://') || rest.startsWith('https://')) {
        src = rest;
      } else {
        src = (origin || new URL(src).origin) + '/' + rest;
      }
    }
  }

  return src;
}

// ── Extract images from a turn (bg proxy for CORS) ──────────────────────────
async function extractImages(turn, idMap = {}) {
  const imgs = [];
  let allImgs = turn.querySelectorAll('img');
  // For Gemini, also check shadowRoot children
  if (PLAT === 'gemini' && allImgs.length === 0) {
    allImgs = querySelectorAllShadow('img', turn);
  }
  console.log('[CEP] Found', allImgs.length, 'total images in turn');
  for (const img of allImgs) {
    const src = resolveImageSrc(img);
    const sl = src.toLowerCase();

    // Skip document previews (PDF, DOCX, ZIP thumbnails, etc.) and icons
    const alt = (img.getAttribute('alt') || '').toLowerCase().trim();
    const className = (img.className && typeof img.className === 'string') ? img.className.toLowerCase() : '';
    
    // 1. Skip if alt, class name, or source URL indicates it is an icon or a document page preview
    if (alt.includes('icon') || className.includes('icon') || sl.includes('icon') || sl.includes('/pages/') || sl.includes('/page/')) {
      console.log('[CEP] Skipped icon or document page image:', alt, className, src);
      continue;
    }

    // 2. Skip based on alt text ending with non-image file extension (e.g. alt="document.pdf")
    const nonImageExts = ['.pdf', '.docx', '.doc', '.zip', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.csv', '.py', '.json', '.sh', '.js', '.html', '.css', '.md'];
    if (alt && nonImageExts.some(ext => alt.endsWith(ext))) {
      console.log('[CEP] Skipped document preview image based on alt text extension:', alt);
      continue;
    }

    // 3. Skip if image is inside a file chip/preview container
    const isInsideFileChip = img.closest('[data-testid="file-thumbnail"], [class*="FilePreview"], [class*="FileChip"], [class*="DocumentChip"], [class*="AttachmentChip"], [class*="file-attachment"], [class*="uploaded-file"]');
    if (isInsideFileChip) {
      const chipName = (chipText(isInsideFileChip) || '').toLowerCase().trim();
      const isImageFile = chipName.endsWith('.png') || chipName.endsWith('.jpg') || chipName.endsWith('.jpeg') || chipName.endsWith('.gif') || chipName.endsWith('.webp') || chipName.endsWith('.svg');
      if (!isImageFile) {
        console.log('[CEP] Skipped document preview image inside file chip:', src, 'chipName:', chipName);
        continue;
      } else {
        console.log('[CEP] Keeping image inside file chip because it represents an image file:', chipName);
      }
    }

    // 3b. Skip PDF/document page previews
    const parentPage = img.closest('[data-testid^="page-"]');
    const isPagePreview = /^page-\d+\./i.test(alt) || 
                          (parentPage && parentPage.getAttribute('data-testid') !== 'page-header') || 
                          sl.includes('/preview');
    if (isPagePreview) {
      console.log('[CEP] Skipped PDF/document page preview image:', alt, src);
      continue;
    }

    // 4. UUID-based skip fallback (using idMap)
    const uuidMatch = src.match(/\/files\/([a-f0-9-]{36})/);
    if (uuidMatch) {
      const fileId = uuidMatch[1];
      const mappedName = idMap[fileId];
      if (mappedName) {
        const ext = mappedName.split('.').pop()?.toLowerCase();
        const nonImageExtsList = ['pdf', 'docx', 'doc', 'zip', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv', 'py', 'json', 'sh', 'js', 'html', 'css', 'md'];
        if (nonImageExtsList.includes(ext)) {
          console.log('[CEP] Skipped document preview image via UUID match:', mappedName);
          continue;
        }
      }
    }

    // Log all attributes of the img element to the console for debugging
    const attrs = {};
    for (const attr of img.attributes) {
      attrs[attr.name] = attr.value;
    }
    console.log('[CEP] Image elements attributes:', JSON.stringify(attrs));
    console.log('[CEP] Resolved Image src:', src);

    // Skip avatar and profile picture elements (bypass for known uploaded/preview chat images)
    const isUploadedImg = img.getAttribute('data-test-id') === 'uploaded-img' || 
                          (img.className && typeof img.className === 'string' && img.className.includes('preview-image')) ||
                          (sl.includes('twimg.com') && !sl.includes('profile_images')) ||
                          (sl.includes('x.com') && sl.includes('/media/')) ||
                          (PLAT === 'gemini' && (sl.includes('googleusercontent') || sl.includes('google.com')) && !sl.includes('googleusercontent.com/a/') && !sl.includes('googleusercontent.com/a-/')) ||
                          (PLAT === 'grok' && (
                            sl.includes('x.ai') ||
                            sl.includes('twimg.com') ||
                            (sl.includes('x.com') && !sl.includes('profile_images') && !sl.includes('avatar')) ||
                            (sl.includes('grok.com') && !sl.includes('avatar') && !sl.includes('profile') && !sl.includes('logo') && !sl.includes('favicon'))
                          )) ||
                          // Additional generic upload URL checks:
                          sl.includes('blob:') || sl.includes('/files/') || sl.includes('oaiusercontent') ||
                          sl.includes('upload') || sl.includes('/api/organizations/') || sl.includes('fileuploads') ||
                          (sl.includes('googleusercontent') && !sl.includes('googleusercontent.com/a/') && !sl.includes('googleusercontent.com/a-/'));

    if (!src||src.startsWith('data:image/svg')) { console.log('[CEP] Skipped: empty or svg'); continue; }
    if (img.getAttribute('aria-hidden')==='true' && !isUploadedImg) { console.log('[CEP] Skipped: aria-hidden'); continue; }

    // Skip UI elements only if they are not known uploaded/chat images
    if (!isUploadedImg && isInsideUI(img)) { console.log('[CEP] Skipped: inside UI'); continue; }

    let isAvatar = false;
    if (!isUploadedImg) {
      isAvatar = img.closest('[class*="avatar" i], [class*="profile-pic" i], [class*="profile-img" i]') ||
                 (img.className && typeof img.className === 'string' && (img.className.includes('avatar') || img.className.includes('profile-pic') || img.className.includes('profile-img')));
    }
    if (isAvatar) { console.log('[CEP] Skipped: avatar/profile container'); continue; }

    if (sl.includes('/favicon')||sl.includes('/_next/')||sl.includes('/icons/')) { console.log('[CEP] Skipped: favicon/icon'); continue; }

    const isGeminiUpload = PLAT === 'gemini' && (sl.includes('googleusercontent') || sl.includes('google.com'));

    const nw=img.naturalWidth, nh=img.naturalHeight;
    console.log('[CEP] Image natural size:', nw, 'x', nh);
    if (!isGeminiUpload && nw>0&&nh>0&&nw<24&&nh<24) { console.log('[CEP] Skipped: too small'); continue; }
    
    // Skip avatars on non-upload URLs
    const isUpload = sl.includes('blob:')||sl.includes('/files/')||sl.includes('oaiusercontent')||
                     sl.includes('upload')||sl.includes('/api/organizations/')||sl.includes('fileuploads')||
                     sl.includes('googleusercontent')||sl.includes('google.com')||
                     sl.includes('x.ai')||sl.includes('twimg.com')||
                     isGeminiUpload;
    if (!isUpload&&sl.includes('avatar')) { console.log('[CEP] Skipped: non-upload avatar keyword'); continue; }

    // Fetch same-origin blob/data URLs directly in content script context
    let r;
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      console.log('[CEP] Fetching blob/data URL directly in content script');
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const dataUrl = await new Promise((ok, fail) => {
          const reader = new FileReader();
          reader.onload = () => ok(reader.result);
          reader.onerror = fail;
          reader.readAsDataURL(blob);
        });
        r = { dataUrl, mimeType: blob.type, size: blob.size };
      } catch(e) {
        r = { error: e.message };
      }
    } else {
      console.log('[CEP] Fetching remote URL via background script:', src);
      r = await bg('fetchAsBase64', {url:src});
    }

    if (r.error) {
      console.warn('[CEP] Fetch failed for image:', src, r.error);
    } else if (r.size > 200) {
      console.log('[CEP] Image fetched successfully, size:', r.size);
      imgs.push({src, dataUrl:r.dataUrl, mimeType:r.mimeType, size:r.size, alt:img.alt||''});
    } else {
      console.log('[CEP] Image skipped: size too small:', r.size);
    }
  }
  return imgs;
}

// ── Extract files from a turn ────────────────────────────────────────────────
async function extractFiles(turn, store, orgId, consumedStore = new Set()) {
  const files = [];
  const seen  = new Set();

  function add(fd) {
    const k = fd.name?.toLowerCase();
    if (!k) return;

    if (PLAT === 'chatgpt') {
      if (seen.has(k)) return;
      seen.add(k);
      files.push(fd);
      return;
    }

    // Normalize k to strip .txt if it ends with .txt and contains a binary extension before it
    const base = k.endsWith('.txt') ? k.slice(0, -4) : k;
    if (seen.has(base) || seen.has(k)) return;

    // Skip type badges if they are name-only
    if (fd.note === 'name only') {
      const upper = fd.name.toUpperCase().trim();
      if (TYPE_BADGES.has(upper)) {
        return;
      }
    }

    seen.add(base);
    seen.add(k);
    files.push(fd);
  }

  // ── ChatGPT: blobs already in store (intercepted by inject-early) ────────
  if (PLAT === 'chatgpt') {
    // Find all chips in this turn
    const turnChips = [];
    for (const chip of turn.querySelectorAll('[class*="FileCard"],[class*="AttachmentTile"],[class*="file-tile"],[data-message-file-name]')) {
      if (isInsideUI(chip)) continue;
      const name = chip.dataset?.messageFileName || chipText(chip);
      if (!name) continue;
      
      const nameLower = name.toLowerCase().trim();
      const hasDot = nameLower.includes('.');
      const isSpecial = nameLower === 'zip' || nameLower === 'pasted';
      if (!hasDot && !isSpecial) continue;
      
      const cleanName = name.replace(/^\d{10,13}_/, '');
      if (isUINoiseFileName(cleanName)) continue;
      if (turnChips.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) continue;
      turnChips.push({ name: cleanName, chip });
    }

    const unmatchedChips = [];
    for (const item of turnChips) {
      const stored = fromStore(item.name, store, consumedStore);
      if (stored) {
        consumedStore.add(stored);
        add({
          name: stored.filename || item.name,
          dataUrl: stored.dataUrl,
          mimeType: stored.mimeType,
          source: 'chip-matched',
          note: '✓ data'
        });
      } else {
        unmatchedChips.push(item);
      }
    }

    // Pair remaining unmatched chips with unmatched generic store files
    const unmatchedGenericStored = [];
    for (const [sk, sv] of Object.entries(store || {})) {
      if (consumedStore.has(sv)) continue;
      if (unmatchedGenericStored.includes(sv)) continue;
      const filename = sv.filename || '';
      const isGeneric = filename.toLowerCase().startsWith('file.') || filename.toLowerCase().startsWith('file_');
      if (isGeneric) {
        unmatchedGenericStored.push(sv);
      }
    }

    // Step 1: Pair by matching extension/type
    for (let cIdx = unmatchedChips.length - 1; cIdx >= 0; cIdx--) {
      const chipItem = unmatchedChips[cIdx];
      const chipExt = chipItem.name.split('.').pop()?.toLowerCase() || '';
      
      const gIdx = unmatchedGenericStored.findIndex(sv => {
        const gExt = (sv.filename || '').split('.').pop()?.toLowerCase() || '';
        return gExt === chipExt || mext(sv.mimeType) === chipExt;
      });
      
      if (gIdx !== -1) {
        const storedFile = unmatchedGenericStored.splice(gIdx, 1)[0];
        consumedStore.add(storedFile);
        add({
          name: storedFile.filename || chipItem.name,
          dataUrl: storedFile.dataUrl,
          mimeType: storedFile.mimeType,
          source: 'chip-paired-ext',
          note: '✓ data'
        });
        unmatchedChips.splice(cIdx, 1);
      }
    }

    // Step 2: Pair remaining by index order
    const pairCount = Math.min(unmatchedChips.length, unmatchedGenericStored.length);
    for (let idx = 0; idx < pairCount; idx++) {
      const chipItem = unmatchedChips[idx];
      const storedFile = unmatchedGenericStored[idx];
      consumedStore.add(storedFile);
      add({
        name: storedFile.filename || chipItem.name,
        dataUrl: storedFile.dataUrl,
        mimeType: storedFile.mimeType,
        source: 'chip-paired-fallback',
        note: '✓ data'
      });
    }

    // Step 3: Remaining unmatched chips are name-only
    for (let idx = pairCount; idx < unmatchedChips.length; idx++) {
      const chipItem = unmatchedChips[idx];
      add({
        name: chipItem.name,
        source: 'chip',
        note: 'name only'
      });
    }
  }

  // ── Claude: scan chips, fetch via Files API ──────────────────────────────
  if (PLAT === 'claude') {
    const chipSels = [
      '[data-testid="file-thumbnail"]','[data-testid*="attachment"]',
      '[class*="FilePreview"]','[class*="FileChip"]','[class*="DocumentChip"]',
      '[class*="AttachmentChip"]','[class*="file-attachment"]','[class*="uploaded-file"]',
      'button[aria-label*=".pdf"]','button[aria-label*=".docx"]','button[aria-label*=".zip"]',
      'div[role="button"][aria-label]',
      '[data-testid*="."]:not([data-testid^="page-"])'
    ];
    for (const sel of chipSels) {
      for (const chip of turn.querySelectorAll(sel)) {
        if (isInsideUI(chip)) continue;
        const name = chipText(chip);
        if (!name) continue;
        
        // Filter out dummy chips (must contain a dot or be a special identifier)
        const nameLower = name.toLowerCase().trim();
        const hasDot = nameLower.includes('.');
        const isSpecial = nameLower === 'zip' || nameLower === 'pasted';
        if (!hasDot && !isSpecial) continue;
        
        const cleanName = name.replace(/^\d{10,13}_/, '');
        if (isUINoiseFileName(cleanName) || seen.has(cleanName.toLowerCase())) continue;
        const fd = {name: cleanName, source:'claude-chip', note:'name only'};

        // Check store first
        const stored = fromStore(cleanName, store, consumedStore);
        if (stored) {
          consumedStore.add(stored);
          fd.name = stored.filename || fd.name;
          fd.dataUrl=stored.dataUrl;
          fd.mimeType=stored.mimeType;
          fd.note='✓ intercepted';
          add(fd);
          continue;
        }

        // Check if it's an image file and try to extract it from the DOM img source directly
        const cleanNameLower = cleanName.toLowerCase();
        const isImage = cleanNameLower.endsWith('.png') || cleanNameLower.endsWith('.jpg') || cleanNameLower.endsWith('.jpeg') || cleanNameLower.endsWith('.gif') || cleanNameLower.endsWith('.webp') || cleanNameLower.endsWith('.svg');
        if (isImage) {
          const imgEl = chip.querySelector('img');
          if (imgEl) {
            const src = resolveImageSrc(imgEl);
            if (src && !src.startsWith('data:image/svg')) {
              console.log('[CEP] Found img inside image file chip, fetching source directly:', src);
              let r;
              if (src.startsWith('blob:') || src.startsWith('data:')) {
                try {
                  const resp = await fetch(src);
                  const blob = await resp.blob();
                  const dataUrl = await new Promise((ok, fail) => {
                    const reader = new FileReader();
                    reader.onload = () => ok(reader.result);
                    reader.onerror = fail;
                    reader.readAsDataURL(blob);
                  });
                  r = { dataUrl, mimeType: blob.type, size: blob.size };
                } catch(e) {
                  r = { error: e.message };
                }
              } else {
                r = await bg('fetchAsBase64', {url:src});
              }
              if (r && !r.error && r.size > 200) {
                fd.dataUrl = r.dataUrl;
                fd.mimeType = r.mimeType || 'image/png';
                fd.note = '✓ intercepted-dom';
                add(fd);
                continue;
              }
            }
          }
        }

        // Find file ID
        let fileId = null;
        for (const attr of chip.attributes) {
          if (/^[a-f0-9-]{36}$/.test(attr.value)) { fileId=attr.value; break; }
          const m=attr.value.match(/\/files\/([a-f0-9-]{36})/); if (m){fileId=m[1];break;}
        }
        if (!fileId) {
          const m=chip.innerHTML.match(/\/files\/([a-f0-9-]{36})/); if(m) fileId=m[1];
        }

        if (fileId && orgId) {
          // Register name with page hook
          window.dispatchEvent(new CustomEvent('__cepRegName',{detail:{fileId,filename:cleanName}}));
          // Try Claude Files API via background
          for (const suf of ['/content','']) {
            const url=`https://api2.claude.ai/api/organizations/${orgId}/files/${fileId}${suf}`;
            const r=await bg('fetchAsBase64',{url});
            if (!r.error) {
              fd.dataUrl=r.dataUrl;
              fd.mimeType=r.mimeType;
              fd.note='✓ claude-api';
              // If we matched the API response, let's see if there is a store file with this dataurl to consume it
              for (const [sk, sv] of Object.entries(store||{})) {
                if (sv.dataUrl === r.dataUrl) consumedStore.add(sv);
              }
              break;
            }
          }
        }
        add(fd);
      }
    }

    // --- TEXT-BASED FALLBACK FOR CLAUDE IN-TURN FILES ---
    // If a file from the store is mentioned in this turn's text but wasn't found by the chip selector
    // (e.g. PDF rendered as pages), we match it directly from the store!
    const turnTextLower = (turn.innerText || '').toLowerCase();
    for (const [k, v] of Object.entries(store || {})) {
      if (consumedStore.has(v)) continue;
      if (!v.filename) continue;
      
      const cleanName = v.filename.replace(/^\d{10,13}_/, '');
      if (isUINoiseFileName(cleanName) || seen.has(cleanName.toLowerCase())) continue;
      
      // If the turn's text contains the clean filename (case insensitive)
      if (turnTextLower.includes(cleanName.toLowerCase())) {
        console.log('[CEP] Matched store file to Claude turn by text content:', cleanName);
        consumedStore.add(v);
        
        // Ensure idMap has the mapping for this file's UUID
        const uuidMatch = v.url?.match(/\/files\/([a-f0-9-]{36})/);
        if (uuidMatch) {
          idMap[uuidMatch[1]] = cleanName;
        }

        add({
          name: v.filename,
          dataUrl: v.dataUrl,
          mimeType: v.mimeType,
          source: 'claude-text-matched',
          note: '✓ data'
        });
      }
    }
  }

  // ── Gemini & Grok / Generic Fallback ──────────────────────────────────────
  if (PLAT === 'gemini' || PLAT === 'grok' || PLAT === 'unknown') {
    // Helper: check if text looks like a real filename (not a sentence)
    function isLikelyFileName(text) {
      if (!text || text.length > 120) return false;
      // Must have a file extension pattern (word.ext at the end)
      if (/\.\w{1,10}$/.test(text.trim())) return true;
      // Special keywords
      if (/^(zip|pasted)$/i.test(text.trim())) return true;
      // Reject text with multiple spaces (looks like a sentence, not a filename)
      if ((text.match(/ /g) || []).length > 3) return false;
      // Reject text starting with common sentence patterns
      if (/^(On |The |A |An |In |To |It |This |That |From |Moving |Finally |Below |Above )/i.test(text)) return false;
      return false;
    }

    // Specific file-related selectors (high confidence)
    const specificSels = [
      '[class*="file-chip" i]', '[class*="attachment" i]', '[class*="file-preview" i]',
      '[class*="document-chip" i]', '[class*="upload-file" i]', 'a[href*="blob:"]', 'a[download]',
      'button[aria-label*="file" i]', 'button[aria-label*="attachment" i]',
      '[class*="file" i]', '[class*="doc" i]', 'div[role="button"]'
    ];
    // Broad fallback selectors (low confidence — only use if nothing found above)
    const broadSels = ['span', 'p', 'a'];

    const turnChips = [];
    let foundSpecific = false;

    // First pass: try specific selectors
    for (const sel of specificSels) {
      for (const chip of querySelectorAllShadow(sel, turn)) {
        if (isInsideUI(chip)) continue;
        const name = chipText(chip);
        if (!name) continue;
        const cleanName = name.replace(/^\d{10,13}_/, '');
        
        const nameLower = cleanName.toLowerCase().trim();
        const hasDot = nameLower.includes('.');
        const isSpecial = nameLower === 'zip' || nameLower === 'pasted';
        if (!hasDot && !isSpecial) continue;
        
        if (isUINoiseFileName(cleanName) || seen.has(cleanName.toLowerCase())) continue;
        if (turnChips.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) continue;
        turnChips.push({ name: cleanName, chip });
        foundSpecific = true;
      }
    }

    // Second pass: only try broad selectors if no specific chips found, with strict filename check
    if (!foundSpecific) {
      for (const sel of broadSels) {
        for (const chip of querySelectorAllShadow(sel, turn)) {
          if (isInsideUI(chip)) continue;
          const name = chipText(chip);
          if (!name) continue;
          const cleanName = name.replace(/^\d{10,13}_/, '');
          
          // Strict filter: must look like an actual filename, not a sentence
          if (!isLikelyFileName(cleanName)) continue;
          
          if (isUINoiseFileName(cleanName) || seen.has(cleanName.toLowerCase())) continue;
          if (turnChips.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) continue;
          turnChips.push({ name: cleanName, chip });
        }
      }
    }

    const unmatchedChips = [];
    for (const item of turnChips) {
      const stored = fromStore(item.name, store, consumedStore);
      if (stored) {
        consumedStore.add(stored);
        add({
          name: stored.filename || item.name,
          dataUrl: stored.dataUrl,
          mimeType: stored.mimeType,
          source: PLAT + '-chip-matched',
          note: '✓ intercepted'
        });
      } else {
        unmatchedChips.push(item);
      }
    }

    // Pair remaining unmatched chips with unmatched generic store files
    const unmatchedGenericStored = [];
    for (const [sk, sv] of Object.entries(store || {})) {
      if (consumedStore.has(sv)) continue;
      if (unmatchedGenericStored.includes(sv)) continue;
      const filename = sv.filename || '';
      const isGeneric = filename.toLowerCase().startsWith('file.') || filename.toLowerCase().startsWith('file_');
      if (isGeneric) {
        unmatchedGenericStored.push(sv);
      }
    }

    // Step 1: Pair by matching extension/type
    for (let cIdx = unmatchedChips.length - 1; cIdx >= 0; cIdx--) {
      const chipItem = unmatchedChips[cIdx];
      const chipExt = chipItem.name.split('.').pop()?.toLowerCase() || '';
      
      const gIdx = unmatchedGenericStored.findIndex(sv => {
        const gExt = (sv.filename || '').split('.').pop()?.toLowerCase() || '';
        return gExt === chipExt || mext(sv.mimeType) === chipExt;
      });
      
      if (gIdx !== -1) {
        const storedFile = unmatchedGenericStored.splice(gIdx, 1)[0];
        consumedStore.add(storedFile);
        add({
          name: storedFile.filename || chipItem.name,
          dataUrl: storedFile.dataUrl,
          mimeType: storedFile.mimeType,
          source: PLAT + '-chip-paired-ext',
          note: '✓ intercepted'
        });
        unmatchedChips.splice(cIdx, 1);
      }
    }

    // Step 2: Pair remaining by index order
    const pairCount = Math.min(unmatchedChips.length, unmatchedGenericStored.length);
    for (let idx = 0; idx < pairCount; idx++) {
      const chipItem = unmatchedChips[idx];
      const storedFile = unmatchedGenericStored[idx];
      consumedStore.add(storedFile);
      add({
        name: storedFile.filename || chipItem.name,
        dataUrl: storedFile.dataUrl,
        mimeType: storedFile.mimeType,
        source: PLAT + '-chip-paired-fallback',
        note: '✓ intercepted'
      });
    }

    // Step 3: Remaining unmatched chips are name-only
    for (let idx = pairCount; idx < unmatchedChips.length; idx++) {
      const chipItem = unmatchedChips[idx];
      add({
        name: chipItem.name,
        source: PLAT + '-chip',
        note: 'name only'
      });
    }
  }

  return files;
}

function chipText(el) {
  if (PLAT === 'chatgpt') {
    const al = el.getAttribute('aria-label')||el.title||'';
    if (al&&al.length<200&&(al.includes('.')||al.length>2)) return al.trim();
    for (const s of el.querySelectorAll('span,p,[class*="name"],[class*="title"],[class*="filename"]')) {
      const t=s.innerText?.trim();
      if (t&&t.length>1&&t.length<200&&!t.includes('\n')) return t;
    }
    return el.innerText?.trim()?.split('\n')[0]?.trim()||null;
  }

  // Check data-testid attribute containing a dot first (useful for dynamically named chips like PDF on Claude)
  const dt = el.getAttribute('data-testid');
  if (dt && dt.includes('.') && dt.length < 200 && !dt.toLowerCase().startsWith('page-')) {
    return dt.trim();
  }

  // Check alt attribute of an image inside (useful for PDF/docx thumbnails without text labels)
  const img = el.querySelector('img');
  if (img) {
    const alt = img.getAttribute('alt');
    if (alt && alt.includes('.') && alt.length < 200 && !alt.toLowerCase().startsWith('page-')) {
      return alt.trim();
    }
  }

  const al = el.getAttribute('aria-label')||el.title||'';
  let resolved = null;
  if (al && al.length < 200) {
    const cleanAl = al.trim();
    if (!TYPE_BADGES.has(cleanAl.toUpperCase())) {
      if (cleanAl.includes('.') || cleanAl.length > 2) {
        resolved = cleanAl;
      }
    }
  }
  
  if (!resolved) {
    for (const s of el.querySelectorAll('span,p,[class*="name"],[class*="title"],[class*="filename"]')) {
      const t = s.innerText?.trim();
      if (t && t.length > 1 && t.length < 200 && !t.includes('\n')) {
        const upperT = t.toUpperCase();
        if (!TYPE_BADGES.has(upperT)) {
          resolved = t;
          break;
        }
      }
    }
  }
  
  if (!resolved) {
    const lines = el.innerText?.trim()?.split('\n') || [];
    for (const line of lines) {
      const cleanLine = line.trim();
      if (cleanLine.length > 1 && cleanLine.length < 200) {
        const upper = cleanLine.toUpperCase();
        if (!TYPE_BADGES.has(upper)) {
          resolved = cleanLine;
          break;
        }
      }
    }
  }

  if (!resolved) {
    resolved = el.innerText?.trim()?.split('\n')[0]?.trim() || null;
  }

  // Clean comma-joined details if the first part has an extension
  if (resolved && resolved.includes(',')) {
    const parts = resolved.split(',');
    const part0 = parts[0].trim();
    if (/\.[a-zA-Z0-9]{2,5}$/.test(part0)) {
      resolved = part0;
    }
  }
  return resolved;
}

// ── Auto-expand collapsed sections before extraction ──────────────────────────
// Claude hides tool results ("Ran X commands"), artifacts, and long messages
// behind collapsible panels. We click them open so innerText captures everything.
// IMPORTANT: Only target buttons INSIDE the conversation area — never touch
// sidebar, menus, toolbars, model selectors, or any other UI controls.
async function expandCollapsedSections() {
  // Find the conversation container — do NOT touch anything outside it
  const chatArea = document.querySelector(
    '[data-testid="human-turn"], [data-testid="ai-turn"]'
  )?.closest('[class*="conversation" i], [class*="thread" i], main')
    || document.querySelector('main')
    || null;

  if (!chatArea) return;

  const clicked = new Set();

  // Only look for buttons INSIDE the conversation area
  const buttons = chatArea.querySelectorAll('button');
  for (const el of buttons) {
    // NEVER click buttons inside nav, sidebar, toolbar, menu, header, footer
    if (el.closest(
      'nav, aside, header, footer, ' +
      '[role="navigation"], [role="menu"], [role="toolbar"], [role="menubar"], ' +
      '[class*="sidebar" i], [class*="Sidebar"], ' +
      '[class*="composer" i], [class*="input-area" i], ' +
      'form'
    )) continue;

    const txt = (el.innerText || el.textContent || '').trim();

    // Only click buttons that match Claude's tool result toggle patterns
    const isToolResultToggle =
      /^ran \d+ commands?/i.test(txt) ||
      /^ran a command/i.test(txt) ||
      /^ran \d+ commands?, (viewed|created|read)/i.test(txt) ||
      /^(viewed|created|read) (a file|\d+ files?)/i.test(txt) ||
      /^show more$/i.test(txt) ||
      /^view more$/i.test(txt) ||
      /^see more$/i.test(txt);

    if (isToolResultToggle && !clicked.has(el)) {
      clicked.add(el);
      try {
        el.click();
      } catch(_) {}
    }
  }

  // Also open <details> elements inside the chat area only
  for (const d of chatArea.querySelectorAll('details:not([open])')) {
    d.setAttribute('open', '');
  }

  // Wait for DOM to update after expansions
  if (clicked.size > 0) {
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main extraction ───────────────────────────────────────────────────────────
async function extractAll() {
  // Expand all collapsed sections first so we can capture hidden content
  await expandCollapsedSections();

  const orgId = PLAT==='claude' ? getOrgId() : null;
  const {files:store, authHeader, idMap} = await getStore();
  console.log("[CEP] extractAll - Store keys:", Object.keys(store || {}), "hasAuth:", !!authHeader, "idMap:", idMap);
  


  const consumedStore = new Set();
  const seenImageSrcs = new Set(); // Deduplicate images across turns

  const result = {
    platform:PLAT, url:location.href,
    extractedAt:new Date().toISOString(),
    messages:[], allImages:[], allFiles:[], errors:[]
  };

  const turns = findTurns();
  const seenTexts = new Set();  // Track seen text to deduplicate messages

  for (let i=0; i<turns.length; i++) {
    const turn  = turns[i];
    const role  = getRole(turn);
    const text  = extractText(turn);

    // Skip UI noise that slipped through turn detection
    if (text && isUINoiseText(text)) continue;

    // Deduplicate: skip messages with identical text content
    const textKey = text.trim().slice(0, 300);
    if (textKey && seenTexts.has(textKey)) continue;
    if (textKey) seenTexts.add(textKey);

    const images= await extractImages(turn, idMap);
    const files = await extractFiles(turn, store, orgId, consumedStore);

    // Deduplicate images across turns
    // ChatGPT: use full URL (different query params = different images)
    // Grok: normalize asset URLs (strip /content, /preview-image suffixes)
    // Claude/others: strip query params (same image with cache-busting params)
    const finalImages = images.filter(img => {
      let key;
      if (PLAT === 'chatgpt') {
        key = img.src || img.dataUrl || '';
      } else {
        key = (img.src || '').replace(/\?.*$/, '') || img.dataUrl || '';
        // Grok: normalize asset endpoint suffixes
        if (PLAT === 'grok' && key.includes('assets.grok.com')) {
          key = key.replace(/\/(content|preview-image|original-image|original|image|thumb|thumbnail)$/i, '');
        }
      }
      if (!key || seenImageSrcs.has(key)) return false;
      seenImageSrcs.add(key);
      return true;
    });

    result.allImages.push(...finalImages);
    result.allFiles.push(...files);
    if (text||finalImages.length||files.length) {
      result.messages.push({index:i, role, text, images:finalImages, files});
    }
  }

  // ── Gemini full-page image fallback ─────────────────────────────────────────
  // Gemini's DOM structure often places images outside of turn containers.
  // If we found zero images from turns, do a full-page scan.
  if (PLAT === 'gemini' && result.allImages.length === 0) {
    console.log('[CEP] Gemini: No images found in turns, scanning full page...');
    const mainArea = document.querySelector('main') || document.body;
    const pageImgs = mainArea.querySelectorAll('img');
    console.log('[CEP] Gemini full-page scan found', pageImgs.length, 'img elements');
    
    for (const img of pageImgs) {
      const src = resolveImageSrc(img);
      if (!src || src.startsWith('data:image/svg')) continue;
      const sl = src.toLowerCase();
      
      // Only grab actual content images (uploaded/generated), not UI chrome
      const isContent = sl.includes('googleusercontent') || sl.includes('google.com/image') ||
                        sl.includes('blob:') || sl.includes('/files/') || sl.includes('upload') ||
                        sl.includes('lh3.') || sl.includes('lh4.') || sl.includes('lh5.') || sl.includes('lh6.') ||
                        sl.includes('ggpht');
      if (!isContent) continue;
      
      // Skip tiny icons and avatars
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (nw > 0 && nh > 0 && nw < 24 && nh < 24) continue;
      if (sl.includes('avatar') || sl.includes('profile') || sl.includes('favicon') || sl.includes('icon')) continue;
      
      // Skip Google profile/avatar pictures: /a/ path = avatar on googleusercontent
      if (sl.includes('googleusercontent.com/a/') || sl.includes('googleusercontent.com/a-/')) {
        console.log('[CEP] Gemini fallback: skipping Google avatar URL:', src.substring(0, 80));
        continue;
      }
      // Skip small displayed images (profile pics are often 28-48px CSS size)
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.width < 64 && rect.height < 64) {
        console.log('[CEP] Gemini fallback: skipping small displayed image:', rect.width, 'x', rect.height);
        continue;
      }
      
      // Skip if already seen
      if (seenImageSrcs.has(src)) continue;
      seenImageSrcs.add(src);
      
      console.log('[CEP] Gemini fallback: fetching image:', src.substring(0, 120));
      let r;
      if (src.startsWith('blob:') || src.startsWith('data:')) {
        try {
          const resp = await fetch(src);
          const blob = await resp.blob();
          const dataUrl = await new Promise((ok, fail) => {
            const reader = new FileReader();
            reader.onload = () => ok(reader.result);
            reader.onerror = fail;
            reader.readAsDataURL(blob);
          });
          r = { dataUrl, mimeType: blob.type, size: blob.size };
        } catch(e) {
          r = { error: e.message };
        }
      } else {
        r = await bg('fetchAsBase64', {url: src});
      }
      
      if (r.error) {
        console.warn('[CEP] Gemini fallback fetch failed:', src, r.error);
      } else if (r.size > 200) {
        console.log('[CEP] Gemini fallback image OK, size:', r.size);
        result.allImages.push({
          src, dataUrl: r.dataUrl, mimeType: r.mimeType, size: r.size, alt: img.alt || ''
        });
      }
    }
    
    // Also check for images inside shadow roots on the whole page
    if (result.allImages.length === 0) {
      console.log('[CEP] Gemini: Still no images, trying deep shadow DOM scan...');
      const shadowImgs = querySelectorAllShadow('img', mainArea);
      console.log('[CEP] Gemini shadow scan found', shadowImgs.length, 'images');
      for (const img of shadowImgs) {
        const src = resolveImageSrc(img);
        if (!src || src.startsWith('data:image/svg')) continue;
        const sl = src.toLowerCase();
        const isContent = sl.includes('googleusercontent') || sl.includes('google.com/image') ||
                          sl.includes('blob:') || sl.includes('/files/') || sl.includes('upload') ||
                          sl.includes('lh3.') || sl.includes('lh4.') || sl.includes('lh5.') || sl.includes('lh6.') ||
                          sl.includes('ggpht');
        if (!isContent) continue;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (nw > 0 && nh > 0 && nw < 24 && nh < 24) continue;
        if (sl.includes('avatar') || sl.includes('profile') || sl.includes('favicon') || sl.includes('icon')) continue;
        // Skip Google avatar URLs
        if (sl.includes('googleusercontent.com/a/') || sl.includes('googleusercontent.com/a-/')) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 64 && rect.height < 64) continue;
        if (seenImageSrcs.has(src)) continue;
        seenImageSrcs.add(src);
        
        let r;
        if (src.startsWith('blob:') || src.startsWith('data:')) {
          try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const dataUrl = await new Promise((ok, fail) => {
              const reader = new FileReader();
              reader.onload = () => ok(reader.result);
              reader.onerror = fail;
              reader.readAsDataURL(blob);
            });
            r = { dataUrl, mimeType: blob.type, size: blob.size };
          } catch(e) { r = { error: e.message }; }
        } else {
          r = await bg('fetchAsBase64', {url: src});
        }
        if (!r.error && r.size > 200) {
          result.allImages.push({
            src, dataUrl: r.dataUrl, mimeType: r.mimeType, size: r.size, alt: img.alt || ''
          });
        }
      }
    }
    console.log('[CEP] Gemini final image count after fallback:', result.allImages.length);
  }

  function detectImageMime(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const base64 = parts[1];
    
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR') && base64.includes('WEBP')) return 'image/webp';
    return null;
  }

  // Add any generic/unconsumed store files that were not matched to any DOM chip
  // Skip this fallback loop for ChatGPT and Claude because they have reliable DOM chips
  // and we don't want to leak historical files from other chats/turns.
  if (PLAT !== 'claude' && PLAT !== 'chatgpt') {
    for (const [k, v] of Object.entries(store || {})) {
      if (consumedStore.has(v)) continue;
      if (!v.filename) continue;

      // On Gemini, skip generic "file" or "file.txt" entries from the intercepted store
      // These are metadata artifacts, not actual user files
      if (PLAT === 'gemini') {
        const fn = v.filename.toLowerCase().trim();
        if (fn === 'file' || fn === 'file.txt' || fn === 'upload' || fn === 'blob') {
          console.log('[CEP] Skipping generic Gemini store entry:', v.filename);
          continue;
        }
      }

      let mime = (v.mimeType || '').toLowerCase();
      let filename = v.filename;
      let isImage = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(filename);
      
      // Attempt magic number recovery if not already known image
      if (!isImage && v.dataUrl) {
        const detectedMime = detectImageMime(v.dataUrl);
        if (detectedMime) {
          mime = detectedMime;
          isImage = true;
          // Rename if extension is .bin or missing
          const ext = detectedMime.split('/')[1];
          if (filename.toLowerCase().endsWith('.bin')) {
            filename = filename.slice(0, -4) + '.' + (ext === 'jpeg' ? 'jpg' : ext);
          } else if (!filename.includes('.')) {
            filename = filename + '.' + (ext === 'jpeg' ? 'jpg' : ext);
          }
          console.log(`[CEP] Recovered image from binary data: ${v.filename} -> ${filename} (${detectedMime})`);
        }
      }

      if (isImage) {
        // Add to allImages if not already present
        const srcUrl = v.url || filename;
        result.allImages.push({
          src: srcUrl,
          dataUrl: v.dataUrl,
          mimeType: mime,
          size: v.size || (v.dataUrl ? Math.round(v.dataUrl.split(',')[1].length * 0.75) : 0),
          alt: filename
        });
      } else {
        result.allFiles.push({
          name: filename,
          dataUrl: v.dataUrl,
          mimeType: mime,
          source: 'intercepted-fallback',
          note: '✓ data'
        });
      }
      consumedStore.add(v);
    }
  }

  // Deduplicate images - multi-key approach:
  // 1. Content-based: dataUrl prefix (catches same content from different URLs)
  // 2. URL-based: normalized src (catches same asset from different endpoints)
  // For Grok: strip trailing path suffixes like /content, /preview-image, /original-image
  // For ChatGPT: use full URL (different query params = different images)
  // For Claude/Gemini: strip query params
  const si=new Set();
  function normalizeImageUrl(src) {
    if (!src) return '';
    let url = src;
    // Grok: strip asset endpoint suffixes to get base asset path
    if (PLAT === 'grok' && url.includes('assets.grok.com')) {
      url = url.replace(/\/(content|preview-image|original-image|original|image|thumb|thumbnail)$/i, '');
    }
    // Strip query params for non-ChatGPT
    if (PLAT !== 'chatgpt') {
      url = url.replace(/\?.*$/, '');
    }
    return url;
  }
  result.allImages = result.allImages.filter(i => {
    const keys = [];
    // Key 1: content-based (dataUrl prefix)
    if (i.dataUrl && i.dataUrl.length > 50) {
      keys.push('data:' + i.dataUrl.substring(0, 200));
    }
    // Key 2: normalized URL
    const normUrl = normalizeImageUrl(i.src);
    if (normUrl) keys.push('url:' + normUrl);
    
    // If ANY key was already seen, it's a duplicate
    if (keys.some(k => si.has(k))) return false;
    // Add all keys
    keys.forEach(k => si.add(k));
    return true;
  });

  // Deduplicate files, preferring versions with dataUrl
  const fileMap = new Map();
  for (const f of result.allFiles) {
    const key = f.name.toLowerCase();
    const existing = fileMap.get(key);
    if (!existing || (!existing.dataUrl && f.dataUrl)) {
      fileMap.set(key, f);
    }
  }
  result.allFiles = Array.from(fileMap.values());

  // Move image files from files to images list (for visual rendering in tray/capsule)
  const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
  if (result.messages) {
    for (const msg of result.messages) {
      if (!msg.files) continue;
      const remainingFiles = [];
      for (const file of msg.files) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext && imageExtensions.has(ext) && file.dataUrl) {
          console.log(`[CEP] Reclassifying file to image: ${file.name}`);
          if (!msg.images) msg.images = [];
          const alreadyHasImage = msg.images.some(img => 
            (img.alt && img.alt.toLowerCase() === file.name.toLowerCase()) || 
            (img.dataUrl === file.dataUrl)
          );
          if (!alreadyHasImage) {
            msg.images.push({
              src: file.name,
              dataUrl: file.dataUrl,
              mimeType: file.mimeType || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              size: file.dataUrl.length,
              alt: file.name
            });
            const alreadyInAllImages = result.allImages.some(img => 
              (img.alt && img.alt.toLowerCase() === file.name.toLowerCase()) || 
              (img.dataUrl === file.dataUrl)
            );
            if (!alreadyInAllImages) {
              result.allImages.push({
                src: file.name,
                dataUrl: file.dataUrl,
                mimeType: file.mimeType || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                size: file.dataUrl.length,
                alt: file.name
              });
            }
          }
        } else {
          remainingFiles.push(file);
        }
      }
      msg.files = remainingFiles;
    }
  }

  // Sync result.allFiles to exclude reclassified images
  result.allFiles = result.allFiles.filter(file => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const isImageFile = ext && imageExtensions.has(ext) && file.dataUrl;
    return !isImageFile;
  });

  return result;
}

// ── File drop injection ───────────────────────────────────────────────────────
function dataUrlToFile(dataUrl, name) {
  try {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const isBase64 = arr[0].includes('base64');
    
    let u8arr;
    if (isBase64) {
      const bstr = atob(arr[1]);
      let n = bstr.length;
      u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
    } else {
      const decoded = decodeURIComponent(arr[1]);
      const encoder = new TextEncoder();
      u8arr = encoder.encode(decoded);
    }
    return new File([u8arr], name, { type: mime });
  } catch (e) {
    console.error('[CEP] Error converting dataUrl to file:', e);
    return null;
  }
}

async function dropCapsule(cap) {
  const inputSel = (SEL[PLAT]||SEL.claude).input;
  const input = document.querySelector(inputSel);
  if (!input) { toast('❌ Input not found', true); return; }

  // ── 1. Inject text ────────────────────────────────────────────────────────
  const text = cap.promptText||cap.rawText||'';
  if (text) {
    input.focus();
    if (input.tagName==='TEXTAREA') {
      const ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
      ns?.call(input,text);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    } else {
      input.focus();
      document.execCommand('selectAll',false);
      document.execCommand('insertText',false,text);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    }
    // Wait for ProseMirror/React to finish re-rendering after text insertion
    // before injecting files. This prevents the editor from swallowing file events.
    await new Promise(r => setTimeout(r, 500));
  }

  // ── 2. Build file objects ─────────────────────────────────────────────────
  const allFiles=[];
  let ii=0;
  for (const img of (cap.images||[]).filter(i=>i.dataUrl)) {
    try {
      const mime=img.dataUrl.split(',')[0].match(/:(.*?);/)[1];
      const ext=mime.split('/')[1]?.split(';')[0]||'jpg';
      const fileObj = dataUrlToFile(img.dataUrl,`image_${++ii}.${ext}`);
      if (fileObj) allFiles.push(fileObj);
    } catch(e) { console.warn('[CEP] Bad image dataUrl:', e); }
  }
  for (const f of (cap.files||[]).filter(f=>f.dataUrl)) {
    try {
      const fileObj = dataUrlToFile(f.dataUrl, f.name);
      if (fileObj) allFiles.push(fileObj);
    } catch(e) { console.warn('[CEP] Bad file dataUrl:', e); }
  }

  if (!allFiles.length) { toast(`💊 "${cap.name}" dropped!`); return; }

  // ── 3. Inject files ───────────────────────────────────────────────────────
  let injected = false;

  // Strategy A: find hidden file input and set files directly (universal primary)
  if (PLAT === 'chatgpt' || PLAT === 'gemini' || PLAT === 'grok' || PLAT === 'claude') {
    // Find composer container first to narrow down file input selection
    const composer = document.querySelector('form') || 
                     input.closest('[class*="composer" i],[class*="Composer" i],[class*="input" i],[class*="Input" i]') ||
                     document.body;
    let fileInputs = querySelectorAllShadow('input[type="file"]', composer);
    if (fileInputs.length === 0) {
      fileInputs = querySelectorAllShadow('input[type="file"]');
    }

    for (const fi of fileInputs) {
      try {
        const dt = new DataTransfer();
        allFiles.forEach(f => dt.items.add(f));
        Object.defineProperty(fi, 'files', { value: dt.files, configurable: true, writable: true });
        fi.dispatchEvent(new Event('change', { bubbles: true }));
        fi.dispatchEvent(new Event('input',  { bubbles: true }));
        injected = true;
        await new Promise(r => setTimeout(r, 150));
        break; // Break on first successful injection to prevent duplicate uploads
      } catch(e) {
        console.warn('[CEP] Strategy A file input injection failed:', fi, e);
      }
    }
  }

  // Strategy B: paste with files on the editor (works for images in Claude, Gemini, and Grok)
  // IMPORTANT: Always run on Claude/Gemini/Grok even if Strategy A "succeeded", because
  // modern rich text editors rely on intercepting paste events to upload attachments.
  if (!injected || PLAT === 'claude' || PLAT === 'gemini' || PLAT === 'grok') {
    input.focus();
    const dt = new DataTransfer();
    allFiles.forEach(f => dt.items.add(f));
    
    const pasteEvt = new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt
    });
    try {
      Object.defineProperty(pasteEvt, 'clipboardData', { get() { return dt; }, configurable: true });
    } catch(_) {}
    
    input.dispatchEvent(pasteEvt);
    await new Promise(r => setTimeout(r, 150));
    // If ProseMirror/Lexical didn't handle it, escalate to document
    if (!pasteEvt.defaultPrevented) {
      const dt2 = new DataTransfer();
      allFiles.forEach(f => dt2.items.add(f));
      const docPasteEvt = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt2
      });
      try {
        Object.defineProperty(docPasteEvt, 'clipboardData', { get() { return dt2; }, configurable: true });
      } catch(_) {}
      document.dispatchEvent(docPasteEvt);
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Strategy C: drag-and-drop on the composer area (ChatGPT primary)
  if (PLAT === 'chatgpt') {
    const zone = document.querySelector('form') ||
                 input.closest('[class*="composer" i],[class*="Composer" i]') ||
                 input.closest('form') ||
                 input.parentElement;
    if (zone) {
      const dt = new DataTransfer();
      allFiles.forEach(f => dt.items.add(f));
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      zone.dispatchEvent(new DragEvent('dragenter', opts));
      await new Promise(r => setTimeout(r, 50));
      zone.dispatchEvent(new DragEvent('dragover',  opts));
      await new Promise(r => setTimeout(r, 50));
      zone.dispatchEvent(new DragEvent('drop',      opts));
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Strategy D: simulate user clicking the upload button then set files
  if (PLAT === 'claude' && !injected) {
    const uploadBtn = document.querySelector(
      'button[aria-label*="upload" i], button[aria-label*="attach" i], ' +
      'button[aria-label*="file" i], button[data-testid*="upload" i], ' +
      'label[for] input[type="file"]'
    );
    if (uploadBtn) {
      const fi = uploadBtn.tagName === 'INPUT' ? uploadBtn
               : uploadBtn.querySelector('input[type="file"]')
               || document.querySelector('input[type="file"]');
      if (fi) {
        const dt = new DataTransfer();
        allFiles.forEach(f => dt.items.add(f));
        Object.defineProperty(fi, 'files', { value: dt.files, configurable: true });
        fi.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  toast(`💊 "${cap.name}" — text + ${allFiles.length} file(s)!`);
}

// ── Capsule tray ──────────────────────────────────────────────────────────────
let tray=null;

// ── Styles & Launcher ────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('cep-global-styles')) return;
  const st = document.createElement('style');
  st.id = 'cep-global-styles';
  st.textContent = `
    #cep-launcher {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(124, 106, 247, 0.15);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1.5px solid rgba(124, 106, 247, 0.45);
      cursor: pointer;
      z-index: 99999;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25), inset 0 0 6px rgba(124,106,247,0.1);
      color: #a99cf9;
      font-size: 15px;
      font-weight: bold;
      user-select: none;
      flex-shrink: 0;
      align-self: center;
    }
    #cep-launcher:hover {
      background: rgba(124, 106, 247, 0.32);
      border-color: #7c6af7;
      color: #fff;
      box-shadow: 0 4px 14px rgba(124,106,247,0.4);
      transform: scale(1.1);
    }
    #cep-launcher:active { transform: scale(0.93); }
    #cep-launcher.cep-open {
      background: rgba(124, 106, 247, 0.35);
      border-color: #7c6af7;
      color: #fff;
      box-shadow: 0 0 0 3px rgba(124,106,247,0.2);
    }
    #cep-tray {
      --cep-bg:#0f0f10;
      --cep-s1:#1a1a1e;
      --cep-s2:#232328;
      --cep-s3:#2a2a30;
      --cep-b:rgba(255,255,255,0.08);
      --cep-b2:rgba(255,255,255,0.14);
      --cep-t:#f0eff4;
      --cep-t2:#9997a8;
      --cep-t3:#55536a;
      --cep-acc:#7c6af7;
      --cep-acc2:#5d9cf5;
      --cep-green:#3ecf8e;
      --cep-red:#f87171;
      --cep-amber:#f59e0b;
      --cep-r:10px;

      position: fixed;
      bottom: 80px;
      right: 20px;
      z-index: 999999;
      width: 340px;
      max-height: 600px;
      background: var(--cep-bg);
      border: 1px solid var(--cep-b);
      border-radius: 14px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.6), 0 0 20px rgba(124,106,247,0.12);
      font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-size: 12.5px;
      display: flex;
      flex-direction: column;
      color: var(--cep-t);
      animation: cepSlideIn 0.18s ease;
    }
    @keyframes cepSlideIn {
      from { opacity: 0; transform: translateY(10px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)   scale(1);    }
    }
    #cep-th {
      padding: 12px 14px;
      border-bottom: 1px solid var(--cep-b);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--cep-s1);
    }
    .cep-logo-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .cep-logo-symbol {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: linear-gradient(135deg,var(--cep-acc),var(--cep-acc2));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: bold;
      color: #fff;
    }
    .cep-hdr-info h1 {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.2px;
      margin: 0;
      line-height: 1.2;
    }
    .cep-hdr-info p {
      font-size: 10px;
      color: var(--cep-t2);
      margin: 0;
      line-height: 1.2;
    }
    #cep-tc {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
      border-radius: 50%;
      transition: all 0.15s;
    }
    #cep-tc:hover { background: rgba(255,255,255,0.1); color: #fff; }

    /* ── Tabs ── */
    .cep-tabs {
      display: flex;
      border-bottom: 1px solid var(--cep-b);
      background: var(--cep-s1);
    }
    .cep-tab {
      flex: 1;
      padding: 9px 0;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--cep-t3);
      background: none;
      border: none;
      cursor: pointer;
      letter-spacing: 0.2px;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
      text-align: center;
    }
    .cep-tab.cep-tab-active {
      color: var(--cep-t);
      border-bottom-color: var(--cep-acc);
    }
    .cep-tab:hover:not(.cep-tab-active) {
      color: var(--cep-t2);
    }

    .cep-panel {
      display: none;
      padding: 12px;
      overflow-y: auto;
      flex: 1;
    }
    .cep-panel.cep-panel-active {
      display: block;
    }

    .cep-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--cep-t3);
      margin-bottom: 7px;
    }

    .cep-btn {
      width: 100%;
      padding: 10px;
      border: none;
      border-radius: var(--cep-r);
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: -0.2px;
      transition: opacity 0.15s, transform 0.1s;
    }
    .cep-btn:active {
      transform: scale(0.98);
    }
    .cep-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }
    .cep-btn-primary {
      background: linear-gradient(135deg,var(--cep-acc),var(--cep-acc2));
      color: #fff;
      box-shadow: 0 4px 12px rgba(124,106,247,0.3);
    }

    .cep-status {
      margin-top: 10px;
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 11.5px;
      line-height: 1.5;
      border: 1px solid transparent;
    }
    .cep-status.info {
      background: rgba(124,106,247,0.1);
      color: #a99cf9;
      border-color: rgba(124,106,247,0.2);
    }
    .cep-status.ok {
      background: rgba(62,207,142,0.1);
      color: var(--cep-green);
      border-color: rgba(62,207,142,0.2);
    }
    .cep-status.err {
      background: rgba(248,113,113,0.1);
      color: var(--cep-red);
      border-color: rgba(248,113,113,0.2);
    }
    .cep-status.warn {
      background: rgba(245,158,11,0.1);
      color: var(--cep-amber);
      border-color: rgba(245,158,11,0.2);
    }

    .cep-llm-section {
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: var(--cep-r);
      padding: 10px;
      margin-bottom: 12px;
    }
    .cep-llm-section-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .cep-switch {
      position: relative;
      display: inline-block;
      width: 34px;
      height: 20px;
    }
    .cep-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .cep-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: var(--cep-s3);
      transition: .2s;
      border-radius: 20px;
      border: 1px solid var(--cep-b);
    }
    .cep-slider:before {
      position: absolute;
      content: "";
      height: 14px;
      width: 14px;
      left: 2px;
      bottom: 2px;
      background-color: var(--cep-t2);
      transition: .2s;
      border-radius: 50%;
    }
    .cep-switch input:checked + .cep-slider {
      background-color: var(--cep-acc);
      border-color: rgba(124, 106, 247, 0.4);
    }
    .cep-switch input:checked + .cep-slider:before {
      transform: translateX(14px);
      background-color: #fff;
    }
    .cep-provider-tabs {
      display: flex;
      gap: 5px;
      margin-top: 10px;
      margin-bottom: 10px;
    }
    .cep-pvt {
      flex: 1;
      padding: 6px;
      border-radius: 8px;
      background: var(--cep-s2);
      border: 1px solid var(--cep-b);
      color: var(--cep-t3);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .cep-pvt.cep-pvt-sel {
      border-color: var(--cep-acc);
      color: var(--cep-acc);
      background: rgba(124,106,247,0.08);
    }
    .cep-key-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .cep-key-row input {
      flex: 1;
      padding: 7px 10px;
      background: var(--cep-s2);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      color: var(--cep-t);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    .cep-key-row input:focus {
      border-color: var(--cep-acc);
    }
    .cep-key-show {
      padding: 6px 8px;
      background: none;
      border: 1px solid var(--cep-b);
      border-radius: 6px;
      color: var(--cep-t3);
      cursor: pointer;
      font-size: 10px;
      white-space: nowrap;
    }
    .cep-key-show:hover {
      color: var(--cep-t);
    }

    .cep-capsule-name-row input {
      width: 100%;
      padding: 8px 10px;
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      color: var(--cep-t);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    .cep-capsule-name-row input:focus {
      border-color: var(--cep-acc);
    }

    .cep-teleport-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 4px;
    }
    .cep-tport-btn {
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--cep-b);
      color: var(--cep-t);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: var(--cep-s1);
      transition: all 0.2s;
    }
    .cep-tport-btn:active {
      transform: scale(0.96);
    }
    .cep-tport-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
    }
    .cep-tport-btn.claude:hover:not(:disabled) {
      border-color: #f0a070;
      background: rgba(240, 160, 112, 0.08);
    }
    .cep-tport-btn.chatgpt:hover:not(:disabled) {
      border-color: var(--cep-green);
      background: rgba(62, 207, 142, 0.08);
    }
    .cep-tport-btn.gemini:hover:not(:disabled) {
      border-color: #8ab4f8;
      background: rgba(138, 180, 248, 0.08);
    }
    .cep-tport-btn.grok:hover:not(:disabled) {
      border-color: #fff;
      background: rgba(255, 255, 255, 0.06);
    }

    .cep-stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin: 12px 0;
    }
    .cep-stat {
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      padding: 8px;
      text-align: center;
    }
    .cep-stat .cep-v {
      font-size: 16px;
      font-weight: 700;
    }
    .cep-stat .cep-k {
      font-size: 9.5px;
      color: var(--cep-t3);
      margin-top: 1px;
    }

    .cep-file-list {
      margin-top: 10px;
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      overflow: hidden;
    }
    .cep-file-list-hdr {
      padding: 7px 10px;
      border-bottom: 1px solid var(--cep-b);
      font-size: 11px;
      color: var(--cep-t2);
    }
    .cep-file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--cep-b);
      font-size: 11px;
    }
    .cep-file-item.clickable:hover {
      background: var(--cep-s2);
      cursor: pointer;
    }
    .cep-file-item.clickable:hover .cep-file-name {
      color: var(--cep-t);
    }
    .cep-file-item:last-child {
      border-bottom: none;
    }
    .cep-file-icon {
      font-size: 13px;
      flex-shrink: 0;
    }
    .cep-file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--cep-t2);
    }
    .cep-file-badge {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 4px;
      font-weight: 600;
    }
    .cep-file-badge.ok {
      background: rgba(62, 207, 142, 0.15);
      color: var(--cep-green);
    }
    .cep-file-badge.chip {
      background: rgba(245, 158, 11, 0.15);
      color: var(--cep-amber);
    }

    .cep-img-preview {
      margin-top: 10px;
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      overflow: hidden;
    }
    .cep-img-preview-hdr {
      padding: 7px 10px;
      border-bottom: 1px solid var(--cep-b);
      font-size: 11px;
      color: var(--cep-t2);
      display: flex;
      justify-content: space-between;
    }
    .cep-img-grid {
      display: grid;
      grid-template-columns: repeat(5,1fr);
      gap: 4px;
      padding: 7px;
      max-height: 100px;
      overflow-y: auto;
    }
    .cep-img-thumb {
      aspect-ratio: 1;
      border-radius: 5px;
      overflow: hidden;
      border: 1px solid var(--cep-b);
      cursor: pointer;
    }
    .cep-img-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .cep-actgrid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 2px;
    }
    .cep-abtn {
      padding: 8px 10px;
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      color: var(--cep-t);
      font-size: 11.5px;
      cursor: pointer;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .cep-abtn:hover {
      background: var(--cep-s2);
    }
    .cep-abtn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Capsules list styling */
    .cep-cap-toolbar {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
      padding: 0 10px 4px;
    }
    .cep-cap-search {
      flex: 1;
      padding: 7px 10px;
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 8px;
      color: var(--cep-t);
      font-size: 12px;
      outline: none;
    }
    .cep-cap-search:focus {
      border-color: var(--cep-acc);
    }
    .cep-cap-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 400px;
      overflow-y: auto;
      padding: 0 10px 10px;
    }
    .cep-cap-card {
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      border-radius: 10px;
      padding: 10px 12px;
      transition: all 0.15s;
      position: relative;
    }
    .cep-cap-card:hover {
      background: var(--cep-s2);
      border-color: var(--cep-b2);
    }
    .cep-cap-name {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--cep-t);
      text-align: left;
    }
    .cep-cap-meta {
      font-size: 10px;
      color: var(--cep-t3);
      margin-top: 3px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cep-cap-actions {
      display: flex;
      gap: 4px;
      margin-top: 8px;
    }
    .cep-cap-act {
      flex: 1;
      padding: 5px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--cep-b);
      background: var(--cep-s2);
      color: var(--cep-t2);
      text-align: center;
      transition: all 0.12s;
    }
    .cep-cap-act:hover {
      color: var(--cep-t);
      border-color: var(--cep-b2);
    }
    .cep-cap-act.cep-drop {
      background: rgba(124,106,247,0.12);
      border-color: rgba(124,106,247,0.35);
      color: var(--cep-acc);
    }
    .cep-cap-act.cep-drop:hover {
      background: rgba(124,106,247,0.2);
    }
    .cep-cap-act.cep-del {
      color: var(--cep-red);
      border-color: rgba(248,113,113,0.2);
    }
    .cep-cap-act.cep-del:hover {
      background: rgba(248,113,113,0.1);
    }
    .cep-cap-empty {
      color: var(--cep-t3);
      font-size: 12px;
      text-align: center;
      padding: 30px 0;
    }
    .cep-spin {
      display: inline-block;
      width: 11px;
      height: 11px;
      border: 2px solid rgba(255,255,255,0.2);
      border-top-color: #fff;
      border-radius: 50%;
      animation: cepSp 0.5s linear infinite;
      vertical-align: middle;
      margin-right: 5px;
    }
    .cep-llm-section-body {
      display: none;
    }
    .cep-llm-section.cep-expanded .cep-llm-section-body {
      display: block;
    }
    .cep-btn-secondary {
      background: var(--cep-s1);
      border: 1px solid var(--cep-b);
      color: var(--cep-t);
    }
    .cep-btn-secondary:hover {
      background: var(--cep-s2);
    }
    .cep-section {
      border-bottom: 1px solid var(--cep-b);
      padding: 14px 12px;
    }
    .cep-section:last-child {
      border-bottom: none;
    }
    .cep-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--cep-t2);
      margin-bottom: 10px;
    }
    .cep-plat {
      margin-left: auto;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .5px;
      padding: 3px 8px;
      border-radius: 20px;
      border: 1px solid var(--cep-b);
      color: var(--cep-t3);
      text-transform: uppercase;
      margin-right: 10px;
    }
    .cep-plat.claude {
      color: #f0a070;
      border-color: rgba(240, 160, 112, .3);
      background: rgba(240, 160, 112, .07);
    }
    .cep-plat.chatgpt {
      color: var(--cep-green);
      border-color: rgba(62, 207, 142, .3);
      background: rgba(62, 207, 142, .07);
    }
    .cep-plat.gemini {
      color: #3f8ef6;
      border-color: rgba(63, 142, 246, .3);
      background: rgba(63, 142, 246, .07);
    }
    .cep-plat.grok {
      color: #faf9f5;
      border-color: rgba(250, 249, 245, .3);
      background: rgba(250, 249, 245, .07);
    }
    @keyframes cepSp {
      to { transform: rotate(360deg); }
    }
    .cep-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      color: #000;
      font-size: 12px;
      font-weight: 700;
      padding: 10px 22px;
      border-radius: 24px;
      z-index: 9999999;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      animation: cepU 2.5s ease forwards;
      pointer-events: none;
    }
    @keyframes cepU {
      0%   { opacity: 0; transform: translateX(-50%) translateY(10px); }
      15%  { opacity: 1; transform: translateX(-50%) translateY(0); }
      85%  { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(st);
}

async function toggleTray() {
  if (tray) {
    tray.remove();
    tray = null;
    document.getElementById('cep-launcher')?.classList.remove('cep-open');
  } else {
    try {
      await showTray();
      document.getElementById('cep-launcher')?.classList.add('cep-open');
    } catch (e) {
      console.error("[CEP] Error opening tray:", e);
    }
  }
}

// ── Launcher: find the bottom toolbar row and append our button ───────────────
function findToolbarRow() {
  // Claude: walk up from model-selector-dropdown to find the flex row with buttons
  if (PLAT === 'claude') {
    const ms = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (ms) {
      let cur = ms;
      while (cur && cur !== document.body) {
        if (cur !== ms && cur.nodeType === 1) {
          const st = window.getComputedStyle(cur);
          if (st.display === 'flex' && st.flexDirection === 'row') {
            const btns = cur.querySelectorAll('button');
            if (btns.length > 1) return cur;
          }
        }
        cur = cur.parentElement;
      }
    }
  }

  // ChatGPT, Gemini, Grok:
  // First, find the active composer area.
  const inputSel = (SEL[PLAT]||SEL.claude).input;
  const input = document.querySelector(inputSel);
  if (!input) return null;

  let composer = input.parentElement;
  while (composer && composer !== document.body) {
    if (composer.tagName === 'FORM' || composer.getAttribute('role') === 'presentation' || composer.classList.contains('composer') || composer.offsetHeight > 150) {
      break;
    }
    composer = composer.parentElement;
  }
  if (!composer) composer = document.body;

  // We look for buttons inside the composer. We search for common button types
  // to walk up from (mic, send, upload, settings, etc.)
  const btnSelectors = [
    'button[data-testid="send-button"]',
    'button[data-testid*="send"]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
    'button[aria-label*="voice" i]',
    'button[aria-label*="Read aloud" i]',
    'button[aria-label*="microphone" i]',
    'button[aria-label*="mic" i]',
    'button[aria-label*="Speak" i]',
    'button[aria-label*="Speech" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="File" i]',
    'button[aria-label*="Add" i]'
  ];

  for (const sel of btnSelectors) {
    const btn = composer.querySelector(sel);
    if (btn) {
      // Walk up from this button to find the first flex row container
      let cur = btn.parentElement;
      while (cur && cur !== composer && cur !== document.body) {
        if (cur.nodeType === 1) {
          const st = window.getComputedStyle(cur);
          if (st.display === 'flex' && st.flexDirection === 'row') {
            return cur;
          }
        }
        cur = cur.parentElement;
      }
      return btn.parentElement;
    }
  }

  // Fallback if no specific button is found: find a container holding the input
  // and having at least 1 button, matching a reasonable height.
  let cur = input.parentElement;
  while (cur && cur !== document.body) {
    if (cur.nodeType === 1) {
      const btns = cur.querySelectorAll('button');
      const h = cur.offsetHeight;
      if (btns.length >= 1 && h > 0 && h < 120) {
        return cur;
      }
    }
    cur = cur.parentElement;
  }

  return null;
}

function initLauncher() {
  if (PLAT === 'unknown') return;
  if (document.getElementById('cep-launcher')) return;

  injectStyles();

  const launcher = document.createElement('div');
  launcher.id = 'cep-launcher';
  launcher.title = 'OmniExtract';
  launcher.innerHTML = '⬡';
  launcher.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTray();
  };

  // Strategy 1: Append to the toolbar row (beside voice/mic/send buttons)
  const toolbar = findToolbarRow();
  if (toolbar) {
    toolbar.appendChild(launcher);
    return;
  }

  // Strategy 2: Absolute-position fallback in the input wrapper
  const inputSel = (SEL[PLAT]||SEL.claude).input;
  const input = document.querySelector(inputSel);
  if (!input) return;
  const wrapper = input.parentElement;
  if (!wrapper) return;
  const compStyle = window.getComputedStyle(wrapper);
  if (compStyle.position === 'static') wrapper.style.position = 'relative';
  const offsets = { chatgpt:['52px','10px'], claude:['54px','14px'], gemini:['60px','12px'], grok:['52px','12px'] };
  const [r, b] = offsets[PLAT] || ['52px','12px'];
  launcher.style.cssText = `position:absolute;right:${r};bottom:${b};`;
  wrapper.appendChild(launcher);
}

// Clean extracted text before sending to LLM for refinement
function cleanForLLM(rawText) {
  if (!rawText) return '';
  let processed = rawText
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)\b/g, '')
    .replace(/Claude's response was interrupted\.?/gi, '')
    .replace(/Claude\s+[Ff]able\s+\d+\s+is\s+currently\s+unavailable\.?\s*Learn\s+more(?:\(opens\s+in\s+new\s+tab\))?/gi, '')
    .replace(/Claude\s+[Ff]able\s+\d+\s+is\s+currently\s+unavailable\.?\s*Learn\s+more/gi, '')
    .replace(/Claude is AI and can make mistakes\. Please double-check responses\.?/gi, '')
    .replace(/You are out of free messages until [0-9: AM|PM|am|pm\s]+Upgrade/gi, '');

  const lines = processed.split('\n');
  const cleaned = [];
  const seenBlocks = new Set();

  for (let line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^New chat(Ctrl|⌘)/i.test(t)) continue;
    if (/^(Chats|Projects|Artifacts|Customize|Products|Cowork|Code|Starred)/i.test(t) && t.length > 100) continue;
    if (/(Free plan|You are out of free messages|Upgrade)/i.test(t) && t.length < 200) continue;
    if (/^(Upgrade|Learn more|All chats|Download all)$/i.test(t)) continue;
    if (/Claude.*(unavailable|currently|interrupted)/i.test(t) && t.length < 200) continue;
    if (/^[a-f0-9]{16,}\.zip/i.test(t) && t.length < 100) continue;
    if (/^(Done|Content|Script|Table · CSV|PY)$/i.test(t)) continue;
    if (/^(sasuke|Settings|Language|Get help|Upgrade plan|Log out)/i.test(t) && t.length < 300) continue;
    if (/^(Add files or photos|Take a screenshot|Add to project|Skills|Add connectors)/i.test(t)) continue;
    if (/^(Sonnet|Claude|Opus|Haiku|Fable)\s+\d/i.test(t) && t.length < 200) continue;
    if (/^(Unstar|Star|Rename|Add to project|Delete|Group by)/i.test(t) && t.length < 100) continue;
    if (/^(Microphone|Hold to record)/i.test(t) && t.length < 100) continue;
    if (/^(Session|Weekly): \d+%/.test(t)) continue;
    if (/^(Approximate tokens|Messages sent while cached|5-hour session|7-day usage|Dynamic Context|Bar scale:)/i.test(t)) continue;
    if (t === '[UNKNOWN]') continue;

    if (t.length > 30) {
      const blockKey = t.slice(0, 200);
      if (seenBlocks.has(blockKey)) continue;
      seenBlocks.add(blockKey);
    }
    cleaned.push(line);
  }
  return cleaned.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}

async function loadCapsules() {
  const r = await chrome.storage.local.get(["capsules"]);
  return (r.capsules || []).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveCapsule(cap) {
  const imgCount = (cap.images||[]).filter(i=>i.dataUrl).length;
  const capSize = JSON.stringify(cap).length;
  console.log(`[CEP] Saving capsule "${cap.name}": ${imgCount} images, ~${(capSize/1024).toFixed(0)}KB`);

  const r = await chrome.storage.local.get(["capsules"]);
  const caps = r.capsules || [];
  caps.push(cap);
  while (caps.length > 50) caps.shift();
  try {
    await chrome.storage.local.set({ capsules: caps });
    const verify = await chrome.storage.local.get(["capsules"]);
    const saved = (verify.capsules||[]).find(c => c.id === cap.id);
    const savedImgs = saved ? (saved.images||[]).filter(i=>i.dataUrl).length : 0;
    if (savedImgs < imgCount) {
      console.warn(`[CEP] Storage lost images! Saved ${savedImgs}/${imgCount}. Storage quota may be exceeded.`);
    }
  } catch(e) {
    console.error('[CEP] Storage save failed:', e);
    cap._imagesStripped = true;
    const stripped = {...cap, images: []};
    caps[caps.length - 1] = stripped;
    await chrome.storage.local.set({ capsules: caps });
    toast("⚠ Storage full — capsule saved without images. Try deleting old capsules.", true);
  }
}

async function deleteCapsule(id) {
  const r = await chrome.storage.local.get(["capsules"]);
  const caps = (r.capsules||[]).filter(c => c.id !== id);
  await chrome.storage.local.set({ capsules: caps });
}

async function deleteAllCapsules() {
  await chrome.storage.local.set({ capsules: [] });
}

function buildPlainText(data) {
  const lines = [`# ${data.platform} Chat — ${data.extractedAt}`, `# ${data.url}`, ""];
  for (const msg of data.messages||[]) {
    if (msg.role && msg.role !== 'unknown') {
      lines.push(`[${msg.role.toUpperCase()}]`);
    }
    if (msg.text) {
      const cleaned = cleanForLLM(msg.text);
      if (cleaned) lines.push(cleaned);
    }
    if (msg.images?.length) lines.push(`[${msg.images.length} image(s)]`);
    if (msg.files?.length)  lines.push(`[Files: ${msg.files.map(f=>f.name).join(", ")}]`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{4,}/g, '\n\n\n');
}

async function showTray(caps, llmEnabled) {
  if (tray) tray.remove();
  tray = document.createElement('div');
  tray.id = 'cep-tray';

  tray.innerHTML = `
    <div id="cep-th">
      <div class="cep-logo-info">
        <div class="cep-logo-symbol">⬡</div>
        <div class="cep-hdr-info">
          <h1>OmniExtract</h1>
          <p>Extract · Refine · Drop</p>
        </div>
      </div>
      <span class="cep-plat ${PLAT === 'claude' ? 'claude' : PLAT === 'chatgpt' ? 'chatgpt' : PLAT === 'gemini' ? 'gemini' : PLAT === 'grok' ? 'grok' : ''}" id="cep-platBadge">${PLAT === 'claude' ? 'Claude' : PLAT === 'chatgpt' ? 'ChatGPT' : PLAT === 'gemini' ? 'Gemini' : PLAT === 'grok' ? 'Grok' : '—'}</span>
      <button id="cep-tc">✕</button>
    </div>

    <!-- ── SECTION 1: EXTRACT ── -->
    <div class="cep-section">
      <div class="cep-section-title">⚡ Extract Chat</div>
      
      <!-- LLM Auto-Refine section (simple toggle switch) -->
      <div class="cep-llm-section" id="cep-llmSection" style="margin-bottom: 12px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; background: var(--cep-s1); border: 1px solid var(--cep-b); border-radius: var(--cep-r);">
        <span style="color: var(--cep-t2); font-weight: 600; font-size: 12.5px;">Auto-refine with LLM</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="cep-llmProviderBadge" style="font-size:10px;color:var(--cep-t3);text-transform:uppercase;font-weight:600;line-height:1;"></span>
          <label class="cep-switch">
            <input type="checkbox" id="cep-llmEnabled">
            <span class="cep-slider"></span>
          </label>
        </div>
      </div>

      <!-- Capsule name -->
      <div class="cep-capsule-name-row" style="margin-bottom:12px">
        <input type="text" id="cep-capNameInput" placeholder="Capsule name (auto-filled)…"/>
      </div>

      <button class="cep-btn cep-btn-primary" id="cep-btnExtract">⬡ Extract + Save Capsule</button>
      <div class="cep-status" id="cep-extractStatus" style="display:none"></div>

      <!-- Extraction Results -->
      <div id="cep-extractResults" style="display:none">
        <div class="cep-stats">
          <div class="cep-stat"><div class="cep-v" id="cep-sMsg">0</div><div class="cep-k">Messages</div></div>
          <div class="cep-stat"><div class="cep-v" id="cep-sImg">0</div><div class="cep-k">Images</div></div>
          <div class="cep-stat"><div class="cep-v" id="cep-sFile">0</div><div class="cep-k">Files</div></div>
        </div>

        <!-- File list -->
        <div class="cep-file-list" id="cep-fileList" style="display:none">
          <div class="cep-file-list-hdr">Attached Files</div>
          <div id="cep-fileItems"></div>
        </div>

        <div class="cep-actgrid" style="margin-top:10px">
          <button class="cep-abtn" id="cep-btnCopy">📋 Copy Text</button>
          <button class="cep-abtn" id="cep-btnTxt">⬇ Save .txt</button>
          <button class="cep-abtn" id="cep-btnJson">⬇ Save JSON</button>
          <button class="cep-abtn" id="cep-btnImgs" disabled>🖼 Save Images</button>
        </div>

        <div class="cep-img-preview" id="cep-imgPreview" style="display:none">
          <div class="cep-img-preview-hdr"><span>Images</span><span id="cep-imgPreviewCount" style="color:var(--cep-acc)"></span></div>
          <div class="cep-img-grid" id="cep-imgGrid"></div>
        </div>
      </div>
    </div>

    <!-- ── SECTION 2: DROP CAPSULE ── -->
    <div class="cep-section">
      <div class="cep-section-title">💊 Capsules</div>
      <button class="cep-btn cep-btn-secondary" id="cep-btnOpenPopup">💊 Open Capsules / Extension UI</button>
    </div>

    <!-- ── SECTION 3: TELEPORT ── -->
    <div class="cep-section">
      <div class="cep-section-title">🚀 Teleport & Send Context</div>
      <div class="cep-teleport-grid">
        <button class="cep-tport-btn claude" data-target="claude" title="Teleport to Claude">
          <span style="font-size:14px">🟠</span> Claude
        </button>
        <button class="cep-tport-btn chatgpt" data-target="chatgpt" title="Teleport to ChatGPT">
          <span style="font-size:14px">🟢</span> ChatGPT
        </button>
        <button class="cep-tport-btn gemini" data-target="gemini" title="Teleport to Gemini">
          <span style="font-size:14px">✦</span> Gemini
        </button>
        <button class="cep-tport-btn grok" data-target="grok" title="Teleport to Grok">
          <span style="font-size:14px">⚡</span> Grok
        </button>
      </div>
    </div>
  `;

  const el = id => tray.querySelector('#' + id);

  // Close button
  el('cep-tc').onclick = () => {
    tray.remove();
    tray = null;
    document.getElementById('cep-launcher')?.classList.remove('cep-open');
  };

  // Section 2: Open capsules UI
  el('cep-btnOpenPopup').onclick = async () => {
    await chrome.storage.local.set({ open_tab: "capsules" });
    chrome.runtime.sendMessage({ action: "openExtensionPopup" }).then(res => {
      if (!res || !res.success) {
        chrome.runtime.sendMessage({ action: "openPopupTab" });
      }
    });
  };

  // Load LLM states & provider configuration
  let extractedData = null;

  const stored = await chrome.storage.local.get(["lastProvider", "llmEnabled"]);
  const currentProvider = stored.lastProvider || "groq";

  function updateProviderBadge() {
    const on = el('cep-llmEnabled').checked;
    el('cep-llmProviderBadge').textContent = on ? currentProvider : "";
  }

  // Restore LLM enabled state
  if (stored.llmEnabled) {
    el('cep-llmEnabled').checked = true;
    updateProviderBadge();
  }

  // LLM toggle checkbox listener
  el('cep-llmEnabled').onchange = () => {
    const on = el('cep-llmEnabled').checked;
    chrome.storage.local.set({ llmEnabled: on });
    updateProviderBadge();
  };

  // Section 1: Extraction Flow
  async function runExtractionFlow(shouldSave = false) {
    extractedData = null;
    el('cep-extractResults').style.display = "none";
    el('cep-imgPreview').style.display = "none";
    el('cep-fileList').style.display = "none";
    el('cep-imgGrid').innerHTML = "";
    el('cep-fileItems').innerHTML = "";

    const useLLM = el('cep-llmEnabled').checked;
    const storageData = await chrome.storage.local.get(["apiKeys", "lastProvider"]);
    const prov = storageData.lastProvider || "groq";
    const apiKey = storageData.apiKeys?.[prov] || "";

    if (useLLM && !apiKey) {
      showStatus("cep-extractStatus", "err", `LLM is enabled — please configure your ${prov} API key in the extension popup first.`);
      return null;
    }

    showStatus("cep-extractStatus", "info", '<span class="cep-spin"></span>Extracting chat…');
    el('cep-btnExtract').disabled = true;
    tray.querySelectorAll('.cep-tport-btn').forEach(b => b.disabled = true);

    try {
      const extracted = await extractAll();
      extractedData = extracted;

      if (!el('cep-capNameInput').value) {
        el('cep-capNameInput').value = (document.title || "Chat").replace(/ [-|].*$/, "").trim().slice(0, 50);
      }

      const capsuleName = el('cep-capNameInput').value.trim() || "Chat Capsule";
      const hasAssistant = (extractedData.messages || []).some(m => m.role === 'assistant');

      let refinedText = null;
      if (useLLM && hasAssistant) {
        showStatus("cep-extractStatus", "info", `<span class="cep-spin"></span>Extracting… then refining with ${prov}…`);
        try {
          const chatText = cleanForLLM(buildPlainText(extractedData));
          const r2 = await chrome.runtime.sendMessage({ action: "llmRefine", provider: prov, apiKey, chatText, capsuleName });
          if (r2.error) throw new Error(r2.error);
          refinedText = r2.text;
        } catch(e) {
          showStatus("cep-extractStatus", "warn", "⚠ LLM refine failed: " + e.message + " — saving raw text.");
        }
      }

      let defaultPromptText;
      if (!hasAssistant) {
        defaultPromptText = (extractedData.messages || [])
          .map(m => cleanForLLM(m.text))
          .filter(Boolean)
          .join('\n\n');
      } else {
        defaultPromptText = buildPlainText(extractedData);
      }

      const cap = {
        id: Date.now().toString(),
        name: capsuleName,
        promptText: refinedText || defaultPromptText,
        rawText: buildPlainText(extractedData),
        images: (extractedData.allImages || []).filter(i => i.dataUrl),
        files: (extractedData.allFiles || []),
        platform: extractedData.platform,
        sourceUrl: extractedData.url,
        createdAt: new Date().toISOString(),
        llmRefined: !!refinedText
      };

      if (shouldSave) {
        await saveCapsule(cap);
      }

      renderExtractResults(extractedData, refinedText);
      return cap;

    } catch(e) {
      showStatus("cep-extractStatus", "err", "Error: " + e.message);
      return null;
    } finally {
      el('cep-btnExtract').disabled = false;
      tray.querySelectorAll('.cep-tport-btn').forEach(b => b.disabled = false);
    }
  }

  el('cep-btnExtract').onclick = async () => {
    await runExtractionFlow(true);
  };

  function renderExtractResults(data, refinedText) {
    const msgs  = data.messages || [];
    const imgs  = data.allImages || [];
    const files = data.allFiles || [];

    el('cep-sMsg').textContent  = msgs.length;
    el('cep-sImg').textContent  = imgs.length;
    el('cep-sFile').textContent = files.length;

    // Files
    if (files.length) {
      el('cep-fileList').style.display = "block";
      el('cep-fileItems').innerHTML = "";
      files.forEach(f => {
        const ext = f.name.split(".").pop()?.toLowerCase() || "";
        const icon = ext === "pdf" ? "📄" : ext === "zip" ? "🗜" : ["doc","docx"].includes(ext) ? "📝" : ["xls","xlsx"].includes(ext) ? "📊" : "📎";
        const hasData = !!f.dataUrl;
        const div = document.createElement("div");
        div.className = "cep-file-item" + (hasData ? " clickable" : "");
        if (hasData) {
          div.title = "Click to download " + f.name;
          div.onclick = () => {
            chrome.runtime.sendMessage({ action: "downloadDataUrl", dataUrl: f.dataUrl, filename: f.name });
          };
        }
        div.innerHTML = `
          <span class="cep-file-icon">${icon}</span>
          <span class="cep-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="cep-file-badge ${hasData ? 'ok' : 'chip'}">${hasData ? "✓ data" : "name only"}</span>
        `;
        el('cep-fileItems').appendChild(div);
      });
    }

    // Images
    const goodImgs = imgs.filter(i => i.dataUrl);
    const failedImgs = imgs.filter(i => i.error);
    if (goodImgs.length) {
      el('cep-imgPreview').style.display = "block";
      el('cep-imgPreviewCount').textContent = goodImgs.length + " ready";
      goodImgs.forEach(img => {
        const d = document.createElement("div"); d.className = "cep-img-thumb";
        const imgEl = document.createElement("img"); imgEl.src = img.dataUrl;
        d.appendChild(imgEl); el('cep-imgGrid').appendChild(d);
      });
      el('cep-btnImgs').disabled = false;
    } else {
      el('cep-btnImgs').disabled = true;
    }

    // Status
    const chipsOnly = files.filter(f => !f.dataUrl).length;
    let statusParts = [`✓ Capsule saved! ${msgs.length} messages`];
    if (goodImgs.length) statusParts.push(`${goodImgs.length} image${goodImgs.length>1?"s":""}`);
    else if (imgs.length) statusParts.push(`0/${imgs.length} images captured`);
    statusParts.push(`${files.length} file${files.length!==1?"s":""}`);
    if (refinedText) statusParts.push("LLM refined ✦");
    let statusMsg = statusParts.join(" · ");
    const warns = [];
    if (failedImgs.length) warns.push(`⚠ ${failedImgs.length} image(s) couldn't be fetched (may be expired)`);
    if (chipsOnly) warns.push(`⚠ ${chipsOnly} file(s) found by name only (no binary available in DOM)`);
    if (warns.length) statusMsg += "<br>" + warns.join("<br>");

    showStatus("cep-extractStatus", warns.length ? "warn" : "ok", statusMsg);
    el('cep-extractResults').style.display = "block";
  }

  function showStatus(id, type, msg) {
    const statusEl = el(id);
    statusEl.className = "cep-status " + type;
    statusEl.innerHTML = msg;
    statusEl.style.display = "block";
  }

  // Section 1: Result action buttons
  el('cep-btnCopy').onclick = async () => {
    if (!extractedData) return;
    await navigator.clipboard.writeText(buildPlainText(extractedData));
    flash(el('cep-btnCopy'), "✓ Copied");
  };

  el('cep-btnTxt').onclick = () => {
    if (!extractedData) return;
    chrome.runtime.sendMessage({ action: "downloadText", text: buildPlainText(extractedData), filename: `chat_${Date.now()}.txt` });
  };

  el('cep-btnJson').onclick = () => {
    if (!extractedData) return;
    chrome.runtime.sendMessage({ action: "downloadJson", json: JSON.stringify(extractedData, null, 2), filename: `chat_${Date.now()}.json` });
  };

  el('cep-btnImgs').onclick = async () => {
    if (!extractedData) return;
    const imgs = (extractedData.allImages || []).filter(i => i.dataUrl);
    for (let i = 0; i < imgs.length; i++) {
      await delay(250 * i);
      const ext = imgs[i].mimeType?.split("/")[1] || "jpg";
      chrome.runtime.sendMessage({ action: "downloadDataUrl", dataUrl: imgs[i].dataUrl, filename: `img_${i + 1}.${ext}` });
    }
    flash(el('cep-btnImgs'), `⬇ Saving ${imgs.length}…`);
  };

  function flash(buttonEl, msg) {
    const orig = buttonEl.innerHTML;
    buttonEl.innerHTML = msg;
    setTimeout(() => buttonEl.innerHTML = orig, 1800);
  }

  // Section 3: Teleport Platforms
  tray.querySelectorAll('.cep-tport-btn').forEach(btn => {
    btn.onclick = async () => {
      const target = btn.dataset.target;
      const cap = await runExtractionFlow(false);
      if (!cap) return;

      const transfer = {
        targetPlatform: target,
        capsule: cap,
        timestamp: Date.now()
      };
      await chrome.storage.local.set({ pending_transfer: transfer });

      const urls = {
        claude: "https://claude.ai/new",
        chatgpt: "https://chatgpt.com/",
        gemini: "https://gemini.google.com/app",
        grok: "https://grok.com/"
      };
      window.open(urls[target], "_blank");
    };
  });

  document.body.appendChild(tray);
}

function toast(msg,err=false) {
  const t=document.createElement('div'); t.className='cep-toast';
  t.style.background=err?'#f87171':'#3ecf8e'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2600);
}
function eh(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Check for pending transfer on load
async function checkPendingTransfer() {
  try {
    const r = await chrome.storage.local.get(["pending_transfer"]);
    if (!r.pending_transfer) return;
    const transfer = r.pending_transfer;

    // Limit to 2 minutes freshness
    if (Date.now() - transfer.timestamp > 120000) {
      await chrome.storage.local.remove(["pending_transfer"]);
      return;
    }

    const currentHost = location.hostname.toLowerCase();
    let match = false;
    if (transfer.targetPlatform === "claude" && currentHost.includes("claude.ai")) match = true;
    if (transfer.targetPlatform === "chatgpt" && (currentHost.includes("chatgpt.com") || currentHost.includes("chat.openai.com"))) match = true;
    if (transfer.targetPlatform === "gemini" && currentHost.includes("gemini.google.com")) match = true;
    if (transfer.targetPlatform === "grok" && currentHost.includes("grok.com")) match = true;

    if (!match) return;

    // Clear immediately to prevent loops or double injections
    await chrome.storage.local.remove(["pending_transfer"]);

    // Polling loop to wait for input element to be available
    let attempts = 0;
    const maxAttempts = 150; // 30 seconds (200ms intervals)
    const interval = setInterval(() => {
      const inputSel = (SEL[PLAT]||SEL.claude).input;
      const input = document.querySelector(inputSel);
      if (input) {
        // Focus the input textbox to trigger lazy loading of toolbar and file input components
        try { input.focus(); } catch(_) {}

        // If the capsule contains files, verify if we should wait for file input to appear
        const hasFiles = (transfer.capsule.images && transfer.capsule.images.length > 0) || 
                         (transfer.capsule.files && transfer.capsule.files.length > 0);
        if (hasFiles && !querySelectorShadow('input[type="file"]')) {
          attempts++;
          if (attempts >= 15) { // 3 seconds timeout (15 * 200ms) for file input to appear
            clearInterval(interval);
            console.log("[CEP] Text input found, but file input not found after 3 seconds. Proceeding to drop capsule anyway.");
            dropCapsule(transfer.capsule);
          }
          return; // Keep waiting for file input
        }

        clearInterval(interval);
        console.log("[CEP] Pending transfer found, waiting 1.2s for editor to initialize event listeners...");
        setTimeout(() => {
          console.log("[CEP] Dropping capsule now...");
          dropCapsule(transfer.capsule);
        }, 1200);
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          console.warn("[CEP] Target input element not found after 30 seconds.");
        }
      }
    }, 200);
  } catch(e) {
    console.error("[CEP] Error in checkPendingTransfer:", e);
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req,_,send)=>{
  if (req.action==='ping')           {send({platform:PLAT,ready:true});return true;}
  if (req.action==='extract')        {extractAll().then(d=>send({success:true,data:d})).catch(e=>send({success:false,error:e.message}));return true;}
  if (req.action==='showCapsuleTray'){
    showTray().then(() => send({ok:true}));
    return true;
  }
  if (req.action==='dropCapsule')    {dropCapsule(req.capsule);send({ok:true});return true;}
  if (req.action==='hideCapsuleTray'){if(tray){tray.remove();tray=null;}send({ok:true});return true;}
});

// Run pending transfer check
checkPendingTransfer();

// Start launcher injection loop — also re-inject if launcher was removed by SPA rerender
setInterval(() => {
  const existing = document.getElementById('cep-launcher');
  // If launcher exists but is detached from DOM, remove it so initLauncher can re-inject
  if (existing && !document.body.contains(existing)) {
    existing.remove();
  }
  initLauncher();
}, 1500);
// Also run immediately on load
initLauncher();
})();

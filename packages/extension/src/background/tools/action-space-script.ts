// The indexed action-space observation, evaluated in the page.
//
// Port of browser-use/jev-ultrafast `snapshot.js` (MIT) with two WebBridge
// adaptations:
//   1. Identity is WebBridge's own `data-wb-id` (assigned here, so
//      click_element/type_element can resolve the target afterwards) instead of
//      a WeakMap-only handle.
//   2. Per-element guard text is budgeted (maxGuardChars + a global byte
//      budget) because the observation is JSON-transported over CDP.
//
// Everything else is faithful: real visibility, viewport geometry, accessible
// name resolution, per-operation compatibility, native dropdown options as
// individual targets, and the freshness marker used to reject stale decisions.

export interface ActionSpaceOptions {
  maxActions?: number;
  maxTextChars?: number;
  maxGuardChars?: number;
}

export const DEFAULT_MAX_ACTIONS = 250;
export const DEFAULT_MAX_TEXT_CHARS = 6000;
export const DEFAULT_MAX_GUARD_CHARS = 400;
/** Global budget for all guard scope texts combined (transport safety). */
export const GUARD_TEXT_BUDGET = 24000;

/** Function expression: `(function (opts) { … })`. Call it with actionSpaceExpression(). */
export const ACTION_SPACE_FN = `(function (opts) {
  if (!document.body) return null;
  const maxActions = opts.maxActions;
  const maxTextChars = opts.maxTextChars;
  const maxGuardChars = opts.maxGuardChars;
  const nodeCache = new WeakMap();
  const seen = new Set();
  const ids = new Map();
  const nextIndex = { n: 0 };

  const idFor = (el) => {
    let id = nodeCache.get(el);
    if (!id) {
      id = 'a' + (++nextIndex.n);
      nodeCache.set(el, id);
      el.setAttribute('data-wb-id', id);
      ids.set(id, el);
    }
    return id;
  };

  const safe = (el) => !['password', 'file', 'hidden'].includes(el.type);
  const isVisible = (el) => {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    try {
      if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch (e) { /* fall through to the style check below */ }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  const accessibleName = (el, seenNodes) => {
    seenNodes = seenNodes || new Set();
    if (!el || seenNodes.has(el)) return '';
    seenNodes.add(el);
    const referenced = (el.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .map((ref) => accessibleName(ref ? document.getElementById(ref) : null, seenNodes))
      .filter(Boolean)
      .join(' ');
    if (referenced) return referenced;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labels = el.labels ? Array.from(el.labels).map((l) => accessibleName(l, seenNodes)).filter(Boolean).join(' ') : '';
    if (labels) return labels;
    if (['button', 'submit', 'reset'].includes(el.type)) return el.value || '';
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    if (el.tagName !== 'INPUT') {
      const child = Array.from(el.childNodes).map((node) => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType === 1 && node.getAttribute('aria-hidden') !== 'true' && node !== el) return accessibleName(node, seenNodes);
        return '';
      }).join(' ').trim();
      if (child) return child;
    }
    return el.getAttribute('title') || el.getAttribute('placeholder') || '';
  };

  const ROLE_NAMES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    ROLE_NAMES.map((role) => '[role="' + role + '"]').join(',');
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (ROLE_NAMES.includes(explicit)) return explicit;
    if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') return 'button';
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (el.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(el.type)) return el.type;
      if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
      if (el.type === 'search') return 'searchbox';
      if (el.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(el.type)) return 'textbox';
    }
    return null;
  };

  const pageKey = [
    performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    Array.from(document.querySelectorAll('input,textarea,select')).filter(safe)
      .map((el) => [idFor(el), el.value, el.checked, el.selectedIndex, el.disabled, el.readOnly]),
  ];

  const guard = (el) => {
    if (!el || !el.isConnected || !isVisible(el)) return null;
    const scope = el.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || el.parentElement;
    const scopeText = scope && scope.innerText ? scope.innerText.slice(0, maxGuardChars) : '';
    return [
      el.getAttribute('data-wb-id'), roleOf(el), accessibleName(el), el.value === undefined ? null : el.value,
      el.checked === undefined ? null : el.checked, el.selectedIndex === undefined ? null : el.selectedIndex,
      el.readOnly === undefined ? null : el.readOnly, el.matches(':disabled'),
      el.getAttribute('aria-disabled'), el.getAttribute('aria-expanded'), el.getAttribute('aria-checked'),
      el.getAttribute('aria-selected'), el.getAttribute('href'), scopeText,
    ];
  };

  const actions = [];
  document.querySelectorAll(selector).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!safe(el) || !isVisible(el) || el.matches(':disabled') || el.closest('[aria-disabled="true"]')) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const role = roleOf(el);
    if (!role || rect.width <= 0 || rect.height <= 0) return;
    if (centerX < 0 || centerY < 0 || centerX >= innerWidth || centerY >= innerHeight) return;
    if (role === 'gridcell' && el.querySelector('button,[role="button"]')) return;

    const id = idFor(el);
    // Fallback label when there is no accessible name: icon-only buttons are
    // otherwise indistinguishable ("button", "button", ...). Attribute hints are
    // deterministic and give the decision model something to discriminate on.
    const named = accessibleName(el);
    const hints = [
      el.id ? '#' + el.id : '',
      el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '',
      el.getAttribute('type') && el.getAttribute('type') !== 'text' ? '[type=' + el.getAttribute('type') + ']' : '',
      el.getAttribute('data-testid') ? '[testid=' + el.getAttribute('data-testid') + ']' : '',
    ].join('');
    const label = named || (role + hints) || role;
    // P10 — la cible d'une action est SÉPARÉE du libellé. Le libellé peut rester
    // identique (même texte, même aria-label) alors que la destination change :
    // href d'un lien, action d'un formulaire, ou cible d'un <a target>. Ces
    // valeurs sont déjà calculées pour guards ; les exposer sur l'action permet
    // au runner de VÉRIFIER que la cible n'a pas changé entre la décision et le
    // dispatch (le marker, lui, ignore href — c'est pourquoi P10 existe).
    const rawHref = el.getAttribute('href');
    const form = el.form || (el.closest && el.closest('form'));
    const rawFormAction = form ? form.getAttribute('action') : null;
    const rawTarget = el.getAttribute('target');
    const targetGuard = [
      rawHref === null ? null : rawHref,
      rawFormAction === null ? null : rawFormAction,
      rawTarget === null ? null : rawTarget,
    ].join('\u0000');
    const base = {
      id: id, node: id, role: role, label: label,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      href: rawHref === null ? null : rawHref,
      form_action: rawFormAction === null ? null : rawFormAction,
      target: rawTarget === null ? null : rawTarget,
      target_guard: targetGuard,
    };
    ['checked', 'selected', 'expanded'].forEach((key) => {
      const value = el.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    });
    if (['checkbox', 'radio'].includes(el.type)) base.checked = String(el.checked);

    if (el.tagName === 'SELECT') {
      const current = Array.from(el.selectedOptions).map((option) => option.label).join(', ');
      Array.from(el.options).forEach((option) => {
        if (option.selected || option.disabled || option.closest('optgroup[disabled]')) return;
        actions.push({
          id: id + ':' + (actions.length + 1), node: id, kind: 'select', role: role,
          label: label + ' → ' + option.label, value: option.value, current_value: current,
          rect: base.rect, href: base.href, form_action: base.form_action, target: base.target, target_guard: base.target_guard,
        });
      });
    } else {
      const readOnly = el.readOnly || el.getAttribute('aria-readonly') === 'true';
      const editable = !readOnly && (
        ['textbox', 'searchbox', 'spinbutton'].includes(role) ||
        (role === 'combobox' && ['INPUT', 'TEXTAREA'].includes(el.tagName))
      );
      let value = '';
      if ('value' in el) value = String(el.value);
      else if (el.isContentEditable || role === 'combobox') value = (el.innerText || '').trim();
      actions.push(Object.assign({}, base, { kind: editable ? 'fill' : 'click', value: value }));
      if (editable) {
        actions.push(Object.assign({}, base, { id: id + ':open', kind: 'click', value: value, label: 'Open ' + label }));
      }
    }
  });

  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let length = 0;
  while ((node = walker.nextNode()) && length < maxTextChars) {
    const value = (node.textContent || '').trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !isVisible(parent)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
      words.push(value);
      length += value.length;
    }
  }
  const text = words.join('\\n').slice(0, maxTextChars);

  const height = document.documentElement.scrollHeight;
  const guards = {};
  let guardBudget = 0;
  let omitted = 0;
  const total = actions.length;
  if (total > maxActions) omitted = total - maxActions;
  actions.slice(0, maxActions).forEach((action) => {
    if (action.node && !(action.node in guards)) {
      const captured = guard(ids.get(action.node));
      if (captured) {
        const scope = captured[13];
        if (typeof scope === 'string' && guardBudget + scope.length > opts.guardTextBudget) {
          captured[13] = scope.slice(0, Math.max(0, opts.guardTextBudget - guardBudget));
        }
        guardBudget += typeof captured[13] === 'string' ? captured[13].length : 0;
        guards[action.node] = captured;
      }
    }
  });
  const capped = actions.slice(0, maxActions);
  const marker = JSON.stringify([
    performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text,
    capped.map((action) => {
      const clone = {};
      // P10 : rect est volatile (mise en page) et reste exclu du marker ; les
      // champs de CIBLE en revanche DOIVENT y entrer, sinon un changement de
      // href/form-action avec un libellé identique ne modifie pas le marker —
      // c'est précisément le trou que P10 ferme.
      Object.keys(action).forEach((key) => { if (key !== 'rect') clone[key] = action[key]; });
      return clone;
    }),
    pageKey[6],
  ]);

  if (scrollY + innerHeight < height - 2) capped.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) capped.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  capped.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });

  return {
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    scroll: { y: scrollY, height: height },
    text: text,
    actions: capped,
    marker: marker,
    guards: guards,
    omitted_actions: omitted,
  };
})`;

export function actionSpaceExpression(options: ActionSpaceOptions = {}): string {
  const payload = {
    maxActions: options.maxActions ?? DEFAULT_MAX_ACTIONS,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    maxGuardChars: options.maxGuardChars ?? DEFAULT_MAX_GUARD_CHARS,
    guardTextBudget: GUARD_TEXT_BUDGET,
  };
  return `(${ACTION_SPACE_FN})(${JSON.stringify(payload)})`;
}

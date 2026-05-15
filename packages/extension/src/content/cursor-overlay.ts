(() => {
  if ((window as any).__webbridge_cursor__) return;

  const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M5 3l14 8-6.5 1.5L11 19z" fill="#111" stroke="#fff" stroke-width="1.2"/>
  </svg>`;

  const el = document.createElement("div");
  el.id = "__webbridge_cursor__";
  el.innerHTML = CURSOR_SVG;
  Object.assign(el.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    left: "-40px",
    top: "-40px",
    width: "24px",
    height: "24px",
    transition: "none",
    willChange: "transform",
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(el);

  let visible = false;

  function show() {
    if (!visible) {
      el.style.opacity = "1";
      visible = true;
    }
  }

  function hide() {
    el.style.opacity = "0";
    visible = false;
  }

  function moveTo(x: number, y: number, animate: boolean) {
    show();
    el.style.transition = animate
      ? "transform 0.25s cubic-bezier(0.25,0.1,0.25,1)"
      : "none";
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.left = "0px";
    el.style.top = "0px";
  }

  function clickEffect(x: number, y: number) {
    const ripple = document.createElement("div");
    Object.assign(ripple.style, {
      position: "fixed",
      left: `${x - 12}px`,
      top: `${y - 12}px`,
      width: "24px",
      height: "24px",
      borderRadius: "50%",
      border: "2px solid rgba(59,130,246,0.8)",
      pointerEvents: "none",
      zIndex: "2147483646",
      animation: "__wb_ripple 0.4s ease-out forwards",
    } satisfies Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(ripple);
    setTimeout(() => ripple.remove(), 450);
  }

  // Inject ripple keyframes once
  const style = document.createElement("style");
  style.textContent = `
    @keyframes __wb_ripple {
      0% { transform: scale(1); opacity: 1; }
      100% { transform: scale(2.5); opacity: 0; }
    }
  `;
  document.documentElement.appendChild(style);

  // Highlight overlay for DOM CUA
  let highlightEl: HTMLDivElement | null = null;

  function highlightRect(rect: { x: number; y: number; width: number; height: number } | null) {
    if (!rect) {
      highlightEl?.remove();
      highlightEl = null;
      return;
    }
    if (!highlightEl) {
      highlightEl = document.createElement("div");
      Object.assign(highlightEl.style, {
        position: "fixed",
        zIndex: "2147483645",
        pointerEvents: "none",
        border: "2px solid rgba(59,130,246,0.7)",
        backgroundColor: "rgba(59,130,246,0.08)",
        borderRadius: "3px",
        transition: "all 0.2s ease",
      } satisfies Partial<CSSStyleDeclaration>);
      document.documentElement.appendChild(highlightEl);
    }
    Object.assign(highlightEl.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  (window as any).__webbridge_cursor__ = { moveTo, clickEffect, hide, show, highlightRect };
})();

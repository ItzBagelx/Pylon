// One copy of each chart: moving cards preserves canvas IDs, listeners and live data.
export const SECTIONS = [
  { id: "live", label: "Live", sections: ["h-now", "h-out"] },
  { id: "generation", label: "Generation", sections: ["h-hist"] },
  { id: "prices", label: "Prices", sections: ["h-price"] },
  { id: "outlook", label: "Outlook", sections: ["h-fc"] },
  { id: "batteries", label: "Batteries", sections: ["h-bat"] },
  { id: "demand", label: "Demand", sections: ["h-dem"] },
  { id: "capacity", label: "Capacity", sections: ["h-cap"] },
  { id: "records", label: "Records", sections: ["h-rec"] },
  { id: "pinned", label: "Pinned", sections: [] }
];
const STORAGE_KEY = "pylon-layout-v1";

export function normaliseLayout(value, groups) {
  const all = Object.values(groups).flat(), allowed = new Set(all);
  const unique = (list, valid) => [...new Set(Array.isArray(list) ? list.filter(x => typeof x === "string" && valid.has(x)) : [])];
  const pins = unique(value?.pins, allowed), order = {};
  for (const [key, defaults] of Object.entries(groups)) {
    const saved = unique(value?.order?.[key], new Set(defaults));
    order[key] = [...saved, ...defaults.filter(x => !saved.includes(x))];
  }
  return { pins, order };
}

export function moveItem(list, id, direction) {
  const from = list.indexOf(id), to = from + direction;
  if (from < 0 || ![-1, 1].includes(direction) || to < 0 || to >= list.length) return [...list];
  const next = [...list]; [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function sectionForHash(hash) {
  let id;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return "live"; }
  if (id === "history") return "generation";
  return SECTIONS.find(s => s.id === id || s.sections.includes(id))?.id || "live";
}

export function initDashboard(doc = document, win = window) {
  const nav = doc.getElementById("dashboardNav");
  if (!nav || nav.dataset.ready) return;
  nav.dataset.ready = "true";
  const root = doc.querySelector("main > .wrap"), footer = root.querySelector("footer");
  const tabs = [...nav.querySelectorAll("[data-section]")], panels = new Map(), cards = new Map(), groups = {}, homes = {};
  const clones = new Map();
  let active = "live", arranging = false, storageFailed = false;
  const status = doc.getElementById("layoutStatus");
  const announce = message => { status.textContent = message; };
  const notifyLayout = () => win.dispatchEvent(new win.Event("pylon:layout"));
  const settings = doc.getElementById("headerSettings"), settingsButton = settings?.querySelector("summary");
  function closeSettings(focus = false) {
    if (!settings?.open) return;
    settings.open = false;
    if (focus) settingsButton.focus({ preventScroll: true });
  }
  doc.addEventListener("click", event => { if (settings && !settings.contains(event.target)) closeSettings(); });
  doc.addEventListener("keydown", event => { if (event.key === "Escape" && settings?.open) { closeSettings(true); event.preventDefault(); } });
  doc.getElementById("region")?.addEventListener("change", () => closeSettings(true));
  doc.getElementById("refresh")?.addEventListener("click", () => closeSettings(true));

  for (const tab of SECTIONS) {
    const panel = doc.createElement("div");
    panel.className = "page-section"; panel.id = tab.id;
    panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", tab.sections[0] || "h-pinned");
    panel.tabIndex = -1;
    for (const id of tab.sections) {
      const section = doc.getElementById(id)?.closest(".sec");
      if (!section) continue;
      const grid = section.querySelector(".grid");
      groups[id] = []; homes[id] = grid;
      section.querySelectorAll(".card[data-info]").forEach(card => {
        const key = card.dataset.info;
        if (cards.has(key)) return;
        const controls = card.querySelector(".seg") || key === "agile_now" ? [] : [...section.querySelectorAll(".sec-head .seg")];
        card.id = `card-${key}`;
        cards.set(key, { card, get title() { return card.querySelector("h3").textContent.trim(); }, section: id, tab: tab.id, controls });
        groups[id].push(key);
      });
      panel.append(section);
    }
    root.insertBefore(panel, footer); panels.set(tab.id, panel);
  }
  const pinned = panels.get("pinned");
  pinned.innerHTML = `<section class="sec" aria-labelledby="h-pinned"><div class="sec-head"><div class="head-l"><h2 id="h-pinned">Your pinned charts</h2><p>Saved on this device. Use Arrange charts to change their order.</p></div></div><div class="empty-pins" id="emptyPins"><h3>Your own view of the grid</h3><p>Use the pin beside any chart title to keep it here.</p><button type="button" class="btn" id="browseCharts">Browse charts</button></div><div class="grid pinned-grid" id="pinnedGrid"></div></section>`;
  const pinnedGrid = doc.getElementById("pinnedGrid"), empty = doc.getElementById("emptyPins");
  let saved = null;
  try { saved = JSON.parse(win.localStorage.getItem(STORAGE_KEY)); } catch { /* Private browsing and corrupt preferences still get a usable dashboard. */ }
  const layout = normaliseLayout(saved, groups);
  function persist() {
    try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); }
    catch {
      if (!storageFailed) announce("Your browser cannot save preferences. This layout will last until you close the page.");
      storageFailed = true;
    }
  }
  function returnHome() {
    clones.clear();
    for (const record of cards.values()) { record.card.querySelector(".pin-context")?.remove(); record.placeholder?.remove(); }
    for (const [group, order] of Object.entries(layout.order)) {
      for (const key of order) homes[group]?.append(cards.get(key).card);
    }
  }
  function syncControls() {
    for (const [copy, source] of clones) {
      copy.disabled = source.disabled;
      if (source.hasAttribute("aria-pressed")) copy.setAttribute("aria-pressed", source.getAttribute("aria-pressed"));
    }
  }
  function makeContext(record) {
    const context = doc.createElement("div"); context.className = "pin-context";
    const origin = doc.createElement("button"); origin.type = "button"; origin.className = "pin-origin";
    origin.textContent = `Open ${SECTIONS.find(t => t.id === record.tab).label} →`;
    origin.addEventListener("click", () => selectTab(record.tab, { focus: true, scroll: true }));
    context.append(origin);
    if (record.controls.length) {
      const tools = doc.createElement("div"); tools.className = "tools";
      for (const source of record.controls) {
        const copy = source.cloneNode(true);
        [copy, ...copy.querySelectorAll("*")].forEach(el => {
          el.removeAttribute("id");
          for (const a of [...el.attributes]) if (a.name.startsWith("data-")) el.removeAttribute(a.name);
        });
        const originalButtons = [...source.querySelectorAll("button")];
        copy.querySelectorAll("button").forEach((button, i) => {
          const original = originalButtons[i]; clones.set(button, original);
          button.addEventListener("click", () => { original.click(); syncControls(); });
        });
        tools.append(copy);
      }
      context.append(tools);
    }
    return context;
  }
  function applyLayout() {
    returnHome();
    for (const key of layout.pins) {
      const record = cards.get(key);
      const placeholder = doc.createElement("p"); placeholder.className = "pin-placeholder";
      const jump = doc.createElement("a"); jump.href = `#${record.card.id}`; jump.textContent = `${record.title} is in your pinned charts →`;
      placeholder.append(jump); record.card.before(placeholder); record.placeholder = placeholder;
      const head = record.card.querySelector(".card-head");
      head.after(makeContext(record)); pinnedGrid.append(record.card);
    }
    for (const [key, record] of cards) {
      const isPinned = layout.pins.includes(key), list = isPinned ? layout.pins : layout.order[record.section].filter(k => !layout.pins.includes(k));
      record.pin.setAttribute("aria-pressed", String(isPinned));
      record.pin.setAttribute("aria-label", `${isPinned ? "Unpin" : "Pin"} ${record.title}`);
      record.pin.title = isPinned ? "Remove from pinned charts" : "Add to pinned charts";
      const index = list.indexOf(key);
      record.up.disabled = index <= 0; record.down.disabled = index < 0 || index === list.length - 1;
      record.position.textContent = index >= 0 ? `${index + 1} of ${list.length}` : "";
    }
    empty.hidden = layout.pins.length > 0;
    pinnedGrid.hidden = !layout.pins.length;
    doc.getElementById("pinCount").textContent = String(layout.pins.length);
    syncControls(); notifyLayout();
  }
  for (const [key, record] of cards) {
    const head = record.card.querySelector(".card-head");
    const pin = doc.createElement("button"); pin.type = "button"; pin.className = "pin-toggle";
    pin.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 8 0-1 7 4 4H5l4-4-1-7ZM12 14v7"/></svg>`;
    (head.querySelector(".hd-l") || head).append(pin); record.pin = pin;
    pin.addEventListener("click", () => {
      const index = layout.pins.indexOf(key);
      if (index < 0) layout.pins.push(key); else layout.pins.splice(index, 1);
      applyLayout(); announce(`${record.title} ${index < 0 ? "pinned" : "unpinned"}.`); persist();
      record.pin.focus({ preventScroll: true }); record.card.scrollIntoView({ block: "nearest" });
    });
    const order = doc.createElement("div"); order.className = "chart-order";
    const up = doc.createElement("button"), down = doc.createElement("button"), position = doc.createElement("span");
    for (const [button, direction, label] of [[up, -1, "↑ Earlier"], [down, 1, "↓ Later"]]) {
      button.type = "button"; button.className = "btn"; button.textContent = label;
      button.setAttribute("aria-label", `Move ${record.title} ${direction < 0 ? "earlier" : "later"}`);
      button.addEventListener("click", () => {
        if (layout.pins.includes(key)) layout.pins = moveItem(layout.pins, key, direction);
        else {
          const visible = layout.order[record.section].filter(k => !layout.pins.includes(k));
          const moved = moveItem(visible, key, direction); let i = 0;
          layout.order[record.section] = layout.order[record.section].map(k => layout.pins.includes(k) ? k : moved[i++]);
        }
        applyLayout(); announce(`${record.title} moved ${direction < 0 ? "earlier" : "later"}.`); persist();
        const focus = !button.disabled ? button : direction < 0 ? down : up;
        focus.focus({ preventScroll: true }); record.card.scrollIntoView({ block: "nearest" });
      });
    }
    order.append(up, down, position); head.after(order);
    Object.assign(record, { up, down, position });
    new win.MutationObserver(() => {
      pin.setAttribute("aria-label", `${layout.pins.includes(key) ? "Unpin" : "Pin"} ${record.title}`);
      up.setAttribute("aria-label", `Move ${record.title} earlier`);
      down.setAttribute("aria-label", `Move ${record.title} later`);
    }).observe(record.card.querySelector("h3"), { childList: true, subtree: true, characterData: true });
  }
  function markCurrent(id) {
    if (!panels.has(id)) return;
    active = id;
    for (const link of tabs) {
      if (link.dataset.section === id) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }

  }
  function selectTab(id, { focus = false, scroll = true, history = true, behavior } = {}) {
    if (!panels.has(id)) return;
    closeSettings(); markCurrent(id);
    if (history && win.location.hash !== `#${id}`) win.history.pushState(null, "", `#${id}`);
    if (scroll) panels.get(id).scrollIntoView({ block: "start", behavior: behavior || "auto" });
    if (focus) panels.get(id).focus({ preventScroll: true });
  }
  for (const link of tabs) link.addEventListener("click", event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); selectTab(link.dataset.section, { focus: true });
  });
  doc.getElementById("arrangeCharts").addEventListener("click", event => {
    arranging = !arranging; root.classList.toggle("arranging", arranging);
    event.currentTarget.setAttribute("aria-pressed", String(arranging));
    event.currentTarget.textContent = arranging ? "Done arranging" : "Arrange charts";
    event.currentTarget.setAttribute("aria-label", event.currentTarget.textContent);
    event.currentTarget.title = event.currentTarget.textContent;
    announce(arranging ? "Use Earlier and Later beside a chart to change its order." : storageFailed ? "Chart order kept for this visit." : "Chart order saved on this device.");
    closeSettings();
    panels.get(active).focus({ preventScroll: true });
    notifyLayout();
  });
  doc.getElementById("browseCharts").addEventListener("click", () => selectTab("live", { focus: true, scroll: true }));
  function followHash() {
    let id; try { id = decodeURIComponent(win.location.hash.slice(1)); } catch { id = ""; }
    const target = doc.getElementById(id), panel = target?.closest(".page-section");
    if (panel) { closeSettings(); markCurrent(panel.id); target.scrollIntoView({ block: "start", behavior: "auto" }); }
    else selectTab(sectionForHash(win.location.hash), { history: false, behavior: "auto" });
  }
  win.addEventListener("hashchange", followHash);
  doc.addEventListener("click", syncControls);
  let pendingFrame = false;
  win.addEventListener("scroll", () => {
    if (pendingFrame) return;
    pendingFrame = true;
    win.requestAnimationFrame(() => {
      pendingFrame = false; let current = SECTIONS[0].id;
      for (const [id, panel] of panels) if (panel.getBoundingClientRect().top <= 120) current = id;
      if (win.scrollY + win.innerHeight >= doc.documentElement.scrollHeight - 2) current = SECTIONS.at(-1).id;
      if (current !== active) markCurrent(current);
    });
  }, { passive: true });
  nav.hidden = false; applyLayout(); markCurrent("live");
  if (win.location.hash) win.requestAnimationFrame(followHash);

  return { navigate: selectTab, layout, cards, groups };
}

if (typeof document !== "undefined") initDashboard();

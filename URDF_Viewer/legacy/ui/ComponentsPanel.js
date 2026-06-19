export function createComponentsPanel(app, theme) {
    if (!app || !app.assets || !app.isolate || !app.showAll) {
        throw new Error("[ComponentsPanel] Missing required app APIs");
    }
    const ui = {
        root: document.createElement("div"),
        btn: document.createElement("button"),
        panel: document.createElement("div"),
        header: document.createElement("div"),
        title: document.createElement("div"),
        showAllBtn: document.createElement("button"),
        details: document.createElement("div"),
        detailsTitle: document.createElement("div"),
        detailsBody: document.createElement("div"),
        list: document.createElement("div"),
    };
    const UI_SCALE = 0.5;
    const UI_SCALE_INV = 1 / UI_SCALE;
    const BUTTON_LEFT = 50;
    const BUTTON_BOTTOM = 14;
    const PANEL_BASE_WIDTH = 440;
    const PANEL_GAP_ABOVE_BUTTON = 10;
    const SAFE_GAP = 14;
    let open = false;
    let building = false;
    let disposed = false;
    let currentEnt = null;
    let currentIndex = null;
    let currentClosedTx = -2000;
    const css = {
        root: {
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: "9999",
            overflow: "hidden",
            fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
        },
        btn: {
            position: "absolute",
            left: `${BUTTON_LEFT}px`,
            bottom: `${BUTTON_BOTTOM}px`,
            padding: "8px 12px",
            borderRadius: "12px",
            border: `1px solid ${theme.stroke}`,
            background: theme.bgPanel,
            color: theme.text,
            fontWeight: "700",
            cursor: "pointer",
            boxShadow: theme.shadow,
            pointerEvents: "auto",
            transition: "all .12s ease",
        },
        panel: {
            position: "absolute",
            left: `${BUTTON_LEFT}px`,
            bottom: "60px",
            width: `${PANEL_BASE_WIDTH}px`,
            maxHeight: `calc(92vh * ${UI_SCALE_INV})`,
            background: theme.bgPanel,
            border: `1px solid ${theme.stroke}`,
            boxShadow: theme.shadow,
            borderRadius: "18px",
            overflow: "hidden",
            display: "block",
            pointerEvents: "auto",
            willChange: "transform, opacity",
            transition: "transform 260ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease",
            transform: "translateX(-2000px)",
            opacity: "0",
        },
        header: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "10px 12px",
            borderBottom: `1px solid ${theme.stroke}`,
            background: "#0ea5a6",
        },
        title: {
            fontWeight: "800",
            color: "#ffffff",
            fontSize: "14px",
        },
        showAllBtn: {
            padding: "6px 10px",
            borderRadius: "10px",
            border: `1px solid ${theme.stroke}`,
            background: theme.bgPanel,
            fontWeight: "700",
            cursor: "pointer",
            fontSize: "11px",
            transition: "all .12s ease",
        },
        details: {
            display: "none",
            padding: "10px 12px",
            borderBottom: `1px solid ${theme.stroke}`,
            background: "#ffffff",
        },
        detailsTitle: {
            fontWeight: "800",
            fontSize: "13px",
            marginBottom: "4px",
            color: theme.text,
        },
        detailsBody: {
            fontSize: "12px",
            lineHeight: "1.5",
            color: theme.textMuted,
            whiteSpace: "pre-wrap",
        },
        list: {
            overflowY: "auto",
            maxHeight: `calc((92vh - 52px) * ${UI_SCALE_INV})`,
            padding: "10px",
        },
    };
    applyStyles(ui.root, css.root);
    applyStyles(ui.btn, css.btn);
    applyStyles(ui.panel, css.panel);
    applyStyles(ui.header, css.header);
    applyStyles(ui.title, css.title);
    applyStyles(ui.showAllBtn, css.showAllBtn);
    applyStyles(ui.details, css.details);
    applyStyles(ui.detailsTitle, css.detailsTitle);
    applyStyles(ui.detailsBody, css.detailsBody);
    applyStyles(ui.list, css.list);
    ui.btn.style.transformOrigin = "bottom left";
    ui.btn.style.scale = String(UI_SCALE);
    ui.panel.style.transformOrigin = "bottom left";
    ui.panel.style.scale = String(UI_SCALE);
    ui.btn.textContent = "Components";
    ui.title.textContent = "Components";
    ui.showAllBtn.textContent = "Show all";
    ui.header.appendChild(ui.title);
    ui.header.appendChild(ui.showAllBtn);
    ui.details.appendChild(ui.detailsTitle);
    ui.details.appendChild(ui.detailsBody);
    ui.panel.appendChild(ui.header);
    ui.panel.appendChild(ui.details);
    ui.panel.appendChild(ui.list);
    ui.root.appendChild(ui.panel);
    ui.root.appendChild(ui.btn);
    const host = (app.renderer && app.renderer.domElement
        ? app.renderer.domElement.parentElement
        : null) || document.body;
    const hostStyle = window.getComputedStyle(host);
    if (hostStyle.position === "static") {
        host.style.position = "relative";
    }
    host.appendChild(ui.root);
    function getHostSize() {
        const rect = host.getBoundingClientRect();
        return {
            width: Math.max(rect.width || window.innerWidth || 1, 1),
            height: Math.max(rect.height || window.innerHeight || 1, 1),
        };
    }
    function computeClosedTx({ left, panelWidth, hostW }) {
        const visualPanelWidth = panelWidth * UI_SCALE;
        const neededVisualMove = left + visualPanelWidth + SAFE_GAP + Math.max(80, hostW * 0.08);
        return -Math.ceil(neededVisualMove * UI_SCALE_INV);
    }
    function updateResponsiveLayout() {
        if (disposed)
            return;
        const { width: hostW, height: hostH } = getHostSize();
        const left = hostW < 360
            ? SAFE_GAP
            : Math.min(BUTTON_LEFT, Math.max(SAFE_GAP, hostW - 160));
        const btnHeightVisual = (ui.btn.offsetHeight || 42) * UI_SCALE;
        const panelBottom = BUTTON_BOTTOM + btnHeightVisual + PANEL_GAP_ABOVE_BUTTON;
        const maxPanelWidthByHost = Math.max(260, (hostW - left - SAFE_GAP) * UI_SCALE_INV);
        const panelWidth = Math.min(PANEL_BASE_WIDTH, maxPanelWidthByHost);
        const availableVisualHeight = Math.max(120, hostH - panelBottom - SAFE_GAP);
        const availableLayoutHeight = availableVisualHeight * UI_SCALE_INV;
        ui.btn.style.left = `${left}px`;
        ui.btn.style.bottom = `${BUTTON_BOTTOM}px`;
        ui.panel.style.left = `${left}px`;
        ui.panel.style.bottom = `${panelBottom}px`;
        ui.panel.style.width = `${panelWidth}px`;
        ui.panel.style.maxHeight = `${availableLayoutHeight}px`;
        ui.list.style.maxHeight = `${Math.max(80, availableLayoutHeight - 52)}px`;
        currentClosedTx = computeClosedTx({
            left,
            panelWidth,
            hostW,
        });
        if (!open) {
            ui.panel.style.transform = `translateX(${currentClosedTx}px)`;
        }
    }
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
        resizeObserver.observe(host);
    }
    else {
        window.addEventListener("resize", updateResponsiveLayout);
    }
    requestAnimationFrame(updateResponsiveLayout);
    ui.btn.addEventListener("mouseenter", () => {
        ui.btn.style.transform = "translateY(-1px) scale(1.02)";
        ui.btn.style.background = theme.tealFaint;
        ui.btn.style.borderColor = theme.tealSoft ?? theme.teal;
    });
    ui.btn.addEventListener("mouseleave", () => {
        ui.btn.style.transform = "none";
        ui.btn.style.background = theme.bgPanel;
        ui.btn.style.borderColor = theme.stroke;
    });
    ui.showAllBtn.addEventListener("mouseenter", () => {
        ui.showAllBtn.style.transform = "translateY(-1px) scale(1.02)";
        ui.showAllBtn.style.background = theme.tealFaint;
        ui.showAllBtn.style.borderColor = theme.tealSoft ?? theme.teal;
    });
    ui.showAllBtn.addEventListener("mouseleave", () => {
        ui.showAllBtn.style.transform = "none";
        ui.showAllBtn.style.background = theme.bgPanel;
        ui.showAllBtn.style.borderColor = theme.stroke;
    });
    ui.showAllBtn.addEventListener("click", () => {
        try {
            app.clearSelection?.();
            app.interaction?.clearHover?.();
        }
        catch (_) { }
        try {
            app.showAll();
        }
        catch (_) { }
        hideDetails();
    });
    function set(isOpen) {
        open = !!isOpen;
        updateResponsiveLayout();
        if (open) {
            ui.panel.style.opacity = "1";
            ui.panel.style.transform = "translateX(0px)";
            ui.panel.style.pointerEvents = "auto";
        }
        else {
            ui.panel.style.opacity = "0";
            ui.panel.style.transform = `translateX(${currentClosedTx}px)`;
            ui.panel.style.pointerEvents = "none";
        }
    }
    function openPanel() {
        set(true);
        maybeBuild();
    }
    function closePanel() {
        set(false);
    }
    ui.btn.addEventListener("click", () => {
        set(!open);
        if (open)
            maybeBuild();
    });
    async function maybeBuild() {
        if (building || disposed)
            return;
        building = true;
        try {
            await renderList();
            updateResponsiveLayout();
        }
        finally {
            building = false;
        }
    }
    async function renderList() {
        clearElement(ui.list);
        let items = [];
        try {
            const res = app.assets.list?.();
            items = Array.isArray(res) ? res : await res;
        }
        catch {
            items = [];
        }
        if (!items.length) {
            const empty = document.createElement("div");
            empty.textContent = "No components with visual geometry found.";
            empty.style.color = theme.textMuted;
            empty.style.fontWeight = "600";
            empty.style.padding = "8px 2px";
            ui.list.appendChild(empty);
            return;
        }
        items.forEach((ent, index) => {
            const row = document.createElement("div");
            applyStyles(row, rowStyles(theme));
            const img = document.createElement("img");
            applyStyles(img, thumbStyles(theme));
            img.alt = ent.base;
            img.loading = "eager";
            img.decoding = "async";
            const meta = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = ent.base;
            title.style.fontWeight = "700";
            title.style.fontSize = "14px";
            title.style.color = theme.text;
            const small = document.createElement("div");
            small.textContent = `.${ent.ext || "asset"} • ${ent.count} instance${ent.count > 1 ? "s" : ""}`;
            small.style.color = theme.textMuted;
            small.style.fontSize = "12px";
            small.style.marginTop = "2px";
            meta.appendChild(title);
            meta.appendChild(small);
            row.appendChild(img);
            row.appendChild(meta);
            ui.list.appendChild(row);
            row.addEventListener("mouseenter", () => {
                row.style.transform = "translateY(-1px) scale(1.02)";
                row.style.background = theme.tealFaint;
                row.style.borderColor = theme.tealSoft ?? theme.teal;
            });
            row.addEventListener("mouseleave", () => {
                row.style.transform = "none";
                row.style.background = "#fff";
                row.style.borderColor = theme.stroke;
            });
            row.addEventListener("click", () => {
                try {
                    app.clearSelection?.();
                    app.interaction?.clearHover?.();
                }
                catch (_) { }
                try {
                    app.isolate.asset(ent.assetKey);
                }
                catch (_) { }
                currentEnt = ent;
                currentIndex = index;
                showDetails(ent, index);
                set(true);
            });
            (async () => {
                try {
                    const url = await app.assets.thumbnail?.(ent.assetKey);
                    if (url) {
                        img.src = url;
                    }
                    else {
                        img.replaceWith(makeThumbFallback(ent.base, theme));
                    }
                }
                catch {
                    img.replaceWith(makeThumbFallback(ent.base, theme));
                }
                finally {
                    updateResponsiveLayout();
                }
            })();
        });
        updateResponsiveLayout();
    }
    function resolveDescription(ent, index) {
        let text = "";
        try {
            if (typeof app.getComponentDescription === "function") {
                text = app.getComponentDescription(ent.assetKey, index) || "";
            }
        }
        catch (_) {
            text = "";
        }
        if (!text && app.componentDescriptions) {
            const src = app.componentDescriptions;
            if (src[ent.assetKey]) {
                text = src[ent.assetKey];
            }
            else {
                const base = basenameNoExt(ent.assetKey);
                if (src[base])
                    text = src[base];
            }
        }
        return text;
    }
    function showDetails(ent, index) {
        if (disposed)
            return;
        const text = resolveDescription(ent, index);
        if (!text) {
            console.debug("[ComponentsPanel] No se encontró descripción para", ent.assetKey);
        }
        console.debug("[ComponentsPanel] showDetails:", ent.assetKey, "=>", text);
        updateResponsiveLayout();
    }
    function hideDetails() {
        ui.details.style.display = "none";
        ui.detailsTitle.textContent = "";
        ui.detailsBody.textContent = "";
        currentEnt = null;
        currentIndex = null;
        updateResponsiveLayout();
    }
    function refreshCurrentDetailsFromIA() {
        if (!currentEnt && currentIndex == null)
            return;
        const txt = resolveDescription(currentEnt, currentIndex);
        if (txt && txt !== ui.detailsBody.textContent) {
            ui.detailsBody.textContent = txt;
            console.debug("[ComponentsPanel][IA] Detalle actualizado tras IA para", currentEnt.assetKey);
        }
    }
    function onIAReady(ev) {
        console.debug("[ComponentsPanel][IA] ia_descriptions_ready", ev && ev.detail);
        refreshCurrentDetailsFromIA();
    }
    window.addEventListener("ia_descriptions_ready", onIAReady);
    let pollCount = 0;
    const pollTimer = setInterval(() => {
        if (disposed) {
            clearInterval(pollTimer);
            return;
        }
        pollCount += 1;
        if (app.componentDescriptions &&
            Object.keys(app.componentDescriptions).length > 0) {
            console.debug("[ComponentsPanel][IA] Descripciones detectadas por poll");
            refreshCurrentDetailsFromIA();
            clearInterval(pollTimer);
        }
        if (pollCount > 20) {
            clearInterval(pollTimer);
        }
    }, 500);
    async function refresh() {
        if (disposed)
            return;
        await renderList();
        updateResponsiveLayout();
    }
    function destroy() {
        disposed = true;
        try {
            document.removeEventListener("keydown", onHotkeyC, true);
        }
        catch (_) { }
        try {
            window.removeEventListener("ia_descriptions_ready", onIAReady);
        }
        catch (_) { }
        try {
            if (resizeObserver) {
                resizeObserver.disconnect();
            }
            else {
                window.removeEventListener("resize", updateResponsiveLayout);
            }
        }
        catch (_) { }
        clearInterval(pollTimer);
        try {
            ui.btn.remove();
        }
        catch (_) { }
        try {
            ui.panel.remove();
        }
        catch (_) { }
        try {
            ui.root.remove();
        }
        catch (_) { }
    }
    function onHotkeyC(e) {
        const tag = (e.target && e.target.tagName) || "";
        const t = tag.toLowerCase();
        if (t === "input" || t === "textarea" || t === "select" || e.isComposing) {
            return;
        }
        if (e.key === "c" || e.key === "C" || e.code === "KeyC") {
            e.preventDefault();
            set(!open);
            if (open)
                maybeBuild();
        }
    }
    document.addEventListener("keydown", onHotkeyC, true);
    set(false);
    maybeBuild();
    return {
        open: openPanel,
        close: closePanel,
        set,
        refresh,
        destroy,
    };
}
function applyStyles(el, styles) {
    Object.assign(el.style, styles);
}
function clearElement(el) {
    while (el.firstChild)
        el.removeChild(el.firstChild);
}
function basenameNoExt(p) {
    const q = String(p || "").split("/").pop().split("?")[0].split("#")[0];
    const dot = q.lastIndexOf(".");
    return dot >= 0 ? q.slice(0, dot) : q;
}
function rowStyles(theme) {
    return {
        display: "grid",
        gridTemplateColumns: "128px 1fr",
        gap: "12px",
        alignItems: "center",
        padding: "10px",
        borderRadius: "12px",
        border: `1px solid ${theme.stroke}`,
        marginBottom: "10px",
        background: "#fff",
        cursor: "pointer",
        transition: "transform .08s ease, box-shadow .12s ease",
    };
}
function thumbStyles(theme) {
    return {
        width: "128px",
        height: "96px",
        objectFit: "contain",
        background: "#f7fbfb",
        borderRadius: "10px",
        border: `1px solid ${theme.stroke}`,
    };
}
function makeThumbFallback(label, theme) {
    const wrap = document.createElement("div");
    wrap.style.width = "128px";
    wrap.style.height = "96px";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.background = "#f7fbfb";
    wrap.style.border = `1px solid ${theme.stroke}`;
    wrap.style.borderRadius = "10px";
    wrap.style.fontSize = "11px";
    wrap.style.color = theme.textMuted;
    wrap.style.textAlign = "center";
    wrap.textContent = label || "—";
    return wrap;
}

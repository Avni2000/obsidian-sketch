import { TextFileView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import paper from "paper";
import { emptyData, Page, Stroke, WhiteboardData, parseData, serializeData, uid } from "./types";
import { ICON } from "./icons";
import { ConfirmModal } from "./confirm";
import type PencilPlugin from "./main";

export const VIEW_TYPE_PENCIL = "pencil-whiteboard";

type Tool = "pencil" | "eraser" | "select" | "pan";

interface ActivePointer {
	id: number;
	type: string;
	clientX: number;
	clientY: number;
}

/** A page currently materialized in the paper.js scene graph. */
interface MountedPage {
	group: paper.Group;
	/** Clipped group holding one paper.Path per stroke. */
	strokes: paper.Group;
}

const BUILTIN_COLORS = [
	"#ffffff",
	"#f1f1f1",
	"#ffd166",
	"#ef476f",
	"#06d6a0",
	"#118ab2",
	"#c77dff",
	"#222222",
];

const SIZES = [1.5, 3, 6, 12];

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

/** Pages are a fixed-size, Letter-proportioned sheet stacked vertically
 * ("continuous scroll", like Samsung Notes) instead of an unbounded canvas. */
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;
const PAGE_GAP = 40;
const PAGE_STRIDE = PAGE_HEIGHT + PAGE_GAP;
/** Extra pages kept mounted above/below the visible range. */
const MOUNT_BUFFER = 1;

const PAGE_COLOR_FALLBACK = "#f5f2ea";
const ACCENT = "#5b9dff";

function rgbToHex(rgb: string): string {
	const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (!m) return rgb;
	const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
	return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

/**
 * Reads an Obsidian theme CSS variable (e.g. "--background-primary") as a
 * hex color. Custom properties can hold unresolved var() chains, so
 * getComputedStyle on the variable itself may return a literal string like
 * "hsl(var(--foo))" rather than a color; assigning it to a real CSS property
 * on a probe element forces the browser to resolve it fully.
 */
function resolveThemeColor(varName: string, prop: "color" | "backgroundColor", fallback: string): string {
	try {
		const probe = document.createElement("div");
		probe.style.position = "absolute";
		probe.style.visibility = "hidden";
		probe.style.pointerEvents = "none";
		probe.style.setProperty(prop === "color" ? "color" : "background-color", `var(${varName})`);
		document.body.appendChild(probe);
		const resolved = getComputedStyle(probe)[prop];
		document.body.removeChild(probe);
		return resolved ? rgbToHex(resolved) : fallback;
	} catch {
		return fallback;
	}
}

export class PencilWhiteboardView extends TextFileView {
	private boardData: WhiteboardData = emptyData();

	private canvas!: HTMLCanvasElement;
	private container!: HTMLDivElement;
	private toolbar!: HTMLDivElement;
	private statusEl!: HTMLDivElement;

	private paperScope: paper.PaperScope | null = null;
	private pageLayer!: paper.Layer;
	private overlayLayer!: paper.Layer;
	/** Page id -> mounted scene nodes. Only pages near the viewport live here. */
	private mounted: Map<string, MountedPage> = new Map();
	private needsInitialFit = true;

	private tool: Tool = "pencil";
	private color: string = BUILTIN_COLORS[0];
	private pageColor: string = PAGE_COLOR_FALLBACK;
	private size: number = SIZES[1];
	private eraseRadius = 8;

	private pointers: Map<number, ActivePointer> = new Map();
	private penActive = false;
	/** Once a pen has been used in this view, finger touches default to pan
	 * (Apple Pencil convention). Until then, single-finger touches draw. */
	private penSeen = false;
	private pressureBtn: HTMLButtonElement | null = null;

	/** In-progress freehand stroke (paper renders it live as points are added). */
	private live: null | {
		path: paper.Path;
		pageId: string;
		pointerId: number;
		pressures: number[];
	} = null;

	private pinch: null | {
		ids: [number, number];
		startDist: number;
		startZoom: number;
		startMidProject: paper.Point;
	} = null;

	private panStart: null | {
		center: paper.Point;
		clientX: number;
		clientY: number;
	} = null;

	private marqueeStart: paper.Point | null = null;
	private marqueeItem: paper.Path | null = null;
	private selectedIds: Set<string> = new Set();
	private selDrag: null | { last: paper.Point; moved: boolean } = null;

	private undoStack: WhiteboardData[] = [];
	private redoStack: WhiteboardData[] = [];
	/** Pre-gesture snapshot; pushed to the undo stack only if the gesture changes data. */
	private pendingSnapshot: WhiteboardData | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private onWindowKeyDown: (e: KeyboardEvent) => void = () => {};

	private readonly plugin: PencilPlugin;
	/** Active-state check functions for toolbar buttons/swatches, keyed by element. */
	private activeChecks: WeakMap<HTMLElement, () => boolean> = new WeakMap();

	constructor(leaf: WorkspaceLeaf, plugin: PencilPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	private allColors(): string[] {
		return [...BUILTIN_COLORS, ...this.plugin.settings.customColors];
	}

	getViewType(): string {
		return VIEW_TYPE_PENCIL;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Whiteboard";
	}

	getIcon(): string {
		return ICON.pencil;
	}

	getViewData(): string {
		return serializeData(this.boardData);
	}

	setViewData(data: string, _clear: boolean): void {
		this.boardData = parseData(data);
		this.undoStack = [];
		this.redoStack = [];
		this.selectedIds.clear();
		this.pendingSnapshot = null;
		if (this.paperScope) this.resetScene(true);
	}

	clear(): void {
		this.boardData = emptyData();
		this.undoStack = [];
		this.redoStack = [];
		this.selectedIds.clear();
		if (this.paperScope) this.resetScene(false);
	}

	async onOpen(): Promise<void> {
		// Pick page/pen defaults from the active Obsidian theme so a fresh
		// board looks native rather than always opening as cream paper with
		// a white pen (invisible on a light theme's white background).
		this.pageColor = resolveThemeColor("--background-primary", "backgroundColor", PAGE_COLOR_FALLBACK);
		BUILTIN_COLORS[0] = resolveThemeColor("--text-normal", "color", BUILTIN_COLORS[0]);
		this.color = BUILTIN_COLORS[0];

		const root = this.contentEl;
		root.empty();
		root.addClass("pencil-root");

		this.toolbar = root.createDiv({ cls: "pencil-toolbar" });
		this.container = root.createDiv({ cls: "pencil-canvas-wrap" });
		this.canvas = this.container.createEl("canvas", { cls: "pencil-canvas" });
		this.statusEl = root.createDiv({ cls: "pencil-status" });

		// One PaperScope per view so multiple whiteboards can be open at once.
		// Paper owns the render loop, transforms and hi-DPI backing store.
		const scope = new paper.PaperScope();
		scope.setup(this.canvas);
		scope.settings.insertItems = false;
		this.paperScope = scope;
		this.pageLayer = new paper.Layer();
		this.overlayLayer = new paper.Layer();
		scope.project.addLayer(this.pageLayer);
		scope.project.addLayer(this.overlayLayer);
		this.pageLayer.selectedColor = new paper.Color(ACCENT);

		this.buildToolbar();
		this.attachPointerHandlers();

		this.onWindowKeyDown = (e: KeyboardEvent) => this.handleKey(e);
		window.addEventListener("keydown", this.onWindowKeyDown);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.container);
		this.resize();
		this.resetScene(true);
	}

	async onClose(): Promise<void> {
		window.removeEventListener("keydown", this.onWindowKeyDown);
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		try {
			this.paperScope?.project?.remove();
			this.paperScope?.view?.remove();
		} catch (e) {
			console.error("Pencil: error tearing down paper scope", e);
		}
		this.paperScope = null;
		this.mounted.clear();
		this.contentEl.empty();
	}

	// ---- Toolbar ----

	private buildToolbar(): void {
		const tb = this.toolbar;
		tb.empty();

		// Always render the SVG icon. On some older mobile builds plugin-registered
		// icons can come up blank (no <svg> child, or an empty one); in that case we
		// fall back to a short text label so the button stays usable.
		const makeBtn = (
			label: string,
			shortLabel: string,
			icon: string,
			onClick: () => void,
			isActive?: () => boolean,
		): HTMLButtonElement => {
			const btn = tb.createEl("button", {
				cls: "pencil-btn",
				attr: { "aria-label": label, title: label },
			});
			setIcon(btn, icon);
			const svg = btn.querySelector("svg");
			// WebKit (notably the iPad's Safari build) applies intrinsic/aspect
			// sizing to an inline <svg> that is a flex child and ignores the CSS
			// size, collapsing the icon to zero -> blank button. Explicit
			// width/height ATTRIBUTES restore a definite size on every engine.
			if (svg) {
				svg.setAttribute("width", "18");
				svg.setAttribute("height", "18");
			}
			const rendered = svg && svg.innerHTML.trim().length > 0;
			if (!rendered) {
				btn.empty();
				btn.addClass("pencil-btn-text");
				btn.setText(shortLabel);
			}
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				onClick();
				this.refreshToolbarState();
			});
			if (isActive) this.activeChecks.set(btn, isActive);
			return btn;
		};

		makeBtn("Pencil", "Pen", ICON.pencil, () => (this.tool = "pencil"), () => this.tool === "pencil");
		makeBtn("Eraser", "Erase", ICON.eraser, () => (this.tool = "eraser"), () => this.tool === "eraser");
		makeBtn("Select", "Select", ICON.select, () => (this.tool = "select"), () => this.tool === "select");
		makeBtn("Pan", "Pan", ICON.hand, () => (this.tool = "pan"), () => this.tool === "pan");

		tb.createDiv({ cls: "pencil-sep" });

		makeBtn("Previous page", "Prev", ICON.chevronUp, () => this.gotoPage(-1));
		makeBtn("Next page", "Next", ICON.chevronDown, () => this.gotoPage(1));
		makeBtn("Add page", "Add pg", ICON.pagePlus, () => this.addPage());
		makeBtn("Delete page", "Del pg", ICON.pageDelete, () => this.deleteCurrentPage());

		tb.createDiv({ cls: "pencil-sep" });

		const builtinCount = BUILTIN_COLORS.length;
		const palette = this.allColors();
		for (let i = 0; i < palette.length; i++) {
			const c = palette[i];
			const isCustom = i >= builtinCount;
			const sw = tb.createDiv({
				cls: isCustom ? "pencil-swatch pencil-swatch-custom" : "pencil-swatch",
				attr: {
					"aria-label": `Color ${c}`,
					title: isCustom ? `${c} (long-press to remove)` : c,
				},
			});
			sw.style.backgroundColor = c;
			sw.addEventListener("click", (e) => {
				e.preventDefault();
				this.color = c;
				this.refreshToolbarState();
			});
			if (isCustom) this.attachLongPressRemove(sw, c);
			this.activeChecks.set(sw, () => this.color === c);
		}

		const addBtn = tb.createDiv({
			cls: "pencil-swatch pencil-swatch-add",
			attr: { "aria-label": "Add color", title: "Add custom color" },
		});
		addBtn.setText("+");
		// Overlay a transparent native <input type="color"> on top of the
		// "+" swatch. iOS/WKWebView won't open the color picker from a
		// programmatic .click() on a hidden input, but a tappable,
		// zero-opacity overlay receives the real touch and opens the native
		// picker on every platform (desktop, iPad, iPhone, Android).
		const colorInput = addBtn.createEl("input", { type: "color" });
		colorInput.addClass("pencil-color-input");
		colorInput.value = this.color || ACCENT;
		colorInput.addEventListener("change", () => {
			const value = colorInput.value;
			if (value) void this.addCustomColor(value);
		});

		tb.createDiv({ cls: "pencil-sep" });

		for (const s of SIZES) {
			const sw = tb.createDiv({ cls: "pencil-size", attr: { "aria-label": `Size ${s}`, title: `Size ${s}` } });
			const dot = sw.createDiv({ cls: "pencil-size-dot" });
			const px = Math.max(2, Math.min(20, s * 2));
			dot.style.width = `${px}px`;
			dot.style.height = `${px}px`;
			sw.addEventListener("click", (e) => {
				e.preventDefault();
				this.size = s;
				this.refreshToolbarState();
			});
			this.activeChecks.set(sw, () => this.size === s);
		}

		this.pressureBtn = makeBtn(
			"Pressure (pen thickness)",
			"Pressure",
			ICON.pressure,
			() => this.togglePressure(),
			() => this.plugin.settings.pressureEnabled,
		);

		tb.createDiv({ cls: "pencil-sep" });

		makeBtn("Undo", "Undo", ICON.undo, () => this.undo());
		makeBtn("Redo", "Redo", ICON.redo, () => this.redo());

		tb.createDiv({ cls: "pencil-sep" });

		makeBtn("Zoom in", "+", ICON.zoomIn, () => this.zoomAtCenter(1.2));
		makeBtn("Zoom out", "−", ICON.zoomOut, () => this.zoomAtCenter(1 / 1.2));
		makeBtn("Fit", "Fit", ICON.fit, () => this.zoomToFit());
		makeBtn("Reset view", "Reset", ICON.reset, () => this.resetView());

		tb.createDiv({ cls: "pencil-sep" });

		makeBtn("Delete selection", "Del", ICON.trash, () => this.deleteSelection());
		makeBtn("Clear all", "Clear", ICON.clear, () => this.clearAllPrompt());

		this.refreshToolbarState();
	}

	private async addCustomColor(hex: string): Promise<void> {
		const normalized = hex.toLowerCase();
		const all = this.allColors().map((c) => c.toLowerCase());
		if (!all.includes(normalized)) {
			this.plugin.settings.customColors.push(normalized);
			await this.plugin.saveSettings();
		}
		this.color = normalized;
		// Defer the rebuild: the color input lives inside the toolbar, and
		// emptying the toolbar synchronously inside the input's own `change`
		// handler destroys it while iPhone's full-screen native picker is still
		// on screen, crashing WebContent. By the next tick the picker has
		// closed and the input is safe to replace.
		window.setTimeout(() => this.buildToolbar(), 0);
	}

	private async removeCustomColor(hex: string): Promise<void> {
		const normalized = hex.toLowerCase();
		const list = this.plugin.settings.customColors;
		const idx = list.findIndex((c) => c.toLowerCase() === normalized);
		if (idx === -1) return;
		list.splice(idx, 1);
		await this.plugin.saveSettings();
		if (this.color.toLowerCase() === normalized) this.color = BUILTIN_COLORS[0];
		window.setTimeout(() => this.buildToolbar(), 0);
	}

	private attachLongPressRemove(el: HTMLElement, hex: string): void {
		let timer: number | null = null;
		let fired = false;
		const clear = () => {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
		};
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== undefined && e.button !== 0) return;
			fired = false;
			clear();
			timer = window.setTimeout(() => {
				fired = true;
				timer = null;
				new ConfirmModal(
					this.app,
					`Remove color ${hex} from the palette?`,
					() => void this.removeCustomColor(hex),
					"Remove",
				).open();
			}, 600);
		});
		el.addEventListener("pointerup", clear);
		el.addEventListener("pointerleave", clear);
		el.addEventListener("pointercancel", clear);
		// Right-click on desktop is a quick alternative to long-press.
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			new ConfirmModal(
				this.app,
				`Remove color ${hex} from the palette?`,
				() => void this.removeCustomColor(hex),
				"Remove",
			).open();
		});
		// Swallow the click that follows a successful long-press so the color
		// isn't also selected.
		el.addEventListener(
			"click",
			(e) => {
				if (fired) {
					e.preventDefault();
					e.stopImmediatePropagation();
					fired = false;
				}
			},
			true,
		);
	}

	private togglePressure(): void {
		this.plugin.settings.pressureEnabled = !this.plugin.settings.pressureEnabled;
		void this.plugin.saveSettings();
		this.refreshToolbarState();
	}

	private refreshToolbarState(): void {
		const els = this.toolbar.querySelectorAll<HTMLElement>("button, .pencil-swatch, .pencil-size");
		els.forEach((el) => {
			const check = this.activeChecks.get(el);
			if (check) el.toggleClass("is-active", check());
		});
		if (this.pressureBtn) {
			this.pressureBtn.setAttr(
				"title",
				this.plugin.settings.pressureEnabled
					? "Pressure thickness: on for pen input (tap to turn off)"
					: "Pressure thickness: off (tap to turn on for pen input)",
			);
		}
	}

	// ---- Scene management (pages as lazily mounted paper.js groups) ----

	private view(): paper.View {
		// Only called after onOpen has set the scope up.
		return (this.paperScope as paper.PaperScope).view;
	}

	private pageTop(index: number): number {
		return index * PAGE_STRIDE;
	}

	/** The page whose sheet contains the given document-space point, or null in margins/gaps. */
	private pageIndexAt(pt: paper.Point): number | null {
		if (pt.x < 0 || pt.x > PAGE_WIDTH) return null;
		const i = Math.floor(pt.y / PAGE_STRIDE);
		if (i < 0 || i >= this.boardData.pages.length) return null;
		return pt.y - this.pageTop(i) <= PAGE_HEIGHT ? i : null;
	}

	/** The page nearest the viewport center, used for status text and page-relative actions. */
	private currentPageIndex(): number {
		const y = this.view().center.y;
		const i = Math.floor((y + PAGE_GAP / 2) / PAGE_STRIDE);
		return Math.max(0, Math.min(this.boardData.pages.length - 1, i));
	}

	/** Rebuild the whole scene from boardData (load, undo/redo, page add/remove). */
	private resetScene(applySavedView: boolean): void {
		if (!this.paperScope) return;
		this.paperScope.activate();
		this.pageLayer.removeChildren();
		this.overlayLayer.removeChildren();
		this.marqueeItem = null;
		this.marqueeStart = null;
		this.live = null;
		this.mounted.clear();

		if (applySavedView && this.boardData.view) {
			const v = this.boardData.view;
			this.view().zoom = this.clampZoom(v.zoom);
			this.view().center = new paper.Point(v.cx, v.cy);
			this.needsInitialFit = false;
		} else if (applySavedView) {
			this.needsInitialFit = true;
			this.applyInitialFitIfNeeded();
		}
		this.updateVirtualization();
	}

	/**
	 * Virtualization: mount pages intersecting the viewport (± MOUNT_BUFFER),
	 * remove everything else from the scene graph. Off-screen pages exist only
	 * as JSON until scrolled back into view.
	 */
	private updateVirtualization(): void {
		if (!this.paperScope) return;
		this.paperScope.activate();
		const pages = this.boardData.pages;
		const b = this.view().bounds;
		const first = Math.max(0, Math.floor(b.top / PAGE_STRIDE) - MOUNT_BUFFER);
		const last = Math.min(pages.length - 1, Math.floor(b.bottom / PAGE_STRIDE) + MOUNT_BUFFER);

		const indexById = new Map<string, number>();
		pages.forEach((p, i) => indexById.set(p.id, i));

		for (const [pageId, m] of this.mounted) {
			const idx = indexById.get(pageId);
			const keep = idx !== undefined && idx >= first && idx <= last;
			// Never unmount a page with an in-progress stroke on it.
			if (!keep && this.live?.pageId !== pageId) {
				m.group.remove();
				this.mounted.delete(pageId);
			}
		}

		for (let i = first; i <= last; i++) {
			const page = pages[i];
			if (page && !this.mounted.has(page.id)) {
				this.mounted.set(page.id, this.mountPage(i));
			}
		}
		this.updateStatus();
	}

	private mountPage(index: number): MountedPage {
		const page = this.boardData.pages[index];
		const top = this.pageTop(index);
		const rect = new paper.Rectangle(0, top, PAGE_WIDTH, PAGE_HEIGHT);

		const bg = this.makePageBackground(rect);

		const mask = new paper.Path.Rectangle(rect);
		const strokes = new paper.Group([mask]);
		strokes.clipped = true;
		for (const s of page.strokes) strokes.addChild(this.buildStrokeItem(s, page.id, top));

		const label = new paper.PointText({
			point: [PAGE_WIDTH / 2, top + PAGE_HEIGHT + 24],
			content: `${index + 1}`,
			justification: "center",
			fontSize: 18,
			fillColor: new paper.Color(1, 1, 1, 0.3),
			insert: false,
		});

		const group = new paper.Group([bg, strokes, label]);
		group.data = { pageId: page.id };
		this.pageLayer.addChild(group);
		return { group, strokes };
	}

	/**
	 * The page sheet's drop shadow (ctx.shadowBlur) is by far the most expensive
	 * thing Paper.js redraws each frame, since it has no partial/dirty-rect
	 * repaint: every pointermove during a stroke forces a full-canvas redraw of
	 * every mounted page, recomputing the blur over a large rect each time. That
	 * shows up as the pointer visibly outrunning the ink until the backlog of
	 * queued frames drains. The page chrome never changes after it's mounted, so
	 * bake it into a bitmap once and blit that (cheap) instead of re-blurring a
	 * vector shape on every frame.
	 */
	private makePageBackground(rect: paper.Rectangle): paper.Raster {
		const pad = 40; // covers shadowBlur(14) + shadowOffset(0,3) with margin
		const scale = window.devicePixelRatio || 1;
		const w = rect.width + pad * 2;
		const h = rect.height + pad * 2;

		const off = document.createElement("canvas");
		off.width = Math.ceil(w * scale);
		off.height = Math.ceil(h * scale);
		const ctx = off.getContext("2d") as CanvasRenderingContext2D;
		ctx.scale(scale, scale);
		ctx.translate(pad, pad);
		ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
		ctx.shadowBlur = 14;
		ctx.shadowOffsetY = 3;
		ctx.fillStyle = this.pageColor;
		ctx.fillRect(0, 0, rect.width, rect.height);
		ctx.shadowColor = "transparent";
		ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
		ctx.lineWidth = 1;
		ctx.strokeRect(0.5, 0.5, rect.width - 1, rect.height - 1);

		const raster = new paper.Raster(off);
		raster.size = new paper.Size(w, h);
		raster.position = rect.center;
		return raster;
	}

	private buildStrokeItem(s: Stroke, pageId: string, top: number): paper.Path {
		const p = new paper.Path(s.d);
		p.translate(new paper.Point(0, top));
		p.strokeColor = new paper.Color(s.color);
		p.strokeWidth = s.width;
		p.strokeCap = "round";
		p.strokeJoin = "round";
		p.data = { strokeId: s.id, pageId };
		p.selected = this.selectedIds.has(s.id);
		return p;
	}

	/** All stroke paths currently in the scene graph (visible pages only). */
	private *strokeItems(): IterableIterator<paper.Path> {
		for (const m of this.mounted.values()) {
			for (const child of m.strokes.children) {
				if (child.data?.strokeId) yield child as paper.Path;
			}
		}
	}

	/** Export a mounted stroke path back to page-local SVG path data. */
	private strokePathData(item: paper.Path, top: number): string {
		const clone = item.clone({ insert: false }) as paper.Path;
		clone.translate(new paper.Point(0, -top));
		const d = clone.pathData;
		clone.remove();
		return d;
	}

	private findStroke(strokeId: string): { pageIndex: number; page: Page; stroke: Stroke } | null {
		const pages = this.boardData.pages;
		for (let i = 0; i < pages.length; i++) {
			const stroke = pages[i].strokes.find((s) => s.id === strokeId);
			if (stroke) return { pageIndex: i, page: pages[i], stroke };
		}
		return null;
	}

	private removeStrokeFromData(strokeId: string): boolean {
		const loc = this.findStroke(strokeId);
		if (!loc) return false;
		loc.page.strokes = loc.page.strokes.filter((s) => s.id !== strokeId);
		return true;
	}

	// ---- Camera (paper.js View owns the transform) ----

	private clampZoom(z: number): number {
		return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
	}

	/** Event position in view (canvas CSS px) coordinates. */
	private viewPoint(e: { clientX: number; clientY: number }): paper.Point {
		const r = this.canvas.getBoundingClientRect();
		return new paper.Point(e.clientX - r.left, e.clientY - r.top);
	}

	/** Event position in document (project) coordinates. */
	private projectPoint(e: { clientX: number; clientY: number }): paper.Point {
		return this.view().viewToProject(this.viewPoint(e));
	}

	/** Zoom by `factor`, keeping the document point under `viewPt` stationary. */
	private zoomAt(viewPt: paper.Point, factor: number): void {
		const view = this.view();
		const focus = view.viewToProject(viewPt);
		view.zoom = this.clampZoom(view.zoom * factor);
		view.center = view.center.add(focus.subtract(view.viewToProject(viewPt)));
		this.updateVirtualization();
	}

	private zoomAtCenter(factor: number): void {
		const vs = this.view().viewSize;
		this.zoomAt(new paper.Point(vs.width / 2, vs.height / 2), factor);
	}

	/** "Fit" fits the current page fully in the viewport (both dimensions). */
	private zoomToFit(): void {
		const view = this.view();
		const vs = view.viewSize;
		const pad = 32;
		view.zoom = this.clampZoom(
			Math.min((vs.width - pad * 2) / PAGE_WIDTH, (vs.height - pad * 2) / PAGE_HEIGHT),
		);
		const idx = this.currentPageIndex();
		view.center = new paper.Point(PAGE_WIDTH / 2, this.pageTop(idx) + PAGE_HEIGHT / 2);
		this.updateVirtualization();
	}

	private resetView(): void {
		this.view().zoom = 1;
		this.scrollToPage(0);
	}

	/** Put `index`'s page top 24 screen px below the viewport top, centered horizontally. */
	private scrollToPage(index: number): void {
		const view = this.view();
		view.center = new paper.Point(
			PAGE_WIDTH / 2,
			this.pageTop(index) - 24 / view.zoom + view.bounds.height / 2,
		);
		this.updateVirtualization();
	}

	private gotoPage(direction: number): void {
		const idx = this.currentPageIndex();
		const target = Math.max(0, Math.min(this.boardData.pages.length - 1, idx + direction));
		this.scrollToPage(target);
	}

	private applyInitialFitIfNeeded(): void {
		if (!this.needsInitialFit || !this.paperScope) return;
		const vs = this.view().viewSize;
		if (vs.width <= 0 || vs.height <= 0) return;
		this.needsInitialFit = false;
		const pad = 24;
		this.view().zoom = this.clampZoom((vs.width - pad * 2) / PAGE_WIDTH);
		this.scrollToPage(0);
	}

	private resize(): void {
		if (!this.paperScope) return;
		const rect = this.container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		// Paper resizes the hi-DPI backing store itself.
		this.view().viewSize = new paper.Size(rect.width, rect.height);
		this.applyInitialFitIfNeeded();
		this.updateVirtualization();
	}

	private updateStatus(): void {
		if (!this.paperScope) return;
		const zoom = Math.round(this.view().zoom * 100);
		const sel = this.selectedIds.size;
		const total = this.boardData.pages.length;
		const current = Math.min(total, this.currentPageIndex() + 1);
		const strokeCount = this.boardData.pages.reduce((n, p) => n + p.strokes.length, 0);
		const parts = [
			`Page ${current}/${total}`,
			`${strokeCount} strokes`,
			`${zoom}%`,
			`${this.mounted.size}/${total} mounted`,
		];
		if (sel > 0) parts.push(`${sel} selected`);
		this.statusEl.setText(parts.join("  ·  "));
	}

	// ---- Pages ----

	private addPage(): void {
		this.pendingSnapshot = this.cloneData();
		const insertAt = this.currentPageIndex() + 1;
		this.boardData.pages.splice(insertAt, 0, { id: uid(), strokes: [] });
		this.commitChange();
		this.selectedIds.clear();
		this.resetScene(false);
		this.scheduleSave();
		this.scrollToPage(insertAt);
	}

	private deleteCurrentPage(): void {
		if (this.boardData.pages.length <= 1) {
			new Notice("Pencil: at least one page is required");
			return;
		}
		const idx = this.currentPageIndex();
		new ConfirmModal(
			this.app,
			`Delete page ${idx + 1}? Undo (Cmd/Ctrl+Z) will restore it.`,
			() => {
				this.pendingSnapshot = this.cloneData();
				this.boardData.pages.splice(idx, 1);
				this.commitChange();
				this.selectedIds.clear();
				this.resetScene(false);
				this.scheduleSave();
				this.scrollToPage(Math.min(idx, this.boardData.pages.length - 1));
			},
			"Delete page",
		).open();
	}

	// ---- Input ----

	private attachPointerHandlers(): void {
		const el = this.container;

		el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		el.addEventListener("pointermove", (e) => this.onPointerMove(e));
		el.addEventListener("pointerup", (e) => this.onPointerUp(e));
		el.addEventListener("pointercancel", (e) => this.onPointerUp(e));
		el.addEventListener("pointerleave", (e) => this.onPointerUp(e));

		el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		el.addEventListener("contextmenu", (e) => e.preventDefault());
	}

	private isPenLikeForDrawing(e: PointerEvent): boolean {
		if (e.pointerType === "pen") return true;
		if (e.pointerType === "mouse" && e.button === 0) return true;
		return false;
	}

	private onPointerDown(e: PointerEvent): void {
		(e.target as Element).setPointerCapture?.(e.pointerId);
		this.paperScope?.activate();

		const isPen = e.pointerType === "pen";
		const isTouch = e.pointerType === "touch";

		if (isPen) {
			this.penActive = true;
			this.penSeen = true;
			// Pen takes over: abandon any finger pan/pinch/stroke in progress.
			this.panStart = null;
			this.pinch = null;
			this.cancelInProgressStroke();
		}

		this.pointers.set(e.pointerId, {
			id: e.pointerId,
			type: e.pointerType,
			clientX: e.clientX,
			clientY: e.clientY,
		});

		if (isTouch) {
			const touches = [...this.pointers.values()].filter((p) => p.type === "touch");
			if (this.penActive) {
				// Apple Pencil is active; ignore finger touches (palm rejection).
				return;
			}
			if (touches.length >= 2) {
				this.beginPinch(touches[0], touches[1]);
				this.cancelInProgressStroke();
				return;
			}
			// Single finger: pan in Apple-Pencil mode or when Pan tool is selected,
			// otherwise treat it as the drawing device.
			if (this.penSeen || this.tool === "pan") {
				this.beginPan(e);
				return;
			}
		}

		if (e.pointerType === "mouse" && (e.button === 1 || e.button === 2)) {
			this.beginPan(e);
			return;
		}

		if (this.tool === "pan") {
			this.beginPan(e);
			return;
		}

		if (!this.isPenLikeForDrawing(e) && !isTouch) return;

		const pt = this.projectPoint(e);

		if (this.tool === "pencil") {
			this.beginStroke(e, pt);
		} else if (this.tool === "eraser") {
			this.pendingSnapshot = this.cloneData();
			this.eraseAt(pt);
		} else if (this.tool === "select") {
			this.beginSelection(e, pt);
		}
	}

	private onPointerMove(e: PointerEvent): void {
		const prev = this.pointers.get(e.pointerId);
		if (!prev) return;
		prev.clientX = e.clientX;
		prev.clientY = e.clientY;
		this.paperScope?.activate();

		if (this.pinch && (e.pointerId === this.pinch.ids[0] || e.pointerId === this.pinch.ids[1])) {
			this.updatePinch();
			return;
		}

		if (this.panStart) {
			const view = this.view();
			const dx = e.clientX - this.panStart.clientX;
			const dy = e.clientY - this.panStart.clientY;
			view.center = this.panStart.center.subtract(new paper.Point(dx, dy).divide(view.zoom));
			this.updateVirtualization();
			return;
		}

		if (this.live && e.pointerId === this.live.pointerId) {
			this.extendStroke(e);
			return;
		}

		if (this.tool === "eraser" && e.buttons !== 0) {
			this.eraseAt(this.projectPoint(e));
			return;
		}

		if (this.selDrag) {
			this.moveSelection(e);
			return;
		}

		if (this.marqueeStart && e.buttons !== 0) {
			this.updateMarquee(this.projectPoint(e));
		}
	}

	private onPointerUp(e: PointerEvent): void {
		const p = this.pointers.get(e.pointerId);
		if (!p) return;
		this.paperScope?.activate();

		if (this.live && e.pointerId === this.live.pointerId) {
			this.finishStroke();
		}

		this.pointers.delete(e.pointerId);

		if (e.pointerType === "pen") {
			const anyPen = [...this.pointers.values()].some((pp) => pp.type === "pen");
			if (!anyPen) this.penActive = false;
		}

		if (this.pinch) {
			const a = this.pointers.get(this.pinch.ids[0]);
			const b = this.pointers.get(this.pinch.ids[1]);
			if (!a || !b) this.pinch = null;
		}

		if (this.panStart && this.pointers.size === 0) {
			this.panStart = null;
		}

		if (this.marqueeStart && e.buttons === 0) {
			this.commitMarquee();
		}

		if (this.selDrag && this.pointers.size === 0) {
			this.endSelectionDrag();
		}

		// Any gesture that ended without committing (e.g. an eraser pass that
		// hit nothing) abandons its snapshot.
		if (!this.live && !this.selDrag) this.pendingSnapshot = null;
	}

	private beginPan(e: PointerEvent): void {
		this.panStart = {
			center: this.view().center.clone(),
			clientX: e.clientX,
			clientY: e.clientY,
		};
	}

	private beginPinch(a: ActivePointer, b: ActivePointer): void {
		const dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
		const mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
		this.pinch = {
			ids: [a.id, b.id],
			startDist: dist,
			startZoom: this.view().zoom,
			startMidProject: this.projectPoint(mid),
		};
		this.panStart = null;
	}

	private updatePinch(): void {
		if (!this.pinch) return;
		const a = this.pointers.get(this.pinch.ids[0]);
		const b = this.pointers.get(this.pinch.ids[1]);
		if (!a || !b) return;
		const view = this.view();
		const dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
		view.zoom = this.clampZoom(this.pinch.startZoom * (dist / this.pinch.startDist));
		// Keep the document point that started under the fingers' midpoint there.
		const mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
		view.center = view.center.add(this.pinch.startMidProject.subtract(this.projectPoint(mid)));
		this.updateVirtualization();
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		this.paperScope?.activate();
		if (e.ctrlKey || e.metaKey) {
			this.zoomAt(this.viewPoint(e), Math.exp(-e.deltaY * 0.002));
		} else {
			const view = this.view();
			view.center = view.center.add(new paper.Point(e.deltaX, e.deltaY).divide(view.zoom));
			this.updateVirtualization();
		}
	}

	// ---- Drawing ----

	private pressureFor(e: PointerEvent): number {
		// 0.5 yields nominal thickness. Only vary by pressure for a pen when the
		// user has the pressure effect enabled.
		if (e.pointerType === "pen" && this.plugin.settings.pressureEnabled) {
			// Some browsers report 0 pressure for hover events; clamp away from 0.
			return Math.max(0.05, Math.min(1, e.pressure || 0.5));
		}
		return 0.5;
	}

	private liveWidth(): number {
		if (!this.live) return this.size;
		const avg = this.live.pressures.reduce((s, v) => s + v, 0) / this.live.pressures.length;
		return Math.max(0.5, this.size * 2 * avg);
	}

	private beginStroke(e: PointerEvent, pt: paper.Point): void {
		if (this.live) return;
		const pageIndex = this.pageIndexAt(pt);
		if (pageIndex === null) return; // started in the margin/gap between pages
		const page = this.boardData.pages[pageIndex];
		const m = this.mounted.get(page.id);
		if (!m) return; // a page under the pointer is always mounted

		const path = new paper.Path();
		path.strokeColor = new paper.Color(this.color);
		path.strokeWidth = this.size;
		path.strokeCap = "round";
		path.strokeJoin = "round";
		m.strokes.addChild(path);
		path.add(pt);

		this.pendingSnapshot = this.cloneData();
		this.live = { path, pageId: page.id, pointerId: e.pointerId, pressures: [this.pressureFor(e)] };
		path.strokeWidth = this.liveWidth();
	}

	private extendStroke(e: PointerEvent): void {
		if (!this.live) return;
		const pt = this.projectPoint(e);
		const last = this.live.path.lastSegment?.point;
		if (last && pt.subtract(last).length < 0.5 / this.view().zoom) return;
		this.live.path.add(pt);
		this.live.pressures.push(this.pressureFor(e));
		this.live.path.strokeWidth = this.liveWidth();
	}

	private finishStroke(): void {
		if (!this.live) return;
		const { path, pageId } = this.live;
		const width = this.liveWidth();
		this.live = null;

		const loc = this.boardData.pages.findIndex((p) => p.id === pageId);
		if (loc === -1 || path.segments.length === 0) {
			path.remove();
			this.pendingSnapshot = null;
			return;
		}

		if (path.segments.length === 1) {
			// A zero-length path renders nothing even with round caps; make dots visible.
			path.add(path.firstSegment.point.add(new paper.Point(0.01, 0)));
		} else {
			// Paper fits smooth curves through the samples and drops redundant
			// points; tolerance is in document units, so scale by zoom to keep
			// the on-screen fidelity constant.
			path.simplify(2 / this.view().zoom);
		}
		path.strokeWidth = width;

		const stroke: Stroke = {
			id: uid(),
			color: this.color,
			width,
			d: this.strokePathData(path, this.pageTop(loc)),
		};
		path.data = { strokeId: stroke.id, pageId };
		this.commitChange();
		this.boardData.pages[loc].strokes.push(stroke);
		this.scheduleSave();
	}

	private cancelInProgressStroke(): void {
		if (!this.live) return;
		this.live.path.remove();
		this.live = null;
		this.pendingSnapshot = null;
	}

	// ---- Eraser ----

	private eraseAt(pt: paper.Point): void {
		if (!this.paperScope) return;
		const hits = this.paperScope.project.hitTestAll(pt, {
			stroke: true,
			fill: false,
			tolerance: this.eraseRadius / this.view().zoom,
			match: (r: paper.HitResult) => !!r.item?.data?.strokeId,
		});
		if (!hits || hits.length === 0) return;
		let removed = false;
		for (const hit of hits) {
			const id = hit.item.data.strokeId as string;
			if (this.removeStrokeFromData(id)) {
				hit.item.remove();
				this.selectedIds.delete(id);
				removed = true;
			}
		}
		if (removed) {
			this.commitChange();
			this.scheduleSave();
			this.updateStatus();
		}
	}

	// ---- Selection ----

	private clearSelection(): void {
		for (const item of this.strokeItems()) item.selected = false;
		this.selectedIds.clear();
	}

	private beginSelection(e: PointerEvent, pt: paper.Point): void {
		if (!this.paperScope) return;
		const hit = this.paperScope.project.hitTest(pt, {
			stroke: true,
			fill: false,
			tolerance: 4 / this.view().zoom,
			match: (r: paper.HitResult) => !!r.item?.data?.strokeId,
		});
		if (hit?.item) {
			const id = hit.item.data.strokeId as string;
			if (!this.selectedIds.has(id)) {
				this.clearSelection();
				this.selectedIds.add(id);
				hit.item.selected = true;
			}
			this.pendingSnapshot = this.cloneData();
			this.selDrag = { last: pt, moved: false };
			this.updateStatus();
			return;
		}
		this.clearSelection();
		this.marqueeStart = pt;
		this.updateStatus();
	}

	private updateMarquee(pt: paper.Point): void {
		if (!this.marqueeStart) return;
		this.marqueeItem?.remove();
		const zoom = this.view().zoom;
		const rect = new paper.Path.Rectangle(new paper.Rectangle(this.marqueeStart, pt));
		rect.strokeColor = new paper.Color(91 / 255, 157 / 255, 1, 0.8);
		rect.fillColor = new paper.Color(91 / 255, 157 / 255, 1, 0.12);
		rect.strokeWidth = 1 / zoom;
		rect.dashArray = [4 / zoom, 4 / zoom];
		this.overlayLayer.addChild(rect);
		this.marqueeItem = rect;
	}

	private commitMarquee(): void {
		this.marqueeStart = null;
		const item = this.marqueeItem;
		if (!item) return;
		this.marqueeItem = null;
		const bounds = item.bounds.clone();
		item.remove();
		const minSize = 2 / this.view().zoom;
		if (bounds.width > minSize && bounds.height > minSize) {
			for (const si of this.strokeItems()) {
				if (si.bounds.intersects(bounds)) {
					si.selected = true;
					this.selectedIds.add(si.data.strokeId as string);
				}
			}
		}
		this.updateStatus();
	}

	private moveSelection(e: PointerEvent): void {
		if (!this.selDrag) return;
		const pt = this.projectPoint(e);
		const delta = pt.subtract(this.selDrag.last);
		if (delta.length === 0) return;
		for (const si of this.strokeItems()) {
			if (this.selectedIds.has(si.data.strokeId as string)) si.translate(delta);
		}
		this.selDrag.last = pt;
		this.selDrag.moved = true;
	}

	private endSelectionDrag(): void {
		const drag = this.selDrag;
		this.selDrag = null;
		if (!drag) return;
		if (!drag.moved) {
			this.pendingSnapshot = null;
			return;
		}
		// Write the moved geometry back into the data model. Strokes stay on
		// their original page (and stay clipped to it), matching page semantics.
		for (const si of this.strokeItems()) {
			const id = si.data.strokeId as string;
			if (!this.selectedIds.has(id)) continue;
			const loc = this.findStroke(id);
			if (loc) loc.stroke.d = this.strokePathData(si, this.pageTop(loc.pageIndex));
		}
		this.commitChange();
		this.scheduleSave();
	}

	private deleteSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.pendingSnapshot = this.cloneData();
		for (const page of this.boardData.pages) {
			page.strokes = page.strokes.filter((s) => !this.selectedIds.has(s.id));
		}
		for (const si of [...this.strokeItems()]) {
			if (this.selectedIds.has(si.data.strokeId as string)) si.remove();
		}
		this.selectedIds.clear();
		this.commitChange();
		this.scheduleSave();
		this.updateStatus();
	}

	private clearAllPrompt(): void {
		const hasContent = this.boardData.pages.some((p) => p.strokes.length > 0);
		if (!hasContent) return;
		new ConfirmModal(
			this.app,
			"Clear every stroke from all pages? Pages themselves are kept.",
			() => {
				this.pendingSnapshot = this.cloneData();
				for (const page of this.boardData.pages) page.strokes = [];
				this.commitChange();
				this.selectedIds.clear();
				this.resetScene(false);
				this.scheduleSave();
			},
			"Clear",
		).open();
	}

	// ---- Keyboard ----

	private handleKey(e: KeyboardEvent): void {
		if (!this.isActiveLeaf()) return;
		if (this.isEditableTarget(e.target)) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
			e.preventDefault();
			this.undo();
		} else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
			e.preventDefault();
			this.redo();
		} else if (!mod && (e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size > 0) {
			e.preventDefault();
			this.deleteSelection();
		} else if (!mod && e.key.toLowerCase() === "p") {
			this.tool = "pencil";
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "e") {
			this.tool = "eraser";
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "v") {
			this.tool = "select";
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "h") {
			this.tool = "pan";
			this.refreshToolbarState();
		} else if (!mod && (e.key === "[" || e.key === "PageUp")) {
			e.preventDefault();
			this.gotoPage(-1);
		} else if (!mod && (e.key === "]" || e.key === "PageDown")) {
			e.preventDefault();
			this.gotoPage(1);
		}
	}

	private isActiveLeaf(): boolean {
		return this.app.workspace.getActiveViewOfType(PencilWhiteboardView) === this;
	}

	private isEditableTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		if (el.isContentEditable) return true;
		return false;
	}

	// ---- Undo / redo / persistence ----

	private cloneData(): WhiteboardData {
		return JSON.parse(JSON.stringify(this.boardData)) as WhiteboardData;
	}

	/** Push the pre-gesture snapshot (if any) onto the undo stack. */
	private commitChange(): void {
		if (!this.pendingSnapshot) return;
		this.undoStack.push(this.pendingSnapshot);
		if (this.undoStack.length > 200) this.undoStack.shift();
		this.redoStack = [];
		this.pendingSnapshot = null;
	}

	private undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.cloneData());
		this.boardData = prev;
		this.selectedIds.clear();
		this.pendingSnapshot = null;
		this.resetScene(false);
		this.scheduleSave();
	}

	private redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.cloneData());
		this.boardData = next;
		this.selectedIds.clear();
		this.pendingSnapshot = null;
		this.resetScene(false);
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.paperScope) {
			const view = this.view();
			this.boardData.view = { cx: view.center.x, cy: view.center.y, zoom: view.zoom };
		}
		try {
			// TextFileView.requestSave is a debounced property that picks up
			// getViewData() and writes it to the backing file.
			this.requestSave();
		} catch (e) {
			console.error("Pencil: failed to save", e);
			new Notice("Pencil: failed to save whiteboard");
		}
	}
}

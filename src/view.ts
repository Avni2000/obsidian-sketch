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
	/**
	 * Clipped group holding one paper.Path per committed stroke. In raster
	 * mode the group sits at opacity 0: paper skips painting fully
	 * transparent items but still hit-tests them and draws their selection
	 * highlights, so these paths serve as the interactive proxies for the
	 * pixels in `inkRaster`.
	 */
	strokes: paper.Group;
	/** Clipped group the in-progress stroke is drawn into (always visible vectors). */
	liveInk: paper.Group;
	/** Bitmap of all committed strokes; what actually paints in raster mode. */
	inkRaster: paper.Raster;
	/** Backing store of `inkRaster`; committed strokes are stamped into it incrementally. */
	inkCanvas: HTMLCanvasElement;
	/** Bitmap pixels per document unit at last (re-)raster. */
	rasterScale: number;
	/** Committed strokes changed while the bitmap wasn't showing; re-render before reuse. */
	rasterDirty: boolean;
	/** An active gesture (erase, selection drag) needs live vector feedback. */
	forceVector: boolean;
	index: number;
	top: number;
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

/**
 * Committed ink is cached per page as a bitmap so panning/zooming blits a few
 * textures instead of re-stroking every vector path on every frame. The
 * bitmap is rendered at `devicePixelRatio * zoom` document-units-to-pixels,
 * clamped to keep memory bounded (a full page at scale 2.5 is ~21 MB).
 */
const RASTER_MIN_SCALE = 0.5;
const RASTER_MAX_SCALE = 2.5;
/**
 * Past this upscale factor the cached bitmap would look visibly soft, so the
 * page falls back to live vector rendering (always crisp, costlier per frame
 * — but at that zoom only a fraction of one page is on screen).
 */
const VECTOR_FALLBACK_STRETCH = 1.5;
/** Re-rasterize once zoom settles if cached resolution drifted this much. */
const RASTER_DRIFT = 0.25;
const ZOOM_SETTLE_MS = 180;

/**
 * Pan/zoom gestures never repaint the canvas: the canvas is rendered
 * CANVAS_MARGIN px larger than the viewport on every side and gets moved with
 * a compositor-only CSS transform while the gesture runs. The transform is
 * folded back into paper's view ("re-anchored", one synchronous repaint) when
 * it approaches the margin, scales past the blur thresholds below, or the
 * gesture ends. This keeps pans at compositor frame rate even where Electron
 * runs 2d canvas without GPU acceleration.
 */
const CANVAS_MARGIN = 256;
/** Wheel streams have no end event; commit after this much idle. */
const WHEEL_COMMIT_MS = 100;
const GESTURE_SCALE_MIN = 0.85;
const GESTURE_SCALE_MAX = 1.3;

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
	/** Last mount range; lets per-pointermove virtualization exit in O(1) when nothing changed. */
	private mountedRange: { first: number; last: number; count: number } | null = null;
	/** Path2D per stroke id for fast bitmap (re-)rendering. */
	private path2ds: Map<string, { d: string; path: Path2D }> = new Map();
	private zoomSettleTimer: number | null = null;
	private statusRaf = 0;
	private lastStatusText = "";
	/** True while an erase / selection-drag gesture has pages in forced vector mode. */
	private vectorGesture = false;
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
		pressureSum: number;
		pressureCount: number;
	} = null;

	private pinch: null | {
		ids: [number, number];
		lastDist: number;
		lastMidX: number;
		lastMidY: number;
	} = null;

	private panStart: null | {
		lastX: number;
		lastY: number;
	} = null;

	/** Pending compositor-side gesture transform (CSS px, origin at canvas top-left). */
	private gestureTx = 0;
	private gestureTy = 0;
	private gestureScale = 1;
	private wheelCommitTimer: number | null = null;

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
		this.path2ds.clear();
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

		// Offset the oversized canvas so its margin hangs off every edge of the
		// (overflow: hidden) wrap; see CANVAS_MARGIN.
		this.canvas.style.left = `-${CANVAS_MARGIN}px`;
		this.canvas.style.top = `-${CANVAS_MARGIN}px`;

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
		if (this.zoomSettleTimer !== null) {
			window.clearTimeout(this.zoomSettleTimer);
			this.zoomSettleTimer = null;
		}
		if (this.wheelCommitTimer !== null) {
			window.clearTimeout(this.wheelCommitTimer);
			this.wheelCommitTimer = null;
		}
		if (this.statusRaf) {
			cancelAnimationFrame(this.statusRaf);
			this.statusRaf = 0;
		}
		this.path2ds.clear();
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
		this.mountedRange = null;
		this.vectorGesture = false;

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
	 * as JSON until scrolled back into view. Runs on every pan/zoom event, so
	 * the common no-change case must exit without touching the scene or DOM.
	 */
	private updateVirtualization(): void {
		if (!this.paperScope) return;
		const pages = this.boardData.pages;
		const b = this.view().bounds;
		const first = Math.max(0, Math.floor(b.top / PAGE_STRIDE) - MOUNT_BUFFER);
		const last = Math.min(pages.length - 1, Math.floor(b.bottom / PAGE_STRIDE) + MOUNT_BUFFER);

		const r = this.mountedRange;
		if (r && r.first === first && r.last === last && r.count === pages.length) {
			this.scheduleStatusUpdate();
			return;
		}
		this.mountedRange = { first, last, count: pages.length };
		this.paperScope.activate();

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
		this.scheduleStatusUpdate();
	}

	private mountPage(index: number): MountedPage {
		const page = this.boardData.pages[index];
		const top = this.pageTop(index);
		const rect = new paper.Rectangle(0, top, PAGE_WIDTH, PAGE_HEIGHT);

		const bg = this.makePageBackground(rect);

		const rasterScale = this.desiredRasterScale();
		const inkCanvas = this.renderInkCanvas(page, rasterScale);
		const inkRaster = this.makeInkRaster(inkCanvas, rasterScale, top);

		const mask = new paper.Path.Rectangle(rect);
		const strokes = new paper.Group([mask]);
		strokes.clipped = true;
		strokes.opacity = 0;
		for (const s of page.strokes) strokes.addChild(this.buildStrokeItem(s, page.id, top));

		const liveMask = new paper.Path.Rectangle(rect);
		const liveInk = new paper.Group([liveMask]);
		liveInk.clipped = true;

		const label = new paper.PointText({
			point: [PAGE_WIDTH / 2, top + PAGE_HEIGHT + 24],
			content: `${index + 1}`,
			justification: "center",
			fontSize: 18,
			fillColor: new paper.Color(1, 1, 1, 0.3),
			insert: false,
		});

		const group = new paper.Group([bg, inkRaster, strokes, liveInk, label]);
		group.data = { pageId: page.id };
		this.pageLayer.addChild(group);
		const m: MountedPage = {
			group,
			strokes,
			liveInk,
			inkRaster,
			inkCanvas,
			rasterScale,
			rasterDirty: false,
			forceVector: this.vectorGesture,
			index,
			top,
		};
		this.applyInkMode(m);
		return m;
	}

	// ---- Committed-ink bitmap cache ----

	private dpr(): number {
		return window.devicePixelRatio || 1;
	}

	private desiredRasterScale(): number {
		return Math.min(RASTER_MAX_SCALE, Math.max(RASTER_MIN_SCALE, this.dpr() * this.view().zoom));
	}

	private strokePath2D(s: Stroke): Path2D {
		const hit = this.path2ds.get(s.id);
		if (hit && hit.d === s.d) return hit.path;
		const path = new Path2D(s.d);
		this.path2ds.set(s.id, { d: s.d, path });
		return path;
	}

	/** Stroke a single committed stroke into a page-local 2d context. */
	private paintStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
		ctx.strokeStyle = s.color;
		ctx.lineWidth = s.width;
		ctx.stroke(this.strokePath2D(s));
	}

	/** Render all of a page's committed strokes into a fresh bitmap at `scale` px per doc unit. */
	private renderInkCanvas(page: Page, scale: number): HTMLCanvasElement {
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.ceil(PAGE_WIDTH * scale));
		canvas.height = Math.max(1, Math.ceil(PAGE_HEIGHT * scale));
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (const s of page.strokes) this.paintStroke(ctx, s);
		return canvas;
	}

	/** Wrap an ink bitmap in a paper.Raster positioned over the page sheet. */
	private makeInkRaster(canvas: HTMLCanvasElement, scale: number, top: number): paper.Raster {
		const raster = new paper.Raster(canvas);
		// Scale via the item matrix (never Raster#size, whose setter resamples
		// the backing store) so the hi-dpi bitmap keeps its full resolution.
		raster.scale(1 / scale);
		raster.position = new paper.Point(canvas.width / (2 * scale), top + canvas.height / (2 * scale));
		return raster;
	}

	/** Draw one newly committed stroke into the existing bitmap (no full re-render). */
	private stampStroke(m: MountedPage, s: Stroke): void {
		const ctx = m.inkCanvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.save();
		ctx.setTransform(m.rasterScale, 0, 0, m.rasterScale, 0, 0);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		this.paintStroke(ctx, s);
		ctx.restore();
	}

	/** Rebuild a mounted page's ink bitmap from data at the current desired scale. */
	private rerasterPage(m: MountedPage): void {
		const page = this.boardData.pages[m.index];
		if (!page || page.id !== m.group.data.pageId) return;
		const scale = this.desiredRasterScale();
		const canvas = this.renderInkCanvas(page, scale);
		const raster = this.makeInkRaster(canvas, scale, m.top);
		raster.visible = m.inkRaster.visible;
		const z = m.inkRaster.index;
		m.inkRaster.remove();
		m.group.insertChild(z, raster);
		m.inkRaster = raster;
		m.inkCanvas = canvas;
		m.rasterScale = scale;
		m.rasterDirty = false;
	}

	/** True when the cached bitmap can't serve the current zoom / gesture. */
	private inkVectorMode(m: MountedPage): boolean {
		return m.forceVector || this.dpr() * this.view().zoom > m.rasterScale * VECTOR_FALLBACK_STRETCH;
	}

	/** Show either the bitmap or the vector strokes, re-rendering a stale bitmap first. */
	private applyInkMode(m: MountedPage): void {
		const vector = this.inkVectorMode(m);
		if (!vector && m.rasterDirty) this.rerasterPage(m);
		const strokesOpacity = vector ? 1 : 0;
		if (m.strokes.opacity !== strokesOpacity) m.strokes.opacity = strokesOpacity;
		if (m.inkRaster.visible !== !vector) m.inkRaster.visible = !vector;
	}

	/** Erase / selection-drag gestures need per-frame vector feedback on every mounted page. */
	private setForceVector(on: boolean): void {
		if (this.vectorGesture === on) return;
		this.vectorGesture = on;
		for (const m of this.mounted.values()) {
			m.forceVector = on;
			this.applyInkMode(m);
		}
	}

	/** Re-render any bitmap invalidated while it wasn't the one showing. */
	private flushDirtyRasters(): void {
		for (const m of this.mounted.values()) {
			if (m.rasterDirty) this.applyInkMode(m);
		}
	}

	/** Called on every zoom change: swap ink modes now, re-rasterize after zoom settles. */
	private onZoomChanged(): void {
		for (const m of this.mounted.values()) this.applyInkMode(m);
		if (this.zoomSettleTimer !== null) window.clearTimeout(this.zoomSettleTimer);
		this.zoomSettleTimer = window.setTimeout(() => {
			this.zoomSettleTimer = null;
			this.rescaleRasters();
		}, ZOOM_SETTLE_MS);
	}

	private rescaleRasters(): void {
		if (!this.paperScope) return;
		this.paperScope.activate();
		const desired = this.desiredRasterScale();
		for (const m of this.mounted.values()) {
			if (this.inkVectorMode(m)) continue;
			if (Math.abs(desired / m.rasterScale - 1) > RASTER_DRIFT) {
				// One page per pass: re-rendering every mounted bitmap in one
				// go would hitch right as the user resumes interacting.
				this.rerasterPage(m);
				this.zoomSettleTimer = window.setTimeout(() => {
					this.zoomSettleTimer = null;
					this.rescaleRasters();
				}, 32);
				return;
			}
		}
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

		// Scale via the item matrix, not Raster#size (whose setter resamples the
		// backing store back down and would throw away the hi-dpi rendering).
		const raster = new paper.Raster(off);
		raster.scale(1 / scale);
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
		// The rect reflects any pending gesture transform; normalize back to
		// untransformed canvas pixels so viewToProject stays valid mid-gesture.
		const scale = this.canvas.offsetWidth > 0 ? r.width / this.canvas.offsetWidth : 1;
		return new paper.Point((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
	}

	/** Event position in document (project) coordinates. */
	private projectPoint(e: { clientX: number; clientY: number }): paper.Point {
		return this.view().viewToProject(this.viewPoint(e));
	}

	// ---- Gesture transform (compositor-side pan/zoom) ----

	private hasGestureTransform(): boolean {
		return this.gestureTx !== 0 || this.gestureTy !== 0 || this.gestureScale !== 1;
	}

	private applyGestureTransform(): void {
		this.canvas.style.transform = this.hasGestureTransform()
			? `translate(${this.gestureTx}px, ${this.gestureTy}px) scale(${this.gestureScale})`
			: "";
	}

	private panGestureBy(dx: number, dy: number): void {
		this.gestureTx += dx;
		this.gestureTy += dy;
		this.applyGestureTransform();
		this.maybeCommitGesture();
	}

	/** Scale the pending transform by `factor`, pinned at container point (px, py). */
	private zoomGestureAt(px: number, py: number, factor: number): void {
		const committed = this.view().zoom;
		const target = this.clampZoom(committed * this.gestureScale * factor);
		const f = target / (committed * this.gestureScale);
		if (f === 1) return;
		// Keep the content under (px, py) fixed while the canvas — whose
		// top-left sits at (-MARGIN, -MARGIN) in container space — scales by f.
		this.gestureTx = (1 - f) * (px + CANVAS_MARGIN) + f * this.gestureTx;
		this.gestureTy = (1 - f) * (py + CANVAS_MARGIN) + f * this.gestureTy;
		this.gestureScale *= f;
		this.applyGestureTransform();
		this.maybeCommitGesture();
	}

	/** Re-anchor before the transform slides past the margin or blurs too much. */
	private maybeCommitGesture(): void {
		const pan = CANVAS_MARGIN * 0.75;
		if (
			Math.abs(this.gestureTx) > pan ||
			Math.abs(this.gestureTy) > pan ||
			this.gestureScale < GESTURE_SCALE_MIN ||
			this.gestureScale > GESTURE_SCALE_MAX
		) {
			this.commitGestureTransform();
		}
	}

	/** Fold the pending CSS transform into paper's view and repaint synchronously. */
	private commitGestureTransform(): void {
		if (this.wheelCommitTimer !== null) {
			window.clearTimeout(this.wheelCommitTimer);
			this.wheelCommitTimer = null;
		}
		if (!this.hasGestureTransform() || !this.paperScope) return;
		this.paperScope.activate();
		const view = this.view();
		const s = this.gestureScale;
		// The document point currently displayed at the container center must
		// still be there once the transform clears; the canvas is centered on
		// the container, so that point becomes the new view center.
		const rect = this.container.getBoundingClientRect();
		const qx = (rect.width / 2 + CANVAS_MARGIN - this.gestureTx) / s;
		const qy = (rect.height / 2 + CANVAS_MARGIN - this.gestureTy) / s;
		const center = view.viewToProject(new paper.Point(qx, qy));
		this.gestureTx = 0;
		this.gestureTy = 0;
		this.gestureScale = 1;
		view.zoom = this.clampZoom(view.zoom * s);
		view.center = center;
		// Repaint the backing store in the same JS turn as clearing the CSS
		// transform so the compositor swaps both atomically (no flash).
		view.update();
		this.applyGestureTransform();
		if (s !== 1) this.onZoomChanged();
		this.updateVirtualization();
	}

	/** Zoom by `factor`, keeping the document point under `viewPt` stationary. */
	private zoomAt(viewPt: paper.Point, factor: number): void {
		const view = this.view();
		const focus = view.viewToProject(viewPt);
		view.zoom = this.clampZoom(view.zoom * factor);
		view.center = view.center.add(focus.subtract(view.viewToProject(viewPt)));
		this.onZoomChanged();
		this.updateVirtualization();
	}

	private zoomAtCenter(factor: number): void {
		this.commitGestureTransform();
		const vs = this.view().viewSize;
		this.zoomAt(new paper.Point(vs.width / 2, vs.height / 2), factor);
	}

	/** "Fit" fits the current page fully in the viewport (both dimensions). */
	private zoomToFit(): void {
		this.commitGestureTransform();
		const view = this.view();
		const vs = view.viewSize;
		const pad = 32;
		// viewSize includes the off-screen margins; fit to the visible part.
		const availW = vs.width - CANVAS_MARGIN * 2 - pad * 2;
		const availH = vs.height - CANVAS_MARGIN * 2 - pad * 2;
		view.zoom = this.clampZoom(Math.min(availW / PAGE_WIDTH, availH / PAGE_HEIGHT));
		const idx = this.currentPageIndex();
		view.center = new paper.Point(PAGE_WIDTH / 2, this.pageTop(idx) + PAGE_HEIGHT / 2);
		this.onZoomChanged();
		this.updateVirtualization();
	}

	private resetView(): void {
		this.commitGestureTransform();
		this.view().zoom = 1;
		this.onZoomChanged();
		this.scrollToPage(0);
	}

	/** Put `index`'s page top 24 screen px below the viewport top, centered horizontally. */
	private scrollToPage(index: number): void {
		this.commitGestureTransform();
		const view = this.view();
		// view.bounds spans the oversized canvas; the visible top edge sits
		// CANVAS_MARGIN below the canvas top.
		view.center = new paper.Point(
			PAGE_WIDTH / 2,
			this.pageTop(index) - (24 + CANVAS_MARGIN) / view.zoom + view.bounds.height / 2,
		);
		this.updateVirtualization();
	}

	private gotoPage(direction: number): void {
		this.commitGestureTransform();
		const idx = this.currentPageIndex();
		const target = Math.max(0, Math.min(this.boardData.pages.length - 1, idx + direction));
		this.scrollToPage(target);
	}

	private applyInitialFitIfNeeded(): void {
		if (!this.needsInitialFit || !this.paperScope) return;
		const vs = this.view().viewSize;
		const availW = vs.width - CANVAS_MARGIN * 2;
		if (availW <= 0 || vs.height - CANVAS_MARGIN * 2 <= 0) return;
		this.needsInitialFit = false;
		const pad = 24;
		this.view().zoom = this.clampZoom((availW - pad * 2) / PAGE_WIDTH);
		this.onZoomChanged();
		this.scrollToPage(0);
	}

	private resize(): void {
		if (!this.paperScope) return;
		const rect = this.container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		this.commitGestureTransform();
		const w = rect.width + CANVAS_MARGIN * 2;
		const h = rect.height + CANVAS_MARGIN * 2;
		// Paper resizes the hi-DPI backing store itself.
		this.view().viewSize = new paper.Size(w, h);
		// Paper only writes the element's CSS size when pixelRatio != 1; pin
		// it so layout matches the oversized backing store on 1x displays too.
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.applyInitialFitIfNeeded();
		this.updateVirtualization();
	}

	/** Status text touches the DOM; coalesce to one write per frame, and only when it changed. */
	private scheduleStatusUpdate(): void {
		if (this.statusRaf) return;
		this.statusRaf = requestAnimationFrame(() => {
			this.statusRaf = 0;
			this.updateStatus();
		});
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
		const text = parts.join("  ·  ");
		if (text !== this.lastStatusText) {
			this.lastStatusText = text;
			this.statusEl.setText(text);
		}
	}

	// ---- Pages ----

	private addPage(): void {
		this.commitGestureTransform();
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
		this.commitGestureTransform();
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
		// A wheel/trackpad gesture may still be pending as a CSS transform;
		// anchor it so event->document mapping and drawing start from a clean view.
		this.commitGestureTransform();

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
			// Erasing edits the (invisible) hit-test copies; show vectors for
			// the duration of the gesture so strokes vanish under the pointer,
			// then re-rasterize the dirtied pages once on release.
			this.setForceVector(true);
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
			this.panGestureBy(e.clientX - this.panStart.lastX, e.clientY - this.panStart.lastY);
			this.panStart.lastX = e.clientX;
			this.panStart.lastY = e.clientY;
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
			if (!a || !b) {
				this.pinch = null;
				this.commitGestureTransform();
			}
		}

		if (this.panStart && this.pointers.size === 0) {
			this.panStart = null;
			this.commitGestureTransform();
		}

		if (this.marqueeStart && e.buttons === 0) {
			this.commitMarquee();
		}

		if (this.selDrag && this.pointers.size === 0) {
			this.endSelectionDrag();
		}

		// Gesture over: swap dirtied pages back to their bitmaps. The flush
		// also covers pages left dirty when a mid-gesture scene rebuild
		// (e.g. undo) already cleared the vector-gesture flag.
		if (!this.selDrag && this.pointers.size === 0) {
			this.setForceVector(false);
			this.flushDirtyRasters();
		}

		// Any gesture that ended without committing (e.g. an eraser pass that
		// hit nothing) abandons its snapshot.
		if (!this.live && !this.selDrag) this.pendingSnapshot = null;
	}

	private beginPan(e: PointerEvent): void {
		this.panStart = { lastX: e.clientX, lastY: e.clientY };
	}

	private beginPinch(a: ActivePointer, b: ActivePointer): void {
		const dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
		this.pinch = {
			ids: [a.id, b.id],
			lastDist: dist,
			lastMidX: (a.clientX + b.clientX) / 2,
			lastMidY: (a.clientY + b.clientY) / 2,
		};
		this.panStart = null;
	}

	private updatePinch(): void {
		if (!this.pinch) return;
		const a = this.pointers.get(this.pinch.ids[0]);
		const b = this.pointers.get(this.pinch.ids[1]);
		if (!a || !b) return;
		const dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
		const midX = (a.clientX + b.clientX) / 2;
		const midY = (a.clientY + b.clientY) / 2;
		// Incremental: scale around the midpoint, then follow its drift. All
		// compositor-side; the view is only touched when the transform commits.
		const crect = this.container.getBoundingClientRect();
		this.zoomGestureAt(midX - crect.left, midY - crect.top, dist / this.pinch.lastDist);
		this.panGestureBy(midX - this.pinch.lastMidX, midY - this.pinch.lastMidY);
		this.pinch.lastDist = dist;
		this.pinch.lastMidX = midX;
		this.pinch.lastMidY = midY;
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			const crect = this.container.getBoundingClientRect();
			this.zoomGestureAt(e.clientX - crect.left, e.clientY - crect.top, Math.exp(-e.deltaY * 0.002));
		} else {
			this.panGestureBy(-e.deltaX, -e.deltaY);
		}
		// Wheel streams have no end event; anchor after a short idle.
		if (this.wheelCommitTimer !== null) window.clearTimeout(this.wheelCommitTimer);
		this.wheelCommitTimer = window.setTimeout(() => {
			this.wheelCommitTimer = null;
			this.commitGestureTransform();
		}, WHEEL_COMMIT_MS);
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
		if (!this.live || this.live.pressureCount === 0) return this.size;
		const avg = this.live.pressureSum / this.live.pressureCount;
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
		m.liveInk.addChild(path);
		path.add(pt);

		this.pendingSnapshot = this.cloneData();
		const p = this.pressureFor(e);
		this.live = { path, pageId: page.id, pointerId: e.pointerId, pressureSum: p, pressureCount: 1 };
		path.strokeWidth = this.liveWidth();
	}

	private extendStroke(e: PointerEvent): void {
		if (!this.live) return;
		const minDist = 0.5 / this.view().zoom;
		// Pointer events arrive coalesced (the browser batches raw 120–240 Hz
		// samples per animation frame); unpack them so fast pen movement keeps
		// its full curvature instead of getting chorded between frames.
		const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		for (const ce of events.length > 0 ? events : [e]) {
			const pt = this.projectPoint(ce);
			const last = this.live.path.lastSegment?.point;
			if (last && pt.subtract(last).length < minDist) continue;
			this.live.path.add(pt);
			this.live.pressureSum += this.pressureFor(ce as PointerEvent);
			this.live.pressureCount += 1;
		}
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

		// Commit the pixels: stamp into the page bitmap and reparent the path
		// from the live group into the hidden hit-test group.
		const m = this.mounted.get(pageId);
		if (m) {
			m.strokes.addChild(path);
			if (this.inkVectorMode(m)) m.rasterDirty = true;
			else this.stampStroke(m, stroke);
		} else {
			path.remove();
		}
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
				const m = this.mounted.get(hit.item.data.pageId as string);
				if (m) m.rasterDirty = true;
				hit.item.remove();
				this.selectedIds.delete(id);
				removed = true;
			}
		}
		if (removed) {
			this.commitChange();
			this.scheduleSave();
			this.scheduleStatusUpdate();
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
			// The dragged strokes live in the (invisible) hit-test copies;
			// show vectors so the move is visible while it happens.
			this.setForceVector(true);
			this.scheduleStatusUpdate();
			return;
		}
		this.clearSelection();
		this.marqueeStart = pt;
		this.scheduleStatusUpdate();
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
		this.scheduleStatusUpdate();
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
			if (loc) {
				loc.stroke.d = this.strokePathData(si, this.pageTop(loc.pageIndex));
				const m = this.mounted.get(loc.page.id);
				if (m) m.rasterDirty = true;
			}
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
			if (this.selectedIds.has(si.data.strokeId as string)) {
				const m = this.mounted.get(si.data.pageId as string);
				if (m) m.rasterDirty = true;
				si.remove();
			}
		}
		this.flushDirtyRasters();
		this.selectedIds.clear();
		this.commitChange();
		this.scheduleSave();
		this.scheduleStatusUpdate();
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

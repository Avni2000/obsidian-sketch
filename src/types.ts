export interface Stroke {
	id: string;
	/** Hex color string like "#ffffff". */
	color: string;
	/** Uniform stroke width in page units. */
	width: number;
	/** SVG path data (paper.js Path#pathData) in the owning page's local coordinate space. */
	d: string;
}

export interface Page {
	id: string;
	strokes: Stroke[];
}

export interface ViewState {
	/** Camera center in document space (paper.js View#center). */
	cx: number;
	cy: number;
	/** Camera zoom (paper.js View#zoom). */
	zoom: number;
}

export interface WhiteboardData {
	version: 3;
	view?: ViewState;
	pages: Page[];
}

export function uid(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** A fresh single-page document. Always returns a new object/array instance. */
export function emptyData(): WhiteboardData {
	return { version: 3, pages: [{ id: uid(), strokes: [] }] };
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && isFinite(v) ? v : fallback;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

interface LegacyPoint {
	x: number;
	y: number;
	/** Pressure 0..1 (0.5 = nominal thickness). */
	p?: number;
}

/**
 * Accept either a v3 stroke ({ d, width }) or a legacy v1/v2 stroke
 * ({ points, size }). Legacy point polylines convert directly to SVG path
 * data; the old per-segment pressure thickness collapses to one uniform
 * width scaled by the stroke's average pressure (nominal pressure 0.5 keeps
 * the original size).
 */
function toStroke(raw: unknown): Stroke | null {
	if (!raw || typeof raw !== "object") return null;
	const s = raw as Record<string, unknown>;
	const id = typeof s.id === "string" ? s.id : uid();
	const color = typeof s.color === "string" ? s.color : "#ffffff";

	if (typeof s.d === "string" && s.d.length > 0) {
		return { id, color, width: Math.max(0.1, num(s.width, 3)), d: s.d };
	}

	const pts = Array.isArray(s.points)
		? (s.points as LegacyPoint[]).filter(
				(p) => p && typeof p.x === "number" && typeof p.y === "number",
			)
		: [];
	if (pts.length === 0) return null;

	const avgPressure = pts.reduce((sum, p) => sum + (typeof p.p === "number" ? p.p : 0.5), 0) / pts.length;
	const size = num(s.size, 3);
	const width = Math.max(0.5, size * 2 * avgPressure);

	let d = `M${round2(pts[0].x)},${round2(pts[0].y)}`;
	for (let i = 1; i < pts.length; i++) d += `L${round2(pts[i].x)},${round2(pts[i].y)}`;
	// A zero-length path renders nothing even with round caps; nudge dots.
	if (pts.length === 1) d += "l0.01,0";

	return { id, color, width, d };
}

export function parseData(text: string): WhiteboardData {
	const trimmed = text.trim();
	if (!trimmed) return emptyData();
	try {
		const raw = JSON.parse(trimmed) as Record<string, unknown>;
		if (!raw || typeof raw !== "object") return emptyData();

		let rawPages: unknown[];
		if (Array.isArray(raw.pages) && raw.pages.length > 0) {
			rawPages = raw.pages;
		} else if (Array.isArray(raw.strokes)) {
			// Legacy single-canvas format: fold all strokes into one page.
			rawPages = [{ strokes: raw.strokes }];
		} else {
			rawPages = [{}];
		}

		const pages: Page[] = rawPages.map((p) => {
			const rp = (p ?? {}) as Record<string, unknown>;
			const strokes = Array.isArray(rp.strokes)
				? rp.strokes.map(toStroke).filter((s): s is Stroke => s !== null)
				: [];
			return { id: typeof rp.id === "string" ? rp.id : uid(), strokes };
		});

		// Older versions persisted the camera as a screen-space offset, which
		// doesn't translate to the center/zoom encoding; only trust v3 views.
		const rawView = raw.view as Record<string, unknown> | undefined;
		const view =
			raw.version === 3 && rawView && typeof rawView === "object"
				? { cx: num(rawView.cx, 0), cy: num(rawView.cy, 0), zoom: num(rawView.zoom, 1) }
				: undefined;

		return { version: 3, pages, view };
	} catch {
		return emptyData();
	}
}

export function serializeData(data: WhiteboardData): string {
	return JSON.stringify(data, null, 2);
}

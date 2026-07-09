export interface Point {
	x: number;
	y: number;
	/** Pressure 0..1. Undefined for non-pressure devices (treated as 0.5). */
	p?: number;
}

export interface Stroke {
	id: string;
	/** Hex color string like "#ffffff". */
	color: string;
	/** Base stroke thickness in canvas units. */
	size: number;
	points: Point[];
}

export interface Page {
	id: string;
	/** Strokes in this page's own local coordinate space (origin at its top-left). */
	strokes: Stroke[];
}

export interface WhiteboardData {
	version: 2;
	/** Persisted scroll position + zoom over the page stack. */
	view?: { x: number; y: number; scale: number };
	pages: Page[];
}

export function uid(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** A fresh single-page document. Always returns a new object/array instance. */
export function emptyData(): WhiteboardData {
	return { version: 2, pages: [{ id: uid(), strokes: [] }] };
}

export function parseData(text: string): WhiteboardData {
	const trimmed = text.trim();
	if (!trimmed) return emptyData();
	try {
		const raw = JSON.parse(trimmed) as Partial<WhiteboardData> & { strokes?: Stroke[] };
		if (!raw || typeof raw !== "object") return emptyData();

		let pages: Page[];
		if (Array.isArray(raw.pages) && raw.pages.length > 0) {
			pages = raw.pages.map((p) => ({
				id: typeof p?.id === "string" ? p.id : uid(),
				strokes: Array.isArray(p?.strokes) ? p.strokes : [],
			}));
		} else if (Array.isArray(raw.strokes)) {
			// Legacy single-canvas format: fold all strokes into one page.
			pages = [{ id: uid(), strokes: raw.strokes }];
		} else {
			pages = [{ id: uid(), strokes: [] }];
		}

		const rawView = raw.view;
		const view =
			rawView && typeof rawView === "object"
				? { x: rawView.x ?? 0, y: rawView.y ?? 0, scale: rawView.scale ?? 1 }
				: undefined;

		return { version: 2, pages, view };
	} catch {
		return emptyData();
	}
}

export function serializeData(data: WhiteboardData): string {
	return JSON.stringify(data, null, 2);
}

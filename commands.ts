import fs from "node:fs/promises";
import path from "node:path";
import type { CsvService, Logger } from "./services.ts";

type AnyCsv = Record<string, string>;

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const pairs = argv.slice(2).map((p) => {
		const [k, v] = p.replace(/^--/, "").split("=");
		return [k, (v as string | undefined) ?? true] as const;
	});
	return Object.fromEntries(pairs) as Record<string, string | boolean>;
}

async function readCsv(filePath: string): Promise<AnyCsv[]> {
	const content = await fs.readFile(filePath, "utf8");
	const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
	if (lines.length === 0) return [];
	const headers = lines[0]!.split(",");
	const rows: AnyCsv[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		const cols: string[] = [];
		let cur = "";
		let inQ = false;
		for (let j = 0; j < line.length; j++) {
			const ch = line[j]!;
			if (inQ) {
				if (ch === '"') {
					if (line[j + 1] === '"') { cur += '"'; j++; } else { inQ = false; }
				} else { cur += ch; }
			} else {
				if (ch === '"') { inQ = true; }
				else if (ch === ',') { cols.push(cur); cur = ""; }
				else { cur += ch; }
			}
		}
		cols.push(cur);
		const obj: Record<string, string> = {};
		headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });
		rows.push(obj);
	}
	return rows;
}

export class AnalyzeCommand {
	constructor(
		private readonly csv: CsvService,
		private readonly logger: Logger
	) {}

	private toNum(v: string | null | undefined): number | null {
		if (v == null) return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}

	private async fileExists(p: string): Promise<boolean> {
		try { await fs.access(p); return true; } catch { return false; }
	}

	async run(argv: string[]): Promise<void> {
		const args = parseArgs(argv);
		const dir = String(args.dir ?? args.d ?? "");
		const noGui = Boolean(args["no-gui"] || args["nogui"]);
		const hasCompare = Boolean(args.a || args.A) && Boolean(args.b || args.B);
		const auditDir = String((args.audit ?? args.AUDIT ?? ""));

		const outBase = path.resolve("out");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const outDir = path.join(outBase, `analyze-${timestamp}`);
		await fs.mkdir(outDir as unknown as import("node:fs").PathLike, { recursive: true });

		// Lazy import plotly wrapper to avoid issues in headless usage
		const plot = async (..._args: unknown[]) => { if (!noGui) { const { plot } = await import("nodeplotlib"); (plot as any)(..._args); } };

		const readTrains = async (trainsCsvPath: string): Promise<Map<string, { dest?: string; ka_name?: string; route_name?: string; color?: string }>> => {
			const map = new Map<string, { dest?: string; ka_name?: string; route_name?: string; color?: string }>();
			if (!(await this.fileExists(trainsCsvPath))) return map;
			const rows = await readCsv(trainsCsvPath);
			for (const r of rows) {
				const id = r["train_id"] ?? "";
				if (!id) continue;
				map.set(id, { dest: r["dest"], ka_name: r["ka_name"], route_name: r["route_name"], color: r["color"] });
			}
			return map;
		};

		const groupLegsByTrain = (legs: { train_id: string; seq: number; from_station: string; to_station: string; leg_minutes: number | null; ka_name?: string; route_name?: string; color?: string; }[]): Map<string, any[]> => {
			const m = new Map<string, any[]>();
			for (const l of legs) {
				if (!m.has(l.train_id)) m.set(l.train_id, []);
				m.get(l.train_id)!.push(l);
			}
			for (const [k, arr] of m) {
				arr.sort((a: any, b: any) => a.seq - b.seq);
			}
			return m;
		};

		const deriveLegsFromStops = async (stopsCsvPath: string) => {
			const rows = await readCsv(stopsCsvPath);
			const byTrain = new Map<string, AnyCsv[]>();
			for (const r of rows) {
				const tid = r["train_id"] ?? "";
				if (!byTrain.has(tid)) byTrain.set(tid, []);
				byTrain.get(tid)!.push(r);
			}
			const result: any[] = [];
			for (const [trainId, list] of byTrain) {
				list.sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
				for (let i = 0; i < list.length - 1; i++) {
					const a = list[i]!;
					const b = list[i + 1]!;
					const aMin = this.toNum(a["time_est_min"]);
					const bMin = this.toNum(b["time_est_min"]);
					let d: number | null = null;
					if (aMin != null && bMin != null) {
						d = bMin - aMin;
						if (d < 0) d += 24 * 60;
					}
					result.push({
						train_id: trainId,
						seq: i + 1,
						from_station: a["station_name"] ?? "",
						to_station: b["station_name"] ?? "",
						leg_minutes: d,
						ka_name: a["ka_name"],
						route_name: a["route_name"],
						color: a["color"],
					});
				}
			}
			return result;
		};

		const loadLegs = async (legsCsvPath: string, stopsCsvPath: string) => {
			if (await this.fileExists(legsCsvPath)) {
				const rows = await readCsv(legsCsvPath);
				return rows.map((r, idx) => ({
					train_id: r["train_id"] ?? "",
					seq: Number(r["from_index"]) || idx + 1,
					from_station: r["from_station"] ?? "",
					to_station: r["to_station"] ?? "",
					leg_minutes: this.toNum(r["leg_minutes"]),
					ka_name: r["ka_name"],
					route_name: r["route_name"],
					color: r["color"],
				}));
			}
			if (await this.fileExists(stopsCsvPath)) {
				return deriveLegsFromStops(stopsCsvPath);
			}
			throw new Error("legs.csv atau stops.csv tidak ditemukan");
		};

		// Audit/Compare/Single
		if (auditDir) {
			const legsPath = path.join(auditDir, "legs.csv");
			const stopsPath = path.join(auditDir, "stops.csv");
			const legs = await loadLegs(legsPath, stopsPath);

			let nullCount = 0, negCount = 0, over60 = 0, total = 0;
			const outliers: { segment: string; value: number }[] = [];
			for (const l of legs) {
				total++;
				const v = l.leg_minutes as number | null;
				if (v == null) { nullCount++; continue; }
				if (v < 0) negCount++;
				if (v > 60) over60++;
			}

			const segStats = new Map<string, { values: number[] }>();
			for (const l of legs) {
				if ((l.leg_minutes as number | null) == null) continue;
				const k = `${l.from_station}→${l.to_station}`;
				const e = segStats.get(k) ?? { values: [] };
				e.values.push(l.leg_minutes as number);
				segStats.set(k, e);
			}
			for (const [k, e] of segStats) {
				const arr = e.values;
				if (arr.length < 5) continue;
				const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
				const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length) || 0;
				if (std === 0) continue;
				for (const v of arr) {
					const z = Math.abs((v - mean) / std);
					if (z >= 3) outliers.push({ segment: k, value: Number(v.toFixed(2)) });
				}
			}

			const byTrain = groupLegsByTrain(legs);
			const continuityRows: { train_id: string; breaks: number }[] = [];
			for (const [tid, seq] of byTrain) {
				let breaks = 0;
				for (let i = 0; i < seq.length - 1; i++) {
					if (seq[i]!.to_station !== seq[i + 1]!.from_station) breaks++;
				}
				continuityRows.push({ train_id: tid, breaks });
			}

			await fs.writeFile(path.join(outDir, "audit_summary.json"), JSON.stringify({ dir: auditDir, total_legs: total, null_legs: nullCount, negative_legs: negCount, over60min_legs: over60, outlier_count: outliers.length }, null, 2));
			await fs.writeFile(path.join(outDir, "outliers.csv"), this.csv.toCSV(outliers as any, ["segment","value"]));
			await fs.writeFile(path.join(outDir, "train_continuity.csv"), this.csv.toCSV(continuityRows as any, ["train_id","breaks"]));

			const segRows = Array.from(segStats.entries()).map(([k, e]) => {
				const avg = e.values.reduce((a, b) => a + b, 0) / e.values.length;
				return { segment: k, avg: Number(avg.toFixed(2)), count: e.values.length };
			}).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

			const labels = segRows.map(s => s.segment);
			const avgBars = segRows.map(s => s.avg);
			await plot([{ x: labels, y: avgBars, type: "bar", name: "Rata-rata menit", marker: { color: "tomato" } }], { title: `Audit: Top 30 Segmen (avg) — ${path.basename(auditDir)}`, xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "menit" } });

			const html = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>KRL Audit Report</title>\n  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>\n  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:520px;margin:24px 0}</style>\n</head>\n<body>\n  <h1>Audit: ${auditDir}</h1>\n  <p>Total legs: ${total} | null: ${nullCount} | negative: ${negCount} | >60m: ${over60} | outliers: ${outliers.length}</p>\n  <div id="top" class="chart"></div>\n  <script>\n    const labels = ${JSON.stringify(labels)}; const bars = ${JSON.stringify(avgBars)};\n    Plotly.newPlot('top', [{ x: labels, y: bars, type: 'bar', name: 'Avg' }], { title:'Top 30 Segmen (avg menit)', xaxis:{ tickangle:-45, automargin:true }, yaxis:{ title:'menit' } }, {responsive:true});\n  </script>\n  <p>Detail: outliers.csv, train_continuity.csv, audit_summary.json</p>\n</body>\n</html>`;
			await fs.writeFile(path.join(outDir, "report.html"), html);
			this.logger.info(`Audit selesai untuk ${auditDir}. Output: ${outDir}`);
			this.logger.info(`- audit_summary.json`);
			this.logger.info(`- outliers.csv`);
			this.logger.info(`- train_continuity.csv`);
			this.logger.info(`- report.html`);
			return;
		}

		if (hasCompare) {
			const aDir = String(args.a ?? args.A);
			const bDir = String(args.b ?? args.B);
			const start = String(args.start ?? args.s ?? "");
			if (!start) throw new Error("Mode compare membutuhkan --start=Nama Stasiun Awal");

			const [legsA, legsB, trainsA, trainsB] = await Promise.all([
				loadLegs(path.join(aDir, "legs.csv"), path.join(aDir, "stops.csv")),
				loadLegs(path.join(bDir, "legs.csv"), path.join(bDir, "stops.csv")),
				readTrains(path.join(aDir, "trains.csv")),
				readTrains(path.join(bDir, "trains.csv")),
			]);

			const byTrainA = groupLegsByTrain(legsA);
			const byTrainB = groupLegsByTrain(legsB);
			const extractSegments = (byTrain: Map<string, any[]>, trains: Map<string, { dest?: string }>) => {
				const res = new Map<string, any[]>();
				for (const [tid, seq] of byTrain) {
					const startIdx = seq.findIndex((l: any) => l.from_station === start);
					if (startIdx < 0) continue;
					const dest = trains.get(tid)?.dest || seq[seq.length - 1]?.to_station || "";
					if (!dest) continue;
					const taken: any[] = [];
					for (let i = startIdx; i < seq.length; i++) {
						const leg = seq[i]!;
						taken.push(leg);
						if (leg.to_station === dest) break;
					}
					if (taken.length === 0) continue;
					const cur = res.get(dest) ?? [];
					cur.push(...taken);
					res.set(dest, cur);
				}
				return res;
			};

			const segsAByDest = extractSegments(byTrainA, trainsA as any);
			const segsBByDest = extractSegments(byTrainB, trainsB as any);
			const allDests = new Set<string>([...segsAByDest.keys(), ...segsBByDest.keys()]);

			const chartDivs: string[] = [];
			const scriptSnippets: string[] = [];
			let chartIdx = 0;
			for (const dest of allDests) {
				const labelsFrom = (list: any[] | undefined): string[] => {
					if (!list || list.length === 0) return [];
					const labels: string[] = [];
					for (const l of list) {
						const lab = `${l.from_station}→${l.to_station}`;
						if (labels.length === 0 || labels[labels.length - 1] !== lab) labels.push(lab);
					}
					return labels;
				};
				const labelOrder = labelsFrom(segsAByDest.get(dest)).concat(labelsFrom(segsBByDest.get(dest))).reduce<string[]>((acc, lab) => { if (!acc.includes(lab)) acc.push(lab); return acc; }, []);
				const avgByLabel = (list: any[] | undefined): (number | null)[] => {
					const map = new Map<string, { sum: number; count: number }>();
					if (list) {
						for (const l of list) {
							const lab = `${l.from_station}→${l.to_station}`;
							if (l.leg_minutes == null) continue;
							const e = map.get(lab) ?? { sum: 0, count: 0 };
							e.sum += l.leg_minutes;
							e.count += 1;
							map.set(lab, e);
						}
					}
					return labelOrder.map(lab => {
						const e = map.get(lab);
						return e && e.count > 0 ? Number((e.sum / e.count).toFixed(2)) : null;
					});
				};

				const labels = labelOrder;
				const avgA = avgByLabel(segsAByDest.get(dest));
				const avgB = avgByLabel(segsBByDest.get(dest));

				const id = `chart_${chartIdx++}`;
				chartDivs.push(`<h2>Perbandingan Durasi: ${start} → ${dest}</h2><div id="${id}" class="chart"></div>`);
				scriptSnippets.push(`(() => { const labels = ${JSON.stringify(labels)}; const a = ${JSON.stringify(avgA)}; const b = ${JSON.stringify(avgB)}; const trA = { x: labels, y: a, type: 'scatter', mode: 'lines+markers', name: 'Data A' }; const trB = { x: labels, y: b, type: 'scatter', mode: 'lines+markers', name: 'Data B' }; Plotly.newPlot('${id}', [trA, trB], { title: 'Perbandingan Durasi Antar Stasiun: ${start} → ${dest}', xaxis: { title: 'Segmen Antar Stasiun', tickangle: -45, automargin: true }, yaxis: { title: 'Durasi (menit)' } }, {responsive:true}); })();`);

				await plot([{ x: labels, y: avgA, type: "scatter", mode: "lines+markers", name: "Data A" }, { x: labels, y: avgB, type: "scatter", mode: "lines+markers", name: "Data B" }], { title: `Perbandingan Durasi: ${start} → ${dest}`, xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "Durasi (menit)" } });
			}

			// reuse aDir, bDir from above
			const html = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>KRL Compare Report</title>\n  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>\n  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:520px;margin:24px 0}</style>\n</head>\n<body>\n  <h1>Compare: ${aDir} vs ${bDir}</h1>\n  <p>Start: ${String(args.start ?? args.s ?? "")}</p>\n  ${chartDivs.join("\n")} \n  <script>${scriptSnippets.join("\n")}</script>\n  <p>Dibuat: ${new Date().toLocaleString()}</p>\n</body>\n</html>`;
			await fs.writeFile(path.join(outDir, "report.html"), html);
			this.logger.info(`Selesai. Output: ${outDir}`);
			this.logger.info(`- report.html (per-destinasi satu grafik)`);
			return;
		}

		// Single-dir mode
		if (!dir) throw new Error("Usage: --dir, atau compare --a --b --start, atau --audit");
		const legsPath = path.join(dir, "legs.csv");
		const stopsPath = path.join(dir, "stops.csv");
		const legs = await loadLegs(legsPath, stopsPath);

		const legsSorted = legs.slice().sort((a: any, b: any) => a.train_id === b.train_id ? a.seq - b.seq : a.train_id.localeCompare(b.train_id));
		const legsRows = legsSorted.map((r: any) => ({ train_id: r.train_id, seq: r.seq, from_station: r.from_station, to_station: r.to_station, leg_minutes: r.leg_minutes, ka_name: r.ka_name, route_name: r.route_name, color: r.color }));
		await fs.writeFile(path.join(outDir, "legs_by_train.csv"), this.csv.toCSV(legsRows as any, ["train_id","seq","from_station","to_station","leg_minutes","ka_name","route_name","color"]));

		const agg = new Map<string, { count: number; min: number | null; max: number | null; sum: number }>();
		const keyInfo = new Map<string, { from: string; to: string }>();
		for (const r of legs as any[]) {
			const key = `${r.from_station}__${r.to_station}`;
			const st = agg.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
			if (r.leg_minutes != null) {
				st.count++;
				st.sum += r.leg_minutes;
				st.min = st.min == null ? r.leg_minutes : Math.min(st.min, r.leg_minutes);
				st.max = st.max == null ? r.leg_minutes : Math.max(st.max, r.leg_minutes);
			}
			agg.set(key, st);
			if (!keyInfo.has(key)) keyInfo.set(key, { from: r.from_station, to: r.to_station });
		}
		const segRows = Array.from(agg.entries()).map(([key, st]) => {
			const info = keyInfo.get(key)!;
			const avg = st.count > 0 ? st.sum / st.count : null;
			return { from_station: info.from, to_station: info.to, count: st.count, min: st.min, max: st.max, avg: avg != null ? Number(avg.toFixed(2)) : null };
		}).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

		await fs.writeFile(path.join(outDir, "segment_stats.csv"), this.csv.toCSV(segRows as any, ["from_station","to_station","count","min","max","avg"]));

		const allDur = (legs as any[]).map(l => l.leg_minutes).filter((x: any) => x != null);
		await plot([{ x: allDur, type: "histogram", nbinsx: 40, name: "Durasi antar stasiun (menit)" }], { title: "Distribusi Durasi Antar Stasiun", xaxis: { title: "menit" }, yaxis: { title: "frekuensi" } });

		const labels = segRows.map(s => `${s.from_station} → ${s.to_station}`);
		const avgBars = segRows.map(s => s.avg);
		await plot([{ x: labels, y: avgBars, type: "bar", name: "Rata-rata menit", marker: { color: "steelblue" } }], { title: "Top 30 Segmen Terlama (rata-rata menit)", xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "menit" }, barmode: "group" });

		const html = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>KRL Analyze Report</title>\n  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>\n  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:600px;margin:24px 0}</style>\n</head>\n<body>\n  <h1>KRL Analyze Report</h1>\n  <p>Sumber: ${dir}</p>\n  <h2>Distribusi Durasi Antar Stasiun</h2>\n  <div id="hist" class="chart"></div>\n  <h2>Top 30 Segmen Terlama (rata-rata menit)</h2>\n  <div id="top" class="chart"></div>\n  <script>\n    const allDur = ${JSON.stringify(allDur)};\n    const labels = ${JSON.stringify(labels)};\n    const avgBars = ${JSON.stringify(avgBars)};\n    Plotly.newPlot('hist', [{ x: allDur, type: 'histogram', nbinsx: 40, name: 'Durasi' }], { title:'Distribusi Durasi Antar Stasiun', xaxis:{ title:'menit' }, yaxis:{ title:'frekuensi' } }, {responsive:true});\n    Plotly.newPlot('top', [{ x: labels, y: avgBars, type: 'bar', name: 'Rata-rata', marker:{ color:'steelblue' } }], { title:'Top 30 Segmen Terlama (rata-rata menit)', xaxis:{ tickangle:-45, automargin:true }, yaxis:{ title:'menit' } }, {responsive:true});\n  </script>\n  <p>Dibuat: ${new Date().toLocaleString()}</p>\n</body>\n</html>`;
		await fs.writeFile(path.join(outDir, "report.html"), html);
		this.logger.info(`Selesai. Output: ${outDir}`);
		this.logger.info(`- legs_by_train.csv`);
		this.logger.info(`- segment_stats.csv`);
		this.logger.info(`- report.html`);
	}
}

export class ThroughCommand {
	constructor(private readonly logger: Logger) {}

	private hmsToMin(hms: string | undefined): number | null {
		if (!hms) return null;
		const [hStr, mStr, sStr = "0"] = hms.split(":");
		const h = Number(hStr);
		const m = Number(mStr);
		const s = Number(sStr);
		if (Number.isNaN(h) || Number.isNaN(m)) return null;
		return h * 60 + m + (Number.isNaN(s) ? 0 : Math.floor(s / 60));
	}

	private async loadStops(dir: string): Promise<AnyCsv[]> {
		return readCsv(path.join(dir, "stops.csv"));
	}

	private async loadTrains(dir: string): Promise<Map<string, { dest?: string; ka_name?: string; route_name?: string }>> {
		const p = path.join(dir, "trains.csv");
		const map = new Map<string, { dest?: string; ka_name?: string; route_name?: string }>();
		try {
			const rows = await readCsv(p);
			for (const r of rows) {
				if (!r["train_id"]) continue;
				map.set(r["train_id"], { dest: r["dest"], ka_name: r["ka_name"], route_name: r["route_name"] });
			}
		} catch {}
		return map;
	}

	private findThrough(stops: AnyCsv[], trains: Map<string, { dest?: string; ka_name?: string; route_name?: string }>, via: string, dest: string) {
		const byTrain = new Map<string, AnyCsv[]>();
		for (const r of stops) {
			const tid = r["train_id"] ?? "";
			if (!byTrain.has(tid)) byTrain.set(tid, []);
			byTrain.get(tid)!.push(r);
		}
		const res: any[] = [];
		for (const [tid, arr] of byTrain) {
			arr.sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
			const viaIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === via.toLowerCase());
			if (viaIdx < 0) continue;
			const taIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang");
			if (taIdx < 0) continue;
			if (!(viaIdx < taIdx)) continue;
			const destIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === dest.toLowerCase());
			const continues = destIdx > taIdx;
			if (!continues) continue;
			const meta = trains.get(tid) || {};
			res.push({ train_id: tid, ka_name: meta.ka_name, route_name: meta.route_name, depart_via_time: arr[viaIdx]?.["time_est"], via_index: Number(arr[viaIdx]?.["stop_index"]) || viaIdx, continues_to_dest: true });
		}
		res.sort((a, b) => String(a.depart_via_time).localeCompare(String(b.depart_via_time)));
		return res;
	}

	private buildTransferPairs(stopsPre: AnyCsv[], stopsPost: AnyCsv[], trains: Map<string, { dest?: string; ka_name?: string; route_name?: string }>, via: string, dest: string, maxWaitMin: number | null) {
		const byTrainPre = new Map<string, AnyCsv[]>();
		const byTrainPost = new Map<string, AnyCsv[]>();
		for (const r of stopsPre) {
			const tid = r["train_id"] ?? "";
			if (!byTrainPre.has(tid)) byTrainPre.set(tid, []);
			byTrainPre.get(tid)!.push(r);
		}
		for (const r of stopsPost) {
			const tid = r["train_id"] ?? "";
			if (!byTrainPost.has(tid)) byTrainPost.set(tid, []);
			byTrainPost.get(tid)!.push(r);
		}

		type LegA = { trainId: string; departVia: string; arriveTA: string; departViaMin: number; arriveTAMin: number; meta?: { ka_name?: string; route_name?: string } };
		type LegB = { trainId: string; departTA: string; arriveDest?: string; departTAMin: number; arriveDestMin: number | null; meta?: { ka_name?: string; route_name?: string } };
		const legAs: LegA[] = [];
		const legBs: LegB[] = [];

		for (const [tid, arr0] of byTrainPre) {
			const arr = arr0.slice().sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
			const idxVia = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === via.toLowerCase());
			const idxTA = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang");
			const meta = trains.get(tid);
			if (idxVia >= 0 && idxTA > idxVia) {
				const departVia = arr[idxVia]!['time_est'];
				const arriveTA = arr[idxTA]!['time_est'];
				const departViaMin = Number(arr[idxVia]!['time_est_min']) || this.hmsToMin(departVia)!;
				const arriveTAMin = Number(arr[idxTA]!['time_est_min']) || this.hmsToMin(arriveTA)!;
				if (departVia && arriveTA && departViaMin != null && arriveTAMin != null) {
					legAs.push({ trainId: tid, departVia, arriveTA, departViaMin, arriveTAMin, meta: meta ? { ka_name: meta.ka_name, route_name: meta.route_name } : undefined });
				}
			}
		}

		for (const [tid, arr0] of byTrainPost) {
			const arr = arr0.slice().sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
			const idxTA = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang");
			const idxDest = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === dest.toLowerCase());
			const meta = trains.get(tid);
			if (idxTA >= 0 && idxDest > idxTA) {
				const departTA = arr[idxTA]!['time_est'];
				const arriveDest = arr[idxDest]!['time_est'];
				const departTAMin = Number(arr[idxTA]!['time_est_min']) || this.hmsToMin(departTA)!;
				const arriveDestMin = Number(arr[idxDest]!['time_est_min']) || this.hmsToMin(arriveDest)!;
				if (departTA && departTAMin != null) {
					legBs.push({ trainId: tid, departTA, arriveDest, departTAMin, arriveDestMin: arriveDestMin ?? null, meta: meta ? { ka_name: meta.ka_name, route_name: meta.route_name } : undefined });
				}
			}
		}

		legBs.sort((a, b) => a.departTAMin - b.departTAMin);

		function waitDiffMin(arrive: number, depart: number): number {
			let d = depart - arrive;
			if (d < 0) d += 24 * 60;
			return d;
		}

		const pairs: any[] = [];
		for (const a of legAs) {
			let lo = 0, hi = legBs.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (legBs[mid]!.departTAMin < a.arriveTAMin) lo = mid + 1; else hi = mid;
			}
			const candidates: LegB[] = [];
			const addCand = (b: LegB | undefined) => { if (b && !candidates.includes(b)) candidates.push(b); };
			addCand(legBs[lo]);
			addCand(legBs[lo + 1]);
			addCand(legBs[0]);

			let best: { b: LegB; wait: number } | null = null;
			for (const b of candidates) {
				const wait = waitDiffMin(a.arriveTAMin, b.departTAMin);
				if (maxWaitMin != null && wait > maxWaitMin) continue;
				if (!best || wait < best.wait) best = { b, wait };
			}
			if (best) {
				pairs.push({ from_train_id: a.trainId, to_train_id: best.b.trainId, depart_via_time: a.departVia, arrive_ta_time: a.arriveTA, depart_ta_time: best.b.departTA, arrive_dest_time: best.b.arriveDest, wait_min: best.wait, meta_from: a.meta, meta_to: best.b.meta });
			}
		}

		pairs.sort((x, y) => x.wait_min - y.wait_min || String(x.depart_via_time).localeCompare(String(y.depart_via_time)));
		return pairs;
	}

	async run(argv: string[]): Promise<void> {
		const args = parseArgs(argv);
		const aDir = String(args.a ?? args.A ?? "");
		const bDir = String(args.b ?? args.B ?? "");
		const preDir = String(args.pre ?? "");
		const postDir = String(args.post ?? "");
		const via = String(args.via ?? args.from ?? args.start ?? "");
		const dest = String(args.to ?? args.dest ?? "");
		const orderArg = String(args.order ?? args.sort ?? "depart").toLowerCase();
		const isDesc = Boolean(args.desc || args.descending);
		const limitArg = String(args.limit ?? args.top ?? "");
		const limitNum = (() => { const n = Number(limitArg); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; })();
		if ((!aDir || !bDir) && (!preDir || !postDir)) {
			throw new Error("through: butuh kombinasi --a & --b atau --pre & --post");
		}

		const srcPre = preDir || aDir;
		const srcPost = postDir || bDir;

		const [stopsPre, stopsPost, trainsPre, trainsPost] = await Promise.all([
			this.loadStops(srcPre),
			this.loadStops(srcPost),
			this.loadTrains(srcPre),
			this.loadTrains(srcPost)
		]);
		const stops = stopsPre.concat(stopsPost);
		const trains = new Map<string, { dest?: string; ka_name?: string; route_name?: string }>([...trainsPre, ...trainsPost]);

		const results = this.findThrough(stops, trains, via, dest);
		if (orderArg === "depart") {
			results.sort((a, b) => String(a.depart_via_time).localeCompare(String(b.depart_via_time)) * (isDesc ? -1 : 1));
		}
		if (results.length === 0) {
			const maxWaitArg = args.maxwait ?? args.maxWait ?? args.wait;
			const maxWaitMin = typeof maxWaitArg === "string" && maxWaitArg.length > 0 ? Number(maxWaitArg) : null;
			const pairs = this.buildTransferPairs(stopsPre, stopsPost, trains, via, dest, Number.isFinite(maxWaitMin as number) ? Number(maxWaitMin) : null);
			if (orderArg === "depart") {
				pairs.sort((x, y) => String(x.depart_via_time).localeCompare(String(y.depart_via_time)) * (isDesc ? -1 : 1));
			} else if (orderArg === "wait") {
				pairs.sort((x, y) => (x.wait_min - y.wait_min) * (isDesc ? -1 : 1));
			}
			if (pairs.length === 0) {
				this.logger.info(`Tidak ada kereta tembus DAN tidak menemukan pasangan transfer yang cocok dari '${via}' → 'Tanah Abang' → '${dest}'.`);
				return;
			}
			this.logger.info(`Tidak ada tembus. Rekomendasi transfer ${maxWaitMin != null ? `(<= ${maxWaitMin} menit)` : ""}${orderArg ? ` | diurutkan berdasar ${orderArg}${isDesc ? " desc" : ""}` : ""}:`);
			const outPairs = limitNum > 0 ? pairs.slice(0, limitNum) : pairs;
			for (const p of outPairs) {
				const fromMeta = [p.meta_from?.ka_name, p.meta_from?.route_name].filter(Boolean).join(" - ");
				const toMeta = [p.meta_to?.ka_name, p.meta_to?.route_name].filter(Boolean).join(" - ");
				this.logger.info(`- VIA ${via} ${p.depart_via_time} [${p.from_train_id}${fromMeta ? ` | ${fromMeta}` : ""}] → TA ${p.arrive_ta_time} | ganti | TA ${p.depart_ta_time} [${p.to_train_id}${toMeta ? ` | ${toMeta}` : ""}] → ${dest} ${p.arrive_dest_time ?? "??:??"} | tunggu ~${p.wait_min}m`);
			}
			return;
		}

		this.logger.info(`Kereta tembus dari ${via} → Tanah Abang → ${dest}${orderArg ? ` | diurutkan berdasar ${orderArg}${isDesc ? " desc" : ""}` : ""}:`);
		const outThrough = limitNum > 0 ? results.slice(0, limitNum) : results;
		for (const r of outThrough) {
			const name = [r.ka_name, r.route_name].filter(Boolean).join(" - ");
			this.logger.info(`- ${r.depart_via_time ?? "??:??"} | ${r.train_id}${name ? " | " + name : ""}`);
		}
	}
}



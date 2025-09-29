import fs from "node:fs/promises";
import path from "node:path";
import { SimpleCsvService } from "./services.ts";
import { plot } from "nodeplotlib";
import type { Plot } from "nodeplotlib";

type AnyCsv = Record<string, string>;

type LegOut = {
  train_id: string;
  seq: number;
  from_station: string;
  to_station: string;
  leg_minutes: number | null;
  ka_name?: string;
  route_name?: string;
  color?: string;
};

type SegmentKey = string; // `${from_station}__${to_station}`

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

function toNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type Stats = { count: number; min: number | null; max: number | null; sum: number; };
function pushStat(st: Stats, v: number | null): void {
  if (v == null) return;
  st.count++;
  st.sum += v;
  st.min = st.min == null ? v : Math.min(st.min, v);
  st.max = st.max == null ? v : Math.max(st.max, v);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function deriveLegsFromStops(stopsCsvPath: string): Promise<LegOut[]> {
  const rows = await readCsv(stopsCsvPath);
  const byTrain = new Map<string, AnyCsv[]>();
  for (const r of rows) {
    const tid = r["train_id"] ?? "";
    if (!byTrain.has(tid)) byTrain.set(tid, []);
    byTrain.get(tid)!.push(r);
  }
  const result: LegOut[] = [];
  for (const [trainId, list] of byTrain) {
    list.sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]!;
      const b = list[i + 1]!;
      const aMin = toNum(a["time_est_min"]);
      const bMin = toNum(b["time_est_min"]);
      let d: number | null = null;
      if (aMin != null && bMin != null) {
        d = bMin - aMin;
        if (d < 0) d += 24 * 60; // cross-midnight safeguard
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
}

async function loadLegs(legsCsvPath: string, stopsCsvPath: string): Promise<LegOut[]> {
  if (await fileExists(legsCsvPath)) {
    const rows = await readCsv(legsCsvPath);
    return rows.map((r, idx) => ({
      train_id: r["train_id"] ?? "",
      seq: Number(r["from_index"]) || idx + 1,
      from_station: r["from_station"] ?? "",
      to_station: r["to_station"] ?? "",
      leg_minutes: toNum(r["leg_minutes"]),
      ka_name: r["ka_name"],
      route_name: r["route_name"],
      color: r["color"],
    }));
  }
  if (await fileExists(stopsCsvPath)) {
    return deriveLegsFromStops(stopsCsvPath);
  }
  throw new Error("legs.csv atau stops.csv tidak ditemukan");
}

async function readTrains(trainsCsvPath: string): Promise<Map<string, { dest?: string; ka_name?: string; route_name?: string; color?: string }>> {
  const map = new Map<string, { dest?: string; ka_name?: string; route_name?: string; color?: string }>();
  if (!(await fileExists(trainsCsvPath))) return map;
  const rows = await readCsv(trainsCsvPath);
  for (const r of rows) {
    const id = r["train_id"] ?? "";
    if (!id) continue;
    map.set(id, { dest: r["dest"], ka_name: r["ka_name"], route_name: r["route_name"], color: r["color"] });
  }
  return map;
}

function groupLegsByTrain(legs: LegOut[]): Map<string, LegOut[]> {
  const m = new Map<string, LegOut[]>();
  for (const l of legs) {
    if (!m.has(l.train_id)) m.set(l.train_id, []);
    m.get(l.train_id)!.push(l);
  }
  for (const [k, arr] of m) {
    arr.sort((a, b) => a.seq - b.seq);
  }
  return m;
}

type SeriesPerDest = {
  dest: string;
  labels: string[];
  avgA: number[];
  avgB: number[];
};

function buildCompareSeries(
  startStation: string,
  legsA: LegOut[],
  legsB: LegOut[],
  trainsA: Map<string, { dest?: string }>,
  trainsB: Map<string, { dest?: string }>
): SeriesPerDest[] {
  const byTrainA = groupLegsByTrain(legsA);
  const byTrainB = groupLegsByTrain(legsB);

  function extractSegments(byTrain: Map<string, LegOut[]>, trains: Map<string, { dest?: string }>): Map<string, LegOut[]> {
    const res = new Map<string, LegOut[]>(); // dest -> legs subset from start .. dest
    for (const [tid, seq] of byTrain) {
      // hanya ambil perjalanan yang BENAR-BENAR mulai dari start (arah maju)
      const startIdx = seq.findIndex(l => l.from_station === startStation);
      if (startIdx < 0) continue;
      const dest = trains.get(tid)?.dest || seq[seq.length - 1]?.to_station || "";
      if (!dest) continue;

      const taken: LegOut[] = [];
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
  }

  const segsAByDest = extractSegments(byTrainA, trainsA);
  const segsBByDest = extractSegments(byTrainB, trainsB);
  const allDests = new Set<string>([...segsAByDest.keys(), ...segsBByDest.keys()]);

  const series: SeriesPerDest[] = [];
  for (const dest of allDests) {
    // Choose canonical label order from A first, then B
    function labelsFrom(list: LegOut[] | undefined): string[] {
      if (!list || list.length === 0) return [];
      // order by appearance; collapse duplicates
      const labels: string[] = [];
      for (const l of list) {
        const lab = `${l.from_station}→${l.to_station}`;
        if (labels.length === 0 || labels[labels.length - 1] !== lab) labels.push(lab);
      }
      return labels;
    }
    const labelOrder = labelsFrom(segsAByDest.get(dest))
      .concat(labelsFrom(segsBByDest.get(dest)).filter(l => true))
      .reduce<string[]>((acc, lab) => { if (!acc.includes(lab)) acc.push(lab); return acc; }, []);

    function avgByLabel(list: LegOut[] | undefined): number[] {
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
        return e && e.count > 0 ? Number((e.sum / e.count).toFixed(2)) : null as unknown as number;
      });
    }

    const avgA = avgByLabel(segsAByDest.get(dest));
    const avgB = avgByLabel(segsBByDest.get(dest));
    series.push({ dest, labels: labelOrder, avgA, avgB });
  }
  return series;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const dir = String(args.dir ?? args.d ?? "");
  const noGui = Boolean(args["no-gui"] || args["nogui"]);
  const hasCompare = Boolean(args.a || args.A) && Boolean(args.b || args.B);
  const auditDir = String((args.audit ?? args.AUDIT ?? ""));

  if (!dir && !hasCompare && !auditDir) {
    console.error("Usage: bun run analyze.ts --dir=PATH_TO_SCRAPE_OUTPUT");
    console.error("PATH harus berisi salah satu: legs.csv atau stops.csv");
    console.error("Atau: bun run analyze.ts --a=DIR_A --b=DIR_B --start=STASIUN (mode compare)");
    console.error("Atau: bun run analyze.ts --audit=DIR (audit kualitas data)");
    process.exit(2);
  }
  const outBase = path.resolve("out");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(outBase, `analyze-${timestamp}`);
  await fs.mkdir(outDir as unknown as import("node:fs").PathLike, { recursive: true });
  const csv = new SimpleCsvService();

  if (auditDir) {
    const legsPath = path.join(auditDir, "legs.csv");
    const stopsPath = path.join(auditDir, "stops.csv");
    const legs = await loadLegs(legsPath, stopsPath);

    // Summary metrics
    let nullCount = 0, negCount = 0, over60 = 0, total = 0;
    const outliers: { segment: string; value: number }[] = [];
    for (const l of legs) {
      total++;
      const v = l.leg_minutes;
      if (v == null) { nullCount++; continue; }
      if (v < 0) negCount++;
      if (v > 60) over60++;
    }

    // Per-segment stats to compute z-score outliers
    const segStats = new Map<string, { values: number[] }>();
    for (const l of legs) {
      if (l.leg_minutes == null) continue;
      const k = `${l.from_station}→${l.to_station}`;
      const e = segStats.get(k) ?? { values: [] };
      e.values.push(l.leg_minutes);
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

    // Per-train continuity
    const byTrain = groupLegsByTrain(legs);
    const continuityRows: { train_id: string; breaks: number }[] = [];
    for (const [tid, seq] of byTrain) {
      let breaks = 0;
      for (let i = 0; i < seq.length - 1; i++) {
        if (seq[i]!.to_station !== seq[i + 1]!.from_station) breaks++;
      }
      continuityRows.push({ train_id: tid, breaks });
    }

    await fs.writeFile(
      path.join(outDir, "audit_summary.json"),
      JSON.stringify({
        dir: auditDir,
        total_legs: total,
        null_legs: nullCount,
        negative_legs: negCount,
        over60min_legs: over60,
        outlier_count: outliers.length
      }, null, 2)
    );

    await fs.writeFile(
      path.join(outDir, "outliers.csv"),
      csv.toCSV(outliers as unknown as Record<string, string | number | boolean | null | undefined>[], ["segment","value"])
    );

    await fs.writeFile(
      path.join(outDir, "train_continuity.csv"),
      csv.toCSV(continuityRows as unknown as Record<string, string | number | boolean | null | undefined>[], ["train_id","breaks"])
    );

    // Quick bar for top segments by avg
    const segRows = Array.from(segStats.entries()).map(([k, e]) => {
      const avg = e.values.reduce((a, b) => a + b, 0) / e.values.length;
      return { segment: k, avg: Number(avg.toFixed(2)), count: e.values.length };
    }).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

    const labels = segRows.map(s => s.segment);
    const avgBars = segRows.map(s => s.avg);
    const traceTop: Plot = { x: labels, y: avgBars, type: "bar", name: "Rata-rata menit", marker: { color: "tomato" } } as unknown as Plot;
    if (!noGui) {
      plot([traceTop], { title: `Audit: Top 30 Segmen (avg) — ${path.basename(auditDir)}`, xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "menit" } } as unknown as Partial<any>);
    }

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KRL Audit Report</title>
  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:520px;margin:24px 0}</style>
</head>
<body>
  <h1>Audit: ${auditDir}</h1>
  <p>Total legs: ${total} | null: ${nullCount} | negative: ${negCount} | >60m: ${over60} | outliers: ${outliers.length}</p>
  <div id="top" class="chart"></div>
  <script>
    const labels = ${JSON.stringify(labels)}; const bars = ${JSON.stringify(avgBars)};
    Plotly.newPlot('top', [{ x: labels, y: bars, type: 'bar', name: 'Avg' }], { title:'Top 30 Segmen (avg menit)', xaxis:{ tickangle:-45, automargin:true }, yaxis:{ title:'menit' } }, {responsive:true});
  </script>
  <p>Detail: outliers.csv, train_continuity.csv, audit_summary.json</p>
</body>
</html>`;
    await fs.writeFile(path.join(outDir, "report.html"), html);

    console.log(`Audit selesai untuk ${auditDir}. Output: ${outDir}`);
    console.log(`- audit_summary.json`);
    console.log(`- outliers.csv`);
    console.log(`- train_continuity.csv`);
    console.log(`- report.html`);
    return;
  }

  if (hasCompare) {
    const aDir = String(args.a ?? args.A);
    const bDir = String(args.b ?? args.B);
    const start = String(args.start ?? args.s ?? "");
    if (!start) {
      console.error("Mode compare membutuhkan --start=Nama Stasiun Awal");
      process.exit(2);
    }

    const [legsA, legsB, trainsA, trainsB] = await Promise.all([
      loadLegs(path.join(aDir, "legs.csv"), path.join(aDir, "stops.csv")),
      loadLegs(path.join(bDir, "legs.csv"), path.join(bDir, "stops.csv")),
      readTrains(path.join(aDir, "trains.csv")),
      readTrains(path.join(bDir, "trains.csv")),
    ]);

    const series = buildCompareSeries(start, legsA, legsB, trainsA, trainsB);

    // Save CSV for each destination and render charts
    const chartDivs: string[] = [];
    const scriptSnippets: string[] = [];
    let chartIdx = 0;
    for (const s of series) {
      await fs.writeFile(
        path.join(outDir, `compare_${start.replace(/\s+/g, "_")}__${s.dest.replace(/\s+/g, "_")}.csv`),
        csv.toCSV(
          s.labels.map((lab, i) => ({ segment: lab, avg_a: s.avgA[i], avg_b: s.avgB[i] })) as unknown as Record<string, string | number | boolean | null | undefined>[],
          ["segment","avg_a","avg_b"]
        )
      );

      const id = `chart_${chartIdx++}`;
      chartDivs.push(`<h2>Perbandingan Durasi: ${start} → ${s.dest}</h2><div id="${id}" class="chart"></div>`);
      scriptSnippets.push(
        `(() => { const labels = ${JSON.stringify(s.labels)}; const a = ${JSON.stringify(s.avgA)}; const b = ${JSON.stringify(s.avgB)}; const trA = { x: labels, y: a, type: 'scatter', mode: 'lines+markers', name: 'Data A' }; const trB = { x: labels, y: b, type: 'scatter', mode: 'lines+markers', name: 'Data B' }; Plotly.newPlot('${id}', [trA, trB], { title: 'Perbandingan Durasi Antar Stasiun: ${start} → ${s.dest}', xaxis: { title: 'Segmen Antar Stasiun', tickangle: -45, automargin: true }, yaxis: { title: 'Durasi (menit)' } }, {responsive:true}); })();`
      );

      if (!noGui) {
        const traceA: Plot = { x: s.labels, y: s.avgA, type: "scatter", mode: "lines+markers", name: "Data A" } as unknown as Plot;
        const traceB: Plot = { x: s.labels, y: s.avgB, type: "scatter", mode: "lines+markers", name: "Data B" } as unknown as Plot;
        plot([traceA, traceB], { title: `Perbandingan Durasi: ${start} → ${s.dest}`, xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "Durasi (menit)" } } as unknown as Partial<any>);
      }
    }

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KRL Compare Report</title>
  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:520px;margin:24px 0}</style>
</head>
<body>
  <h1>Compare: ${aDir} vs ${bDir}</h1>
  <p>Start: ${start}</p>
  ${chartDivs.join("\n")} 
  <script>${scriptSnippets.join("\n")}</script>
  <p>Dibuat: ${new Date().toLocaleString()}</p>
</body>
</html>`;
    await fs.writeFile(path.join(outDir, "report.html"), html);

    console.log(`Selesai. Output: ${outDir}`);
    console.log(`- report.html (per-destinasi satu grafik)`);
    return;
  }

  // Single-dir mode (existing behavior)
  const legsPath = path.join(dir, "legs.csv");
  const stopsPath = path.join(dir, "stops.csv");
  const legs = await loadLegs(legsPath, stopsPath);

  const legsSorted = legs.slice().sort((a, b) =>
    a.train_id === b.train_id ? a.seq - b.seq : a.train_id.localeCompare(b.train_id)
  );

  const legsRows = legsSorted.map(r => ({
    train_id: r.train_id,
    seq: r.seq,
    from_station: r.from_station,
    to_station: r.to_station,
    leg_minutes: r.leg_minutes,
    ka_name: r.ka_name,
    route_name: r.route_name,
    color: r.color,
  }));
  await fs.writeFile(
    path.join(outDir, "legs_by_train.csv"),
    csv.toCSV(legsRows as unknown as Record<string, string | number | boolean | null | undefined>[], [
      "train_id","seq","from_station","to_station","leg_minutes","ka_name","route_name","color"
    ])
  );

  const agg = new Map<SegmentKey, Stats>();
  const keyInfo = new Map<SegmentKey, { from: string; to: string }>();
  for (const r of legs) {
    const key = `${r.from_station}__${r.to_station}`;
    const st = agg.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
    pushStat(st, r.leg_minutes);
    agg.set(key, st);
    if (!keyInfo.has(key)) keyInfo.set(key, { from: r.from_station, to: r.to_station });
  }
  const segRows = Array.from(agg.entries()).map(([key, st]) => {
    const info = keyInfo.get(key)!;
    const avg = st.count > 0 ? st.sum / st.count : null;
    return {
      from_station: info.from,
      to_station: info.to,
      count: st.count,
      min: st.min,
      max: st.max,
      avg: avg != null ? Number(avg.toFixed(2)) : null,
    } as const;
  }).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

  await fs.writeFile(
    path.join(outDir, "segment_stats.csv"),
    csv.toCSV(segRows as unknown as Record<string, string | number | boolean | null | undefined>[], [
      "from_station","to_station","count","min","max","avg"
    ])
  );

  const allDur = legs.map(l => l.leg_minutes).filter((x): x is number => x != null);
  const traceHist: Plot = { x: allDur, type: "histogram", nbinsx: 40, name: "Durasi antar stasiun (menit)" } as unknown as Plot;
  const layoutHist = { title: "Distribusi Durasi Antar Stasiun", xaxis: { title: "menit" }, yaxis: { title: "frekuensi" } } as const;

  const topSeg = segRows;
  const labels = topSeg.map(s => `${s.from_station} → ${s.to_station}`);
  const avgBars = topSeg.map(s => s.avg);
  const traceTop: Plot = { x: labels, y: avgBars, type: "bar", name: "Rata-rata menit", marker: { color: "steelblue" } } as unknown as Plot;
  const layoutTop = { title: "Top 30 Segmen Terlama (rata-rata menit)", xaxis: { tickangle: -45, automargin: true }, yaxis: { title: "menit" }, barmode: "group" } as const;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KRL Analyze Report</title>
  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,\"Helvetica Neue\",sans-serif;padding:16px} .chart{width:100%;height:600px;margin:24px 0}</style>
</head>
<body>
  <h1>KRL Analyze Report</h1>
  <p>Sumber: ${dir}</p>
  <h2>Distribusi Durasi Antar Stasiun</h2>
  <div id="hist" class="chart"></div>
  <h2>Top 30 Segmen Terlama (rata-rata menit)</h2>
  <div id="top" class="chart"></div>
  <script>
    const allDur = ${JSON.stringify(allDur)};
    const labels = ${JSON.stringify(labels)};
    const avgBars = ${JSON.stringify(avgBars)};
    Plotly.newPlot('hist', [{ x: allDur, type: 'histogram', nbinsx: 40, name: 'Durasi' }], { title:'Distribusi Durasi Antar Stasiun', xaxis:{ title:'menit' }, yaxis:{ title:'frekuensi' } }, {responsive:true});
    Plotly.newPlot('top', [{ x: labels, y: avgBars, type: 'bar', name: 'Rata-rata', marker:{ color:'steelblue' } }], { title:'Top 30 Segmen Terlama (rata-rata menit)', xaxis:{ tickangle:-45, automargin:true }, yaxis:{ title:'menit' } }, {responsive:true});
  </script>
  <p>Dibuat: ${new Date().toLocaleString()}</p>
</body>
</html>`;
  await fs.writeFile(path.join(outDir, "report.html"), html);

  if (!noGui) {
    plot([traceHist], layoutHist as unknown as Partial<any>);
    plot([traceTop], layoutTop as unknown as Partial<any>);
  }

  console.log(`Selesai. Output: ${outDir}`);
  console.log(`- legs_by_train.csv`);
  console.log(`- segment_stats.csv`);
  console.log(`- report.html`);
}

main(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

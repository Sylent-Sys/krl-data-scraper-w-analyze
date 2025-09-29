import fs from "node:fs/promises";
import path from "node:path";
import { SimpleCsvService } from "./services.ts";
import { plot } from "nodeplotlib";
import type { Plot } from "nodeplotlib";

type LegCsv = {
  train_id: string;
  from_index: string;
  from_station: string;
  to_index: string;
  to_station: string;
  leg_minutes: string;
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

async function readCsvRows(filePath: string): Promise<LegCsv[]> {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0]!.split(",");
  const rows: LegCsv[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const cols: string[] = [];
    // CSV naive parse supporting quotes
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
    rows.push(obj as unknown as LegCsv);
  }
  return rows;
}

function segmentKeyOf(row: LegCsv): SegmentKey {
  return `${row.from_station}__${row.to_station}`;
}

function toNumberOrNull(s: string): number | null {
  const n = Number(s);
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

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const aDir = String(args.a ?? args.A ?? "");
  const bDir = String(args.b ?? args.B ?? "");
  const noGui = Boolean(args["no-gui"] || args["nogui"]);
  if (!aDir || !bDir) {
    console.error("Usage: bun run analyze.ts --a=PATH_TO_RUN_A --b=PATH_TO_RUN_B");
    console.error("Both paths must contain legs.csv");
    process.exit(2);
  }

  const legsAPath = path.join(aDir, "legs.csv");
  const legsBPath = path.join(bDir, "legs.csv");

  const [rowsA, rowsB] = await Promise.all([
    readCsvRows(legsAPath),
    readCsvRows(legsBPath),
  ]);

  const aggA = new Map<SegmentKey, Stats>();
  const aggB = new Map<SegmentKey, Stats>();

  for (const r of rowsA) {
    const key = segmentKeyOf(r);
    const st = aggA.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
    pushStat(st, toNumberOrNull(r.leg_minutes));
    aggA.set(key, st);
  }
  for (const r of rowsB) {
    const key = segmentKeyOf(r);
    const st = aggB.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
    pushStat(st, toNumberOrNull(r.leg_minutes));
    aggB.set(key, st);
  }

  const allKeys = new Set<SegmentKey>([...aggA.keys(), ...aggB.keys()]);

  const csv = new SimpleCsvService();
  const outRows: Record<string, string | number | boolean | null | undefined>[] = [];
  const segmentsNumeric: { from: string | undefined; to: string | undefined; aAvg: number | null; bAvg: number | null; diff: number | null; }[] = [];
  for (const key of allKeys) {
    const [from_station, to_station] = key.split("__");
    const a = aggA.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
    const b = aggB.get(key) ?? { count: 0, min: null, max: null, sum: 0 };
    const aAvg = a.count > 0 ? a.sum / a.count : null;
    const bAvg = b.count > 0 ? b.sum / b.count : null;
    const diffAvg = (aAvg != null && bAvg != null) ? (bAvg - aAvg) : null;
    segmentsNumeric.push({ from: from_station, to: to_station, aAvg, bAvg, diff: diffAvg });
    outRows.push({
      from_station,
      to_station,
      a_count: a.count,
      a_min: a.min,
      a_max: a.max,
      a_avg: aAvg?.toFixed(2) ?? "",
      b_count: b.count,
      b_min: b.min,
      b_max: b.max,
      b_avg: bAvg?.toFixed(2) ?? "",
      diff_avg: diffAvg != null ? diffAvg.toFixed(2) : "",
    });
  }

  const outBase = path.resolve("out");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(outBase, `compare-${timestamp}`);
  await fs.mkdir(outDir as unknown as import("node:fs").PathLike, { recursive: true });
  const outPath = path.join(outDir, "diff.csv");
  await fs.writeFile(outPath, csv.toCSV(outRows, [
    "from_station","to_station",
    "a_count","a_min","a_max","a_avg",
    "b_count","b_min","b_max","b_avg",
    "diff_avg"
  ]));

  // Visualization: Top 30 segments by |diff|
  const validSegs = segmentsNumeric.filter(s => s.diff != null) as { from: string; to: string; aAvg: number; bAvg: number; diff: number; }[];
  const top = validSegs
    .slice()
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
    .slice(0, 30);
  const labels = top.map(s => `${s.from} → ${s.to}`);
  const diffs = top.map(s => s.diff);
  const aBars = top.map(s => s.aAvg);
  const bBars = top.map(s => s.bAvg);

  const traceDiff: Plot = {
    x: labels,
    y: diffs,
    type: "bar",
    name: "Δ avg (B - A)",
    marker: { color: diffs.map(v => v >= 0 ? "crimson" : "seagreen") as unknown as string },
  } as unknown as Plot;
  const traceA: Plot = { x: labels, y: aBars, type: "bar", name: "A avg (menit)", marker: { color: "steelblue" } } as unknown as Plot;
  const traceB: Plot = { x: labels, y: bBars, type: "bar", name: "B avg (menit)", marker: { color: "orange" } } as unknown as Plot;

  const layoutTop = {
    title: "Top 30 Segmen: Perubahan Rata-rata Durasi (menit)",
    barmode: "group",
    xaxis: { tickangle: -45, automargin: true },
    yaxis: { title: "menit" },
    legend: { orientation: "h" }
  } as const;

  // Histogram of all diffs
  const allDiffs = validSegs.map(s => s.diff);
  const traceHist: Plot = { x: allDiffs, type: "histogram", nbinsx: 30, name: "Δ avg distribusi" } as unknown as Plot;
  const layoutHist = { title: "Distribusi Δ rata-rata (B - A) menit", xaxis: { title: "Δ menit" }, yaxis: { title: "freq" } } as const;

  // Save HTML report with Plotly
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KRL Diff Report</title>
  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",sans-serif;padding:16px} .chart{width:100%;height:600px;margin:24px 0}</style>
</head>
<body>
  <h1>KRL Diff Report</h1>
  <p>A: ${aDir}<br/>B: ${bDir}</p>
  <h2>Top 30 Segmen: Perubahan Rata-rata Durasi</h2>
  <div id="top" class="chart"></div>
  <h2>Distribusi Δ rata-rata (B - A)</h2>
  <div id="hist" class="chart"></div>
  <script>
    const labels = ${JSON.stringify(labels)};
    const diffs = ${JSON.stringify(diffs)};
    const aBars = ${JSON.stringify(aBars)};
    const bBars = ${JSON.stringify(bBars)};
    const allDiffs = ${JSON.stringify(allDiffs)};
    const traceDiff = { x: labels, y: diffs, type: 'bar', name: 'Δ avg (B - A)', marker: { color: diffs.map(v => v >= 0 ? 'crimson' : 'seagreen') } };
    const traceA = { x: labels, y: aBars, type: 'bar', name: 'A avg (menit)', marker: { color: 'steelblue' } };
    const traceB = { x: labels, y: bBars, type: 'bar', name: 'B avg (menit)', marker: { color: 'orange' } };
    Plotly.newPlot('top', [traceA, traceB, traceDiff], { title:'Top 30 Segmen: Perubahan Rata-rata Durasi (menit)', barmode:'group', xaxis:{tickangle:-45, automargin:true}, yaxis:{title:'menit'}, legend:{orientation:'h'} }, {responsive:true});
    const traceHist = { x: allDiffs, type: 'histogram', nbinsx: 30, name: 'Δ avg distribusi' };
    Plotly.newPlot('hist', [traceHist], { title:'Distribusi Δ rata-rata (B - A) menit', xaxis:{title:'Δ menit'}, yaxis:{title:'freq'} }, {responsive:true});
  </script>
  <p>CSV diff: ${path.basename(outPath)}</p>
  <p>Dibuat: ${new Date().toLocaleString()}</p>
</body>
</html>`;
  await fs.writeFile(path.join(outDir, "report.html"), html);

  if (!noGui) {
    // Render interactive windows
    plot([traceA, traceB, traceDiff], layoutTop as unknown as Partial<any>);
    plot([traceHist], layoutHist as unknown as Partial<any>);
  }

  console.log(`Selesai. Diff ditulis ke: ${outPath}`);
  console.log(`Report HTML: ${path.join(outDir, "report.html")}`);
}

main(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});



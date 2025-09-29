import fs from "node:fs/promises";
import path from "node:path";

type AnyCsv = Record<string, string>;

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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const pairs = argv.slice(2).map((p) => {
    const [k, v] = p.replace(/^--/, "").split("=");
    return [k, (v as string | undefined) ?? true] as const;
  });
  return Object.fromEntries(pairs) as Record<string, string | boolean>;
}

function usage(): void {
  console.error("Usage:");
  console.error("  bun run through.ts --a=DIR_A --b=DIR_B --via=Palmerah --to=Rangkasbitung");
  console.error("  bun run through.ts --pre=DIR_PRE --post=DIR_POST --via=Palmerah --to=Rangkasbitung");
  console.error("");
  console.error("Argumen:");
  console.error("  --via             Stasiun awal (mis. Palmerah)");
  console.error("  --to              Destinasi akhir (mis. Rangkasbitung)");
  console.error("  --a, --b          Dua folder hasil scrape (punya stops.csv, trains.csv)");
  console.error("  --pre, --post     Dataset spesifik untuk transfer: PRE untuk VIA→Tanah Abang (mis. Rangkasbitung), POST untuk Tanah Abang→DEST (mis. Tanah Abang)");
  console.error("                     Wajib pilih kombinasi: (a & b) ATAU (pre & post)");
  console.error("");
  console.error("Perilaku:");
  console.error("  1) Cek kereta tembus (train_id sama) dari VIA→Tanah Abang dan lanjut ke DEST menggunakan gabungan dataset.");
  console.error("  2) Jika tidak ada tembus, cari opsi transfer: pasangkan kedatangan VIA→Tanah Abang (dari PRE) dengan keberangkatan Tanah Abang→DEST (dari POST)");
  console.error("     dengan waktu tunggu minimal. Pairing mendukung lintas tengah malam (wrap-around ke hari berikutnya).");
  console.error("");
  console.error("Opsi:");
  console.error("  --order=depart    Urutan output: depart|wait (default: depart)");
  console.error("  --desc            Urutan menurun (descending)");
  console.error("  --maxwait=30      Batas tunggu maksimum di Tanah Abang (menit) untuk opsi transfer");
  console.error("  --limit=0         Batasi jumlah baris output (0=tanpa batas; default: 0)");
  console.error("");
  console.error("Contoh:");
  console.error("  bun run through.ts --pre=out/RK-00-00-23-00 --post=out/THB-00-00-23-00 --via=Palmerah --to=Rangkasbitung --order=depart");
  console.error("  bun run through.ts --a=out/THB-00-00-23-00 --b=out/RK-00-00-23-00 --via=Palmerah --to=Rangkasbitung --order=wait --maxwait=120");
}

async function loadStops(dir: string): Promise<AnyCsv[]> {
  const p = path.join(dir, "stops.csv");
  return readCsv(p);
}

async function loadTrains(dir: string): Promise<Map<string, { dest?: string; ka_name?: string; route_name?: string }>> {
  const p = path.join(dir, "trains.csv");
  const map = new Map<string, { dest?: string; ka_name?: string; route_name?: string }>();
  try {
    const rows = await readCsv(p);
    for (const r of rows) {
      if (!r["train_id"]) continue;
      map.set(r["train_id"], { dest: r["dest"], ka_name: r["ka_name"], route_name: r["route_name"] });
    }
  } catch {
    // ignore if missing
  }
  return map;
}

type ThroughResult = {
  train_id: string;
  ka_name?: string;
  route_name?: string;
  depart_via_time?: string;
  via_index?: number;
  continues_to_dest: boolean;
};

function findThrough(stops: AnyCsv[], trains: Map<string, { dest?: string; ka_name?: string; route_name?: string }>, via: string, dest: string): ThroughResult[] {
  const byTrain = new Map<string, AnyCsv[]>();
  for (const r of stops) {
    const tid = r["train_id"] ?? "";
    if (!byTrain.has(tid)) byTrain.set(tid, []);
    byTrain.get(tid)!.push(r);
  }
  const res: ThroughResult[] = [];
  for (const [tid, arr] of byTrain) {
    arr.sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
    const viaIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === via.toLowerCase());
    if (viaIdx < 0) continue;
    const taIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang".toLowerCase());
    if (taIdx < 0) continue; // must pass Tanah Abang
    if (!(viaIdx < taIdx)) continue; // ensure order via -> Tanah Abang

    // Does this train continue to desired dest after Tanah Abang?
    const destIdx = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === dest.toLowerCase());
    const continues = destIdx > taIdx; // must appear after Tanah Abang

    if (!continues) continue;
    const meta = trains.get(tid) || {};
    res.push({
      train_id: tid,
      ka_name: meta.ka_name,
      route_name: meta.route_name,
      depart_via_time: arr[viaIdx]?.["time_est"],
      via_index: Number(arr[viaIdx]?.["stop_index"]) || viaIdx,
      continues_to_dest: true
    });
  }
  // default order by departure time (HH:MM:SS)
  res.sort((a, b) => String(a.depart_via_time).localeCompare(String(b.depart_via_time)));
  return res;
}

function hmsToMin(hms: string | undefined): number | null {
  if (!hms) return null;
  const [hStr, mStr, sStr = "0"] = hms.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const s = Number(sStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m + (Number.isNaN(s) ? 0 : Math.floor(s / 60));
}

type PairResult = {
  from_train_id: string;
  to_train_id: string;
  depart_via_time: string;      // from train at VIA
  arrive_ta_time: string;        // arrival at Tanah Abang (from train)
  depart_ta_time: string;        // departure at Tanah Abang (to train)
  arrive_dest_time?: string;     // arrival at destination (to train)
  wait_min: number;              // min wait at TA
  meta_from?: { ka_name?: string; route_name?: string };
  meta_to?: { ka_name?: string; route_name?: string };
};

function buildTransferPairs(
  stopsPre: AnyCsv[],
  stopsPost: AnyCsv[],
  trains: Map<string, { dest?: string; ka_name?: string; route_name?: string }>,
  via: string,
  dest: string,
  maxWaitMin: number | null
): PairResult[] {
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
    const idxTA = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang".toLowerCase());
    const meta = trains.get(tid);
    if (idxVia >= 0 && idxTA > idxVia) {
      const departVia = arr[idxVia]!["time_est"];
      const arriveTA = arr[idxTA]!["time_est"];
      const departViaMin = Number(arr[idxVia]!["time_est_min"]) || hmsToMin(departVia);
      const arriveTAMin = Number(arr[idxTA]!["time_est_min"]) || hmsToMin(arriveTA);
      if (departVia && arriveTA && departViaMin != null && arriveTAMin != null) {
        legAs.push({ trainId: tid, departVia, arriveTA, departViaMin, arriveTAMin, meta: meta ? { ka_name: meta.ka_name, route_name: meta.route_name } : undefined });
      }
    }
  }

  for (const [tid, arr0] of byTrainPost) {
    const arr = arr0.slice().sort((a, b) => (Number(a["stop_index"]) || 0) - (Number(b["stop_index"]) || 0));
    const idxTA = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === "tanah abang".toLowerCase());
    const idxDest = arr.findIndex(r => (r["station_name"] ?? "").toLowerCase() === dest.toLowerCase());
    const meta = trains.get(tid);
    if (idxTA >= 0 && idxDest > idxTA) {
      const departTA = arr[idxTA]!["time_est"];
      const arriveDest = arr[idxDest]!["time_est"];
      const departTAMin = Number(arr[idxTA]!["time_est_min"]) || hmsToMin(departTA);
      const arriveDestMin = Number(arr[idxDest]!["time_est_min"]) || hmsToMin(arriveDest);
      if (departTA && departTAMin != null) {
        legBs.push({ trainId: tid, departTA, arriveDest, departTAMin, arriveDestMin: arriveDestMin ?? null, meta: meta ? { ka_name: meta.ka_name, route_name: meta.route_name } : undefined });
      }
    }
  }

  // Index B by departTAMin for quick nearest search
  legBs.sort((a, b) => a.departTAMin - b.departTAMin);

  function waitDiffMin(arrive: number, depart: number): number {
    let d = depart - arrive;
    if (d < 0) d += 24 * 60;
    return d;
  }

  const pairs: PairResult[] = [];
  for (const a of legAs) {
    // binary search nearest depart >= arrive
    let lo = 0, hi = legBs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (legBs[mid]!.departTAMin < a.arriveTAMin) lo = mid + 1; else hi = mid;
    }
    const candidates: LegB[] = [];
    const addCand = (b: LegB | undefined) => { if (b && !candidates.includes(b)) candidates.push(b); };
    addCand(legBs[lo]);
    addCand(legBs[lo + 1]);
    // Consider wrap-around to next day: earliest departure after midnight
    addCand(legBs[0]);

    let best: { b: LegB; wait: number } | null = null;
    for (const b of candidates) {
      const wait = waitDiffMin(a.arriveTAMin, b.departTAMin);
      if (maxWaitMin != null && wait > maxWaitMin) continue;
      if (!best || wait < best.wait) best = { b, wait };
    }
    if (best) {
      pairs.push({
        from_train_id: a.trainId,
        to_train_id: best.b.trainId,
        depart_via_time: a.departVia,
        arrive_ta_time: a.arriveTA,
        depart_ta_time: best.b.departTA,
        arrive_dest_time: best.b.arriveDest,
        wait_min: best.wait,
        meta_from: a.meta,
        meta_to: best.b.meta
      });
    }
  }

  pairs.sort((x, y) => x.wait_min - y.wait_min || String(x.depart_via_time).localeCompare(String(y.depart_via_time)));
  return pairs;
}

async function main(argv: string[]): Promise<void> {
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
    // Need either both a+b or both pre+post
    usage();
    process.exit(2);
  }

  const srcPre = preDir || aDir;
  const srcPost = postDir || bDir;

  const [stopsPre, stopsPost, trainsPre, trainsPost] = await Promise.all([
    loadStops(srcPre),
    loadStops(srcPost),
    loadTrains(srcPre),
    loadTrains(srcPost)
  ]);
  const stops = stopsPre.concat(stopsPost);
  const trains = new Map<string, { dest?: string; ka_name?: string; route_name?: string }>([...trainsPre, ...trainsPost]);

  const results = findThrough(stops, trains, via, dest);
  if (orderArg === "depart") {
    results.sort((a, b) => String(a.depart_via_time).localeCompare(String(b.depart_via_time)) * (isDesc ? -1 : 1));
  }
  if (results.length === 0) {
    const maxWaitArg = args.maxwait ?? args.maxWait ?? args.wait;
    const maxWaitMin = typeof maxWaitArg === "string" && maxWaitArg.length > 0 ? Number(maxWaitArg) : null;
    const pairs = buildTransferPairs(stopsPre, stopsPost, trains, via, dest, Number.isFinite(maxWaitMin as number) ? Number(maxWaitMin) : null);
    if (orderArg === "depart") {
      pairs.sort((x, y) => String(x.depart_via_time).localeCompare(String(y.depart_via_time)) * (isDesc ? -1 : 1));
    } else if (orderArg === "wait") {
      pairs.sort((x, y) => (x.wait_min - y.wait_min) * (isDesc ? -1 : 1));
    }
    if (pairs.length === 0) {
      console.log(`Tidak ada kereta tembus DAN tidak menemukan pasangan transfer yang cocok dari '${via}' → 'Tanah Abang' → '${dest}'.`);
      process.exit(0);
    }
    console.log(`Tidak ada tembus. Rekomendasi transfer ${maxWaitMin != null ? `(<= ${maxWaitMin} menit)` : ""}${orderArg ? ` | diurutkan berdasar ${orderArg}${isDesc ? " desc" : ""}` : ""}:`);
    const outPairs = limitNum > 0 ? pairs.slice(0, limitNum) : pairs;
    for (const p of outPairs) {
      const fromMeta = [p.meta_from?.ka_name, p.meta_from?.route_name].filter(Boolean).join(" - ");
      const toMeta = [p.meta_to?.ka_name, p.meta_to?.route_name].filter(Boolean).join(" - ");
      console.log(`- VIA ${via} ${p.depart_via_time} [${p.from_train_id}${fromMeta ? ` | ${fromMeta}` : ""}] → TA ${p.arrive_ta_time} | ganti | TA ${p.depart_ta_time} [${p.to_train_id}${toMeta ? ` | ${toMeta}` : ""}] → ${dest} ${p.arrive_dest_time ?? "??:??"} | tunggu ~${p.wait_min}m`);
    }
    process.exit(0);
  }

  console.log(`Kereta tembus dari ${via} → Tanah Abang → ${dest}${orderArg ? ` | diurutkan berdasar ${orderArg}${isDesc ? " desc" : ""}` : ""}:`);
  const outThrough = limitNum > 0 ? results.slice(0, limitNum) : results;
  for (const r of outThrough) {
    const name = [r.ka_name, r.route_name].filter(Boolean).join(" - ");
    console.log(`- ${r.depart_via_time ?? "??:??"} | ${r.train_id}${name ? " | " + name : ""}`);
  }
}

main(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});


